import { beforeEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { buildScript, getHelpersSource } from "../../src/bridge/script-builder.js";
import { runWithUndoTracking } from "../../src/bridge/undo-tracking.js";
import type { BridgeOptions } from "../../src/bridge/file-bridge.js";

vi.mock("../../src/bridge/file-bridge.js", () => ({
  sendCommand: vi.fn().mockResolvedValue({ success: true, data: {} }),
  sendRawCommand: vi.fn().mockResolvedValue({ success: true, data: {} }),
  getTempDir: vi.fn().mockReturnValue("/tmp/test"),
  cleanupTempDir: vi.fn(),
}));

import { sendCommand } from "../../src/bridge/file-bridge.js";
import { getProjectTools } from "../../src/tools/project.js";
import { getTrackTargetingTools } from "../../src/tools/track-targeting.js";

const mockedSendCommand = vi.mocked(sendCommand);
const bridgeOptions: BridgeOptions = { tempDir: "/tmp/qe-undo", timeoutMs: 5000 };
const project = getProjectTools(bridgeOptions);
const targeting = getTrackTargetingTools(bridgeOptions);

type Result = { success: boolean; error?: string; data?: Record<string, unknown> };

beforeEach(() => vi.clearAllMocks());

function run(context: Record<string, unknown>) {
  mockedSendCommand.mockImplementation(async (script: string) =>
    JSON.parse(String(runInNewContext(`${getHelpersSource()}\n${script}`, context))));
}

/** Live 25.2: undo()/redo() return true and move undoStackIndex() by one; at the ends nothing moves. */
function undoHost(index: number, top: number, extra: Record<string, unknown> = {}) {
  const stack = {
    index,
    undoStackIndex: () => stack.index,
    undo: () => { if (stack.index > 0) stack.index -= 1; return true; },
    redo: () => { if (stack.index < top) stack.index += 1; return true; },
    ...extra,
  };
  run({ app: { enableQE: () => {} }, qe: { project: stack } });
  return stack;
}

describe("undo, redo and multiple_undo step QE's undo stack with verification", () => {
  it("undoes one action and reports the stack indices (live: 367 -> 366)", async () => {
    const stack = undoHost(367, 367);
    await expect(project.undo.handler({})).resolves.toMatchObject({
      success: true,
      data: { undone: 1, undoStackIndexBefore: 367, undoStackIndexAfter: 366, verified: true },
    });
    expect(stack.index).toBe(366);
  });

  it("redoes one action", async () => {
    undoHost(366, 367);
    await expect(targeting.redo.handler({})).resolves.toMatchObject({
      success: true,
      data: { redone: 1, undoStackIndexAfter: 367, verified: true },
    });
  });

  it("multiple_undo stops and fails honestly when the stack runs out", async () => {
    undoHost(2, 5);
    await expect(targeting.multiple_undo.handler({ count: 3 })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("Only 2 of 3 undo steps"),
      data: { undone: 2, undoStackIndexAfter: 0 },
    });
  });

  it("reports nothing to redo when the stack is already at the top", async () => {
    undoHost(5, 5);
    await expect(targeting.redo.handler({})).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("Nothing to redo"),
    });
  });

  it("does not undo at all on a host without undoStackIndex", async () => {
    const undo = vi.fn();
    run({ app: { enableQE: () => {} }, qe: { project: { undo } } });
    await expect(project.undo.handler({ count: 2 })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("undoStackIndex"),
    });
    expect(undo).not.toHaveBeenCalled();
  });
});

describe("results report the undo steps a command added", () => {
  // The server builds scripts inside runWithUndoTracking(!readOnlyHint, ...).
  const exec = (code: string, qeProject: Record<string, unknown>, mutating = true) =>
    JSON.parse(String(runInNewContext(`${getHelpersSource()}\n${runWithUndoTracking(mutating, () => buildScript(code))}`, { app: { enableQE: () => {} }, qe: { project: qeProject } })));

  it("tags an edit that pushed undo entries (live: razor_all_tracks pushed 8)", () => {
    const stack = { index: 401, undoStackIndex: () => stack.index };
    const bump = () => { stack.index += 8; };
    expect(exec("qe.project.bump(); return __result({ cut: true });", Object.assign(stack, { bump }))).toEqual({
      success: true,
      data: { cut: true, undoSteps: 8, undoStackIndex: 409 },
    });
  });

  it("leaves results alone when nothing was recorded (live: set_clip_opacity) or QE is absent", () => {
    const stack = { undoStackIndex: () => 409 };
    expect(exec("return __result({ opacity: 50 });", stack)).toEqual({ success: true, data: { opacity: 50 } });
    expect(JSON.parse(String(runInNewContext(`${getHelpersSource()}\n${runWithUndoTracking(true, () => buildScript("return __result({ a: 1 });"))}`, {})))).toEqual({ success: true, data: { a: 1 } });
  });

  it("read-only tools never read the undo stack, even in an engine a mutating command used before", () => {
    const stack = { index: 401, undoStackIndex: vi.fn(() => stack.index) };
    const context = { app: { enableQE: vi.fn() }, qe: { project: stack } };
    const run = (code: string, mutating: boolean) =>
      JSON.parse(String(runInNewContext(`${runWithUndoTracking(mutating, () => buildScript(code))}`, context)));
    runInNewContext(getHelpersSource(), context);
    expect(run("qe.project.index += 2; return __result({ cut: true });", true)).toMatchObject({ data: { undoSteps: 2 } });
    stack.undoStackIndex.mockClear();
    context.app.enableQE.mockClear();
    expect(run("return __result({ clips: 3 });", false)).toEqual({ success: true, data: { clips: 3 } });
    expect(stack.undoStackIndex).not.toHaveBeenCalled();
    expect(context.app.enableQE).not.toHaveBeenCalled();
  });

  it("scripts built outside a tool call do not track undo", () => {
    expect(buildScript("return 1;")).toContain("__undoStart = null;");
    expect(runWithUndoTracking(true, () => buildScript("return 1;"))).toContain("__readUndoIndex()");
  });

  it("undo refuses, without undoing, when the stack moved past the guard", async () => {
    const stack = undoHost(368, 368);
    await expect(targeting.multiple_undo.handler({ count: 8, expected_undo_stack_index: 367 })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("other actions were recorded since that call"),
      data: { undoStackIndex: 368, expectedUndoStackIndex: 367 },
    });
    expect(stack.index).toBe(368);
    await expect(project.undo.handler({ expected_undo_stack_index: 368 })).resolves.toMatchObject({ success: true, data: { undone: 1 } });
  });
});
