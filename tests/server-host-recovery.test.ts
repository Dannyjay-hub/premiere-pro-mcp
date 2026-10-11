import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../src/server.js";
import { inspectHostRecovery } from "../src/bridge/host-lease.js";

const controls = vi.hoisted(() => ({ afterWrite: undefined as (() => void) | undefined }));
vi.mock("../src/tools/project.js", async () => {
  const { sendCommand } = await import("../src/bridge/file-bridge.js");
  const { assertInvocationNotCancelled, currentInvocation, markHostDispatch } = await import("../src/workflows/invocation-context.js");
  const parameters = { type: "object", additionalProperties: false, properties: {
    mode: { type: "string", enum: ["verified", "throw", "cancel", "unknown", "preflight"], description: "Workflow boundary under test." },
  }, required: ["mode"] };
  return { getProjectTools: (options: { tempDir?: string; timeoutMs?: number }) => ({
    set_host_recovery_fixture: {
      description: "CEP multi-command workflow recovery fixture.", parameters,
      operationalCapability: { backend: "CEP/ExtendScript", backends: ["cep"] },
      handler: async (args: { mode: string }) => {
        if (args.mode === "preflight") throw new Error("fixture preflight refusal");
        const write = await sendCommand("/* fixture-host-mutation */ var accepted = true;", { ...options, mutating: true });
        if (!write.success) return write;
        controls.afterWrite?.();
        if (args.mode === "throw") throw new Error("fixture readback failed after write");
        if (args.mode === "cancel") {
          const signal = currentInvocation()?.signal;
          if (!signal?.aborted) await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
          assertInvocationNotCancelled();
        }
        if (args.mode === "unknown") return { success: false, data: { outcome: "unknown", partialSteps: [{ writeAccepted: true }] }, error: "fixture readback unavailable" };
        return { success: true, data: { outcome: "verified" } };
      },
    },
    set_local_recovery_fixture: {
      description: "Local workflow failure must not create a Premiere recovery record.", parameters,
      operationalCapability: { backend: "local", backends: ["local"] },
      handler: async () => {
        // Even an incorrect dispatch flag cannot turn local metadata into a
        // persisted claim about an accepted Premiere mutation.
        markHostDispatch();
        throw new Error("fixture local planning failure");
      },
    },
  }) };
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { controls.afterWrite = undefined; for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function connected() {
  const tempDir = mkdtempSync(join(tmpdir(), "premiere-server-recovery-"));
  const accepted: string[] = [], replied = new Set<string>();
  // Exercise the real private-file transport and ownership lease. This simulated
  // panel acknowledges package IPC only; it is not live Premiere evidence.
  const panel = watch(tempDir, (_event, filename) => {
    const commandName = String(filename || "");
    if (!/^cmd_[a-f0-9-]+\.jsx$/.test(commandName) || replied.has(commandName)) return;
    let script: string;
    try { script = readFileSync(join(tempDir, commandName), "utf8"); } catch { return; }
    replied.add(commandName);
    if (script.includes("fixture-host-mutation")) accepted.push(commandName);
    const snapshot = script.includes("snapshot.clips.push")
      ? { projectId: "project-1", sequenceId: "sequence-1", clips: [] }
      : { outcome: "verified" };
    writeFileSync(join(tempDir, commandName.replace(/^cmd_/, "res_").replace(/\.jsx$/, ".json")), JSON.stringify({ success: true, data: snapshot }), { mode: 0o600 });
  });
  const server = createServer({ tempDir, timeoutMs: 500 }, {
    toolPacks: "full", telemetry: { enabled: false, capture() {}, async shutdown() {} },
  });
  const client = new Client({ name: "server-workflow-recovery-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(async () => { await client.close(); await server.close(); panel.close(); rmSync(tempDir, { recursive: true, force: true }); });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, tempDir, accepted };
}
async function reviewedAcknowledge(client: Client) {
  const inspected = await client.callTool({ name: "inspect_operation_recovery", arguments: { backend: "cep" } });
  const data = (inspected.structuredContent as { data: { recoveryRevision: string; hostStateRevision: string } }).data;
  const acknowledged = await client.callTool({ name: "acknowledge_operation_recovery", arguments: {
    backend: "cep", expected_recovery_revision: data.recoveryRevision, expected_host_state_revision: data.hostStateRevision, reviewed: true,
  } });
  expect(acknowledged.isError).toBeFalsy();
}

describe("server persists uncertain multi-command host workflows under their lease", () => {
  it.each(["throw", "unknown"])("blocks later edits after a write followed by %s until exact reviewed acknowledgement", async (mode) => {
    const { client, tempDir, accepted } = await connected();
    const failed = await client.callTool({ name: "set_host_recovery_fixture", arguments: { mode } });
    expect(failed).toMatchObject({ isError: true, structuredContent: { receipt: { outcome: "unknown" } } });
    expect(inspectHostRecovery(tempDir).recoveryRequired).toBe(true);
    const blocked = await client.callTool({ name: "set_host_recovery_fixture", arguments: { mode: "verified" } });
    expect(blocked).toMatchObject({ isError: true, structuredContent: { error: expect.stringContaining("HOST_RECOVERY_REQUIRED") } });
    expect(accepted).toHaveLength(1);
    await reviewedAcknowledge(client);
    expect(inspectHostRecovery(tempDir).recoveryRequired).toBe(false);
    await expect(client.callTool({ name: "set_host_recovery_fixture", arguments: { mode: "verified" } })).resolves.toMatchObject({ structuredContent: { receipt: { outcome: "verified" } } });
    expect(accepted).toHaveLength(2);
  });
  it("records cancelled readback before releasing the lease to an already queued edit", async () => {
    const { client, tempDir, accepted } = await connected();
    let firstWriteAccepted = () => {};
    const written = new Promise<void>((resolve) => { firstWriteAccepted = resolve; });
    controls.afterWrite = firstWriteAccepted;
    const abort = new AbortController();
    const cancelled = client.callTool({ name: "set_host_recovery_fixture", arguments: { mode: "cancel" } }, { signal: abort.signal });
    const observedCancellation = cancelled.then(() => "returned", () => "cancelled");
    await written;
    const queued = client.callTool({ name: "set_host_recovery_fixture", arguments: { mode: "verified" } });
    abort.abort();
    expect(await observedCancellation).toBe("cancelled");
    expect(await queued).toMatchObject({ isError: true, structuredContent: { error: expect.stringContaining("HOST_RECOVERY_REQUIRED") } });
    expect(accepted).toHaveLength(1);
    expect(inspectHostRecovery(tempDir).recoveryRequired).toBe(true);
    await reviewedAcknowledge(client);
    await expect(client.callTool({ name: "set_host_recovery_fixture", arguments: { mode: "verified" } })).resolves.toMatchObject({ structuredContent: { ok: true, receipt: { outcome: "verified" } } });
    expect(accepted).toHaveLength(2);
  });
  it("does not create host recovery for local failures or host preflight refusals", async () => {
    const { client, tempDir, accepted } = await connected();
    await expect(client.callTool({ name: "set_local_recovery_fixture", arguments: { mode: "throw" } })).resolves.toMatchObject({ isError: true });
    expect(inspectHostRecovery(tempDir).recoveryRequired).toBe(false);
    await expect(client.callTool({ name: "set_host_recovery_fixture", arguments: { mode: "preflight" } })).resolves.toMatchObject({ isError: true, structuredContent: { receipt: { outcome: "not_applied" } } });
    expect(inspectHostRecovery(tempDir).recoveryRequired).toBe(false);
    expect(accepted).toHaveLength(0);
  });
});
