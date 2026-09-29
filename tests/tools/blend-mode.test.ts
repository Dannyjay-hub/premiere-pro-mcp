import { beforeEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { getHelpersSource } from "../../src/bridge/script-builder.js";
import type { BridgeOptions } from "../../src/bridge/file-bridge.js";

vi.mock("../../src/bridge/file-bridge.js", () => ({
  sendCommand: vi.fn().mockResolvedValue({ success: true, data: {} }),
  sendRawCommand: vi.fn().mockResolvedValue({ success: true, data: {} }),
  getTempDir: vi.fn().mockReturnValue("/tmp/test"),
  cleanupTempDir: vi.fn(),
}));

import { sendCommand } from "../../src/bridge/file-bridge.js";
import { BLEND_MODES, getClipboardTools } from "../../src/tools/clipboard.js";

const mockedSendCommand = vi.mocked(sendCommand);
const tools = getClipboardTools({ tempDir: "/tmp/blend-mode", timeoutMs: 5000 } as BridgeOptions);

beforeEach(() => vi.clearAllMocks());

/** A clip whose Opacity > Blend Mode clamps writes to 0-27, like Premiere 25.2.3. */
function host(options: { ignoreWrite?: boolean } = {}) {
  const state = { mode: 18 };
  const blend = {
    displayName: "Blend Mode",
    getValue: () => state.mode,
    setValue: (value: number) => { if (!options.ignoreWrite) state.mode = Math.max(0, Math.min(27, value)); },
  };
  const opacity = { displayName: "Opacity", matchName: "AE.ADBE Opacity", properties: { numItems: 3, 0: { displayName: "Opacity" }, 1: blend, 2: { displayName: "Blend Mode", getValue: () => 0 } } };
  const clip = { nodeId: "c1", name: "Top", components: { numItems: 1, 0: opacity } };
  const seq = { videoTracks: { numTracks: 1, 0: { clips: { numItems: 1, 0: clip } } }, audioTracks: { numTracks: 0 } };
  mockedSendCommand.mockImplementation(async (script: string) =>
    JSON.parse(String(runInNewContext(`${getHelpersSource()}\n${script}`, { app: { project: { activeSequence: seq } } }))));
  return state;
}

describe("set_blend_mode", () => {
  // Measured on Premiere 25.2.3: each index rendered over a solid background
  // matched exactly one blend formula; the order is alphabetical, then
  // Subtract and Divide.
  it.each([
    ["Normal", 18], ["Multiply", 17], ["Screen", 22], ["Color Burn", 1], ["Darken", 3],
    ["Overlay", 19], ["Soft Light", 23], ["Subtract", 25], ["Divide", 26], ["Color", 0],
  ])("writes %s as index %i and reads it back", async (mode, index) => {
    const state = host();
    await expect(tools.set_blend_mode.handler({ node_id: "c1", blend_mode: mode }))
      .resolves.toMatchObject({ success: true, data: { blendMode: mode, modeIndex: index, verified: true } });
    expect(state.mode).toBe(index);
  });

  it("offers every mode exactly once", () => {
    expect(new Set(BLEND_MODES).size).toBe(27);
    expect(tools.set_blend_mode.parameters.properties.blend_mode.enum).toEqual([...BLEND_MODES]);
  });

  it("fails when Premiere keeps the old mode", async () => {
    host({ ignoreWrite: true });
    await expect(tools.set_blend_mode.handler({ node_id: "c1", blend_mode: "Multiply" }))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining("reads back as 18 instead of 17") });
  });

  it("refuses an unknown mode instead of silently using another", async () => {
    await expect(tools.set_blend_mode.handler({ node_id: "c1", blend_mode: "Glow" }))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining("Unknown blend mode Glow") });
    expect(mockedSendCommand).not.toHaveBeenCalled();
  });
});
