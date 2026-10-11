import { once } from "node:events";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UxpWebSocketBridge } from "../../src/bridge/uxp-websocket-bridge.js";
import { sendCommand } from "../../src/bridge/file-bridge.js";
import { currentInvocation, withInvocationContext } from "../../src/workflows/invocation-context.js";
const active: UxpWebSocketBridge[] = [];
const directories: string[] = [];
afterEach(async () => { await Promise.all(active.splice(0).map((bridge) => bridge.stop())); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
async function connected(schema: number | null = 1, receipt: number | null = 1, replayPersistence = "durable_hashed_tombstones") {
  const token = "fault-test-token-at-least-sixteen";
  const tempDir = mkdtempSync(join(tmpdir(), "uxp-fault-lease-")); directories.push(tempDir);
  const bridge = new UxpWebSocketBridge({ token, port: 0, requestTimeoutMs: 30, tempDir }); active.push(bridge); await bridge.start();
  const address = bridge.address(), client = new WebSocket(`ws://${address.host}:${address.port}${address.path}?token=${token}`);
  await once(client, "open"); const ready = once(bridge, "connected");
  client.send(JSON.stringify({ protocolVersion: 2, type: "hello", payload: { backend: "uxp", protocolVersion: 2, ...(schema === null ? {} : { commandSchemaVersion: schema }), ...(receipt === null ? {} : { receiptVersion: receipt }), replayPersistence, commands: { "test.mutate": { supported: true, readOnly: false }, "state.get": { supported: true, readOnly: true } } } }));
  await ready; return { bridge, client, tempDir };
}
describe("UXP lost-reply and compatibility boundaries", () => {
  it("never resends a timed-out mutation and blocks subsequent writes while allowing inspection", async () => {
    const { bridge, client } = await connected(); const frames: { requestId: string; command: string }[] = [];
    client.on("message", (raw) => { const frame = JSON.parse(raw.toString()); frames.push(frame); if (frame.command === "state.get") client.send(JSON.stringify({ protocolVersion: 2, type: "result", requestId: frame.requestId, payload: { ok: true, result: { inspected: true } } })); });
    await expect(bridge.request("test.mutate", { operationId: "lost-reply" })).rejects.toMatchObject({ code: "UXP_TIMEOUT" });
    await expect(bridge.request("test.mutate", { operationId: "later" })).rejects.toMatchObject({ code: "UXP_RECOVERY_REQUIRED" });
    await expect(bridge.request("state.get")).resolves.toMatchObject({ inspected: true });
    expect(frames.filter((frame) => frame.command === "test.mutate")).toHaveLength(1);
    const state = bridge.getOperationRecovery(); expect(state.recoveryRequired).toBe(true);
    expect(() => bridge.acknowledgeOperationRecovery("stale", true)).toThrow(/changed/);
    expect(() => bridge.acknowledgeOperationRecovery(state.recoveryRevision, false)).toThrow(/changed/);
    // A late success belongs only to its original request and cannot clear recovery.
    client.send(JSON.stringify({ protocolVersion: 2, type: "result", requestId: frames[0].requestId, payload: { ok: true, result: { done: true } } }));
    await new Promise((resolve) => setTimeout(resolve, 10)); expect(bridge.getOperationRecovery().recoveryRequired).toBe(true);
    bridge.acknowledgeOperationRecovery(state.recoveryRevision, true); expect(bridge.getOperationRecovery().recoveryRequired).toBe(false);
    client.close();
  });
  it("fails known-incompatible command/receipt schemas before sending an edit", async () => {
    for (const [schema, receipt] of [[2, 1], [1, 2]]) {
      const { bridge, client } = await connected(schema, receipt); let sent = false; client.on("message", () => { sent = true; });
      await expect(bridge.request("test.mutate")).rejects.toMatchObject({ code: "UXP_SCHEMA_INCOMPATIBLE" });
      expect(sent).toBe(false); client.close();
    }
  });
  it.each([[null, null, "memory_only", "UXP_SCHEMA_INCOMPATIBLE"], [1, 1, "memory_only", "UXP_REPLAY_UNAVAILABLE"]] as const)("keeps legacy or nondurable panel reads available while refusing writes (%s/%s/%s)", async (schema, receipt, persistence, code) => {
    const { bridge, client } = await connected(schema, receipt, persistence);
    const sent: string[] = [];
    client.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()); sent.push(frame.command);
      client.send(JSON.stringify({ protocolVersion: 2, type: "result", requestId: frame.requestId, payload: { ok: true, result: { inspected: true } } }));
    });
    await expect(bridge.request("state.get")).resolves.toMatchObject({ inspected: true });
    await expect(bridge.request("test.mutate")).rejects.toMatchObject({ code });
    expect(sent).toEqual(["state.get"]);
    expect(bridge.getOperationRecovery().recoveryRequired).toBe(false);
  });
  it("treats disconnect after dispatch as unknown and preserves it across reconnection", async () => {
    const { bridge, client } = await connected(); client.once("message", () => client.close());
    await expect(bridge.request("test.mutate")).rejects.toMatchObject({ code: "UXP_DISCONNECTED" });
    expect(bridge.getOperationRecovery()).toMatchObject({ recoveryRequired: true, operations: [expect.objectContaining({ command: "test.mutate" })] });
  });
  it("records socket dispatch and response stages in the invoking context without marking read-only preflight as a mutation", async () => {
    const { bridge, client } = await connected();
    client.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      client.send(JSON.stringify({ protocolVersion: 2, type: "result", requestId: frame.requestId, payload: { ok: true, result: { outcome: "verified" } } }));
    });
    await withInvocationContext({}, async () => {
      await bridge.request("state.get");
      expect(currentInvocation()?.dispatched).toBe(false);
      await bridge.request("test.mutate");
      expect(currentInvocation()?.dispatched).toBe(true);
      expect(currentInvocation()?.stages).toMatchObject({ queue_wait: expect.any(Number), dispatch: expect.any(Number), host_wait: expect.any(Number), readback: expect.any(Number) });
    });
  });
  it("shares a lost UXP outcome with CEP and refuses a second backend write before publishing a command", async () => {
    const { bridge, tempDir } = await connected();
    await expect(bridge.request("test.mutate")).rejects.toMatchObject({ code: "UXP_TIMEOUT" });
    await expect(sendCommand("var attempted = true;", { tempDir, mutating: true })).resolves.toMatchObject({ success: false, data: { recoveryRequired: true, mutationOutcome: "not_applied" }, error: expect.stringContaining("HOST_RECOVERY_REQUIRED") });
    expect(readdirSync(tempDir).some((name) => name.startsWith("cmd_"))).toBe(false);
  });
  it.each([true, false])("requires explicit panel nondispatch evidence despite a typed argument error (%s)", async (proven) => {
    const { bridge, client } = await connected();
    client.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      client.send(JSON.stringify({ protocolVersion: 2, type: "result", requestId: frame.requestId, payload: { ok: false, error: { code: "UXP_INVALID_ARGUMENT", message: "bounded test refusal", ...(proven ? { noHostDispatch: true, dispatchEvidence: "panel_pre_dispatch" } : {}) } } }));
    });
    await expect(bridge.request("test.mutate")).rejects.toMatchObject({ code: "UXP_INVALID_ARGUMENT" });
    expect(bridge.getOperationRecovery().recoveryRequired).toBe(!proven);
  });
  it("keeps synchronous socket send failure unknown and consumes its request once", async () => {
    const { bridge } = await connected();
    const socket = (bridge as unknown as { socket: WebSocket }).socket;
    const send = vi.spyOn(socket, "send").mockImplementationOnce(() => { throw new Error("socket write failed"); });
    await expect(bridge.request("test.mutate")).rejects.toMatchObject({ code: "UXP_SEND_FAILED" });
    expect(bridge.getOperationRecovery().operations).toHaveLength(1);
    send.mockRestore();
  });
  it("persists an explicit unknown result despite its successful transport envelope", async () => {
    const { bridge, client, tempDir } = await connected();
    client.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      client.send(JSON.stringify({ protocolVersion: 2, type: "result", requestId: frame.requestId, payload: { ok: true, result: { outcome: "unknown", recoveryRequired: true } } }));
    });
    await expect(bridge.request("test.mutate")).resolves.toMatchObject({ outcome: "unknown" });
    expect(bridge.getOperationRecovery().recoveryRequired).toBe(true);
    await expect(sendCommand("var attempted = true;", { tempDir, mutating: true })).resolves.toMatchObject({ success: false, error: expect.stringContaining("HOST_RECOVERY_REQUIRED") });
  });
});
