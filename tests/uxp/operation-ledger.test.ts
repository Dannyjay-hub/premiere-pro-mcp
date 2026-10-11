import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const Ledger = require("../../uxp-plugin/operation-ledger.cjs");
const Commands = require("../../uxp-plugin/commands.cjs");
const Protocol = require("../../uxp-plugin/protocol.cjs");
const digest = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");
const identity = { projectGuid: "project-1", sequenceGuid: "sequence-1" };
function stored() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => values.set(key, value) };
}
function ledger(storage?: ReturnType<typeof stored>) { return Ledger.createOperationLedger({ storage, sessionId: "session-1", digest }); }
function host(storage?: ReturnType<typeof stored>) {
  const sequence = { guid: "sequence-1", getVideoTrackCount: async () => 0, getAudioTrackCount: async () => 0, getVideoTrack: vi.fn(), getAudioTrack: vi.fn() };
  const project = { guid: "project-1", getActiveSequence: async () => sequence };
  const mutation = vi.fn(async (args: { value?: number }) => ({ value: args.value, outcome: "verified" }));
  const registry = Commands.createCommandRegistry({ ppro: { Project: { getActiveProject: async () => project } }, Protocol, storage, Workflows: { createWorkflowDefinitions: () => ({ "test.mutate": { handler: mutation } }) } });
  return { registry, project, sequence, mutation };
}
describe("canonical operation binding and durable consumed receipts", () => {
  it("canonicalizes nested objects without depending on property order", () => {
    expect(Ledger.canonical({ b: [{ z: 1, a: "x" }], a: true })).toBe(Ledger.canonical({ a: true, b: [{ a: "x", z: 1 }] }));
    expect(Ledger.canonical({ missing: undefined, present: null })).toBe('{"present":null}');
    expect(() => Ledger.canonical({ value: NaN })).toThrow(/finite JSON/);
    expect(() => Ledger.canonical(Symbol("bad"))).toThrow(/finite JSON/);
    let nested: unknown = null; for (let index = 0; index < 34; index++) nested = [nested];
    expect(() => Ledger.canonical(nested)).toThrow(/depth/);
  });
  it("binds arguments, command, project, sequence and panel session", () => {
    const value = ledger();
    const binding = value.bind("test.mutate", { value: 1 }, identity);
    value.reserve("id-1", binding, identity);
    for (const changed of [value.bind("test.other", { value: 1 }, identity), value.bind("test.mutate", { value: 2 }, identity), value.bind("test.mutate", { value: 1 }, { ...identity, projectGuid: "project-2" }), value.bind("test.mutate", { value: 1 }, { ...identity, sequenceGuid: "sequence-2" })]) expect(() => value.get("id-1", changed)).toThrow(/bound/);
    expect(value.get("id-1", binding)).toMatchObject({ outcome: "pending" });
    expect(ledger().bind("test.mutate", { value: 1 }, identity)).toBe(binding);
    const otherSession = Ledger.createOperationLedger({ sessionId: "session-2", digest });
    expect(otherSession.bind("test.mutate", { value: 1 }, identity)).not.toBe(binding);
  });
  it("persists only digests and operation metadata, with pending outcomes unknown after reload", () => {
    const storage = stored(), first = ledger(storage);
    const binding = first.bind("test.mutate", { name: "private-media.mov", path: "/private/project" }, identity);
    first.reserve("operation-1", binding, identity);
    const raw = storage.values.get(Ledger.STORAGE_KEY)!;
    expect(raw).not.toContain("private-media"); expect(raw).not.toContain("/private"); expect(raw).not.toContain("project-1");
    const restored = ledger(storage);
    expect(restored.get("operation-1", binding)).toMatchObject({ outcome: "unknown" });
    expect(() => restored.assertReady(identity)).toThrow(/unknown outcome/);
    expect(() => restored.assertReady({ ...identity, projectGuid: "unrelated" })).not.toThrow();
  });
  it("requires the exact inspected ledger, host identity and IDs before consuming reviewed recovery", () => {
    const value = ledger(), binding = value.bind("test.mutate", {}, identity);
    value.reserve("uncertain", binding, identity); value.unknown("uncertain");
    const snapshot = value.inspect({ ...identity, hostStateRevision: "host-before" });
    const args = { reviewed: true, expectedRecoveryRevision: snapshot.recoveryRevision, expectedIdentityRevision: snapshot.identityRevision, operationIds: ["uncertain"] };
    for (const changed of [{ ...args, reviewed: false }, { ...args, operationIds: [] }, { ...args, expectedRecoveryRevision: "stale" }]) expect(() => value.acknowledge({ ...identity, hostStateRevision: "host-before" }, changed)).toThrow(/latest inspected/);
    expect(() => value.acknowledge({ ...identity, hostStateRevision: "host-after" }, args)).toThrow(/latest inspected/);
    expect(value.acknowledge({ ...identity, hostStateRevision: "host-before" }, args)).toMatchObject({ replayAuthorized: false });
    expect(value.get("uncertain", binding)).toMatchObject({ outcome: "consumed" });
    expect(() => value.assertReady(identity)).not.toThrow();
  });
  it("refuses corrupt, oversized and unavailable persistent stores", () => {
    const storage = stored(); storage.setItem(Ledger.STORAGE_KEY, "{broken");
    expect(() => ledger(storage).assertReady(identity)).toThrow(/unknown outcome/);
    expect(() => ledger(storage).reserve("x", digest("x"), identity)).toThrow(/cannot be validated/);
    storage.setItem(Ledger.STORAGE_KEY, "x".repeat(1024 * 1024 + 1));
    expect(ledger(storage).inspect(identity)).toMatchObject({ ledgerCorrupt: true });
    const unavailable = Ledger.createOperationLedger({ digest, storage: { getItem: () => null, setItem: () => { throw new Error("quota"); } } });
    expect(() => unavailable.reserve("x", digest("x"), identity)).toThrow(/no new host mutation/);
    expect(unavailable.get("x", digest("x"))).toBeNull();
  });
  it("keeps consumed tombstones until its explicit bounded capacity", () => {
    const value = ledger();
    for (let index = 0; index < Ledger.MAX_OPERATIONS; index++) { value.reserve("id-" + index, digest(String(index)), identity); value.finish("id-" + index, "verified"); }
    expect(() => value.reserve("overflow", digest("overflow"), identity)).toThrow(/cannot be silently evicted/);
    expect(value.get("id-0", digest("0"))).toMatchObject({ outcome: "verified" });
  });
  it("refreshes durable bindings across separate panel contexts without overwriting consumed IDs", () => {
    const storage = stored(), first = ledger(storage), second = ledger(storage);
    const binding = first.bind("test.mutate", { value: 1 }, identity);
    first.reserve("shared-id", binding, identity); first.finish("shared-id", "verified");
    expect(second.get("shared-id", binding)).toMatchObject({ outcome: "verified" });
    expect(() => second.reserve("shared-id", binding, identity)).toThrow(/already reserved/);
    const next = second.bind("test.mutate", { value: 2 }, identity);
    second.reserve("another", next, identity); second.finish("another", "verified");
    expect(first.get("another", next)).toMatchObject({ outcome: "verified" });
    expect(first.get("shared-id", binding)).toMatchObject({ outcome: "verified" });
    storage.values.clear(); expect(() => first.assertReady(identity)).toThrow(/unknown outcome/);
  });
  it("disables production mutations when persistent panel storage is unavailable", () => {
    const value = Ledger.createOperationLedger({ digest, requireDurability: true });
    expect(value.durable).toBe(false);
    expect(() => value.reserve("unsupported", digest("unsupported"), identity)).toThrow(/Persistent operation storage is unavailable/);
  });
});
describe("registry transport fault behavior", () => {
  it("keeps a write followed by a typed validation error unknown and consumed", async () => {
    const value = host(); let nativeWrites = 0;
    value.mutation.mockImplementationOnce(async () => {
      nativeWrites++;
      throw Object.assign(new Error("typed error after host write"), { code: "UXP_INVALID_ARGUMENT" });
    });
    await expect(value.registry.dispatch("test.mutate", { operationId: "write-then-error" })).rejects.toMatchObject({ code: "UXP_INVALID_ARGUMENT" });
    await expect(value.registry.dispatch("test.mutate", { operationId: "write-then-error" })).rejects.toMatchObject({ code: "UXP_OPERATION_CONSUMED" });
    await expect(value.registry.dispatch("test.mutate", { operationId: "dependent" })).rejects.toMatchObject({ code: "UXP_RECOVERY_REQUIRED", noHostDispatch: true, dispatchEvidence: "panel_pre_dispatch" });
    expect(nativeWrites).toBe(1);
  });
  it("rejects changed arguments and concurrent IDs without a second mutation", async () => {
    const value = host(); let release = () => {};
    value.mutation.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { value: 1, outcome: "verified" }; });
    const first = value.registry.dispatch("test.mutate", { operationId: "same", value: 1 });
    await vi.waitFor(() => expect(value.mutation).toHaveBeenCalledOnce());
    await expect(value.registry.dispatch("test.mutate", { operationId: "same", value: 2 })).rejects.toMatchObject({ code: "UXP_OPERATION_CONFLICT" });
    const duplicate = value.registry.dispatch("test.mutate", { value: 1, operationId: "same" }); release();
    await expect(first).resolves.toMatchObject({ value: 1 }); await expect(duplicate).resolves.toMatchObject({ replayed: true });
    expect(value.mutation).toHaveBeenCalledOnce();
    value.sequence.guid = "different";
    await expect(value.registry.dispatch("test.mutate", { operationId: "same", value: 1 })).rejects.toMatchObject({ code: "UXP_OPERATION_CONFLICT" });
  });
  it("survives post-write throws, panel reload, reconciliation and result-cache expiry", async () => {
    const storage = stored(), first = host(storage);
    first.mutation.mockRejectedValueOnce(new Error("host wrote, reply lost"));
    await expect(first.registry.dispatch("test.mutate", { operationId: "uncertain", value: 1 })).rejects.toThrow(/reply lost/);
    const restored = host(storage);
    await expect(restored.registry.dispatch("test.mutate", { operationId: "uncertain", value: 1 })).rejects.toMatchObject({ code: "UXP_OPERATION_CONSUMED" });
    await expect(restored.registry.dispatch("test.mutate", { operationId: "new", value: 2 })).rejects.toMatchObject({ code: "UXP_RECOVERY_REQUIRED" });
    const inspection = await restored.registry.dispatch("operations.recovery.inspect", {});
    await restored.registry.dispatch("operations.recovery.acknowledge", { expectedRecoveryRevision: inspection.recoveryRevision, expectedIdentityRevision: inspection.identityRevision, operationIds: inspection.operations.map((item: { id: string }) => item.id), reviewed: true });
    await restored.registry.dispatch("test.mutate", { operationId: "new", value: 2 });
    for (let index = 0; index < 256; index++) await restored.registry.dispatch("test.mutate", { operationId: "cache-" + index, value: index });
    await expect(restored.registry.dispatch("test.mutate", { operationId: "new", value: 2 })).rejects.toMatchObject({ code: "UXP_OPERATION_CONSUMED" });
    expect(restored.mutation).toHaveBeenCalledTimes(257);
  });
  it("fails incompatible command and receipt schemas before dispatch", () => {
    for (const field of ["commandSchemaVersion", "receiptVersion"]) expect(() => Protocol.parseCommand({ protocolVersion: 2, type: "command", command: "test.mutate", [field]: 99 })).toThrow(/matching MCP panel/);
    expect(Protocol.parseCommand({ protocolVersion: 2, type: "command", command: "test.mutate", commandSchemaVersion: 1, receiptVersion: 1 }).command).toBe("test.mutate");
  });
});
