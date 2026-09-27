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
import { getTransitionsTools } from "../../src/tools/transitions.js";

const mockedSendCommand = vi.mocked(sendCommand);
const TICKS = 254016000000;
const FRAME = TICKS / 25;
const bridgeOptions: BridgeOptions = { tempDir: "/tmp/transition-readback", timeoutMs: 5000 };
const tools = getTransitionsTools(bridgeOptions);

beforeEach(() => vi.clearAllMocks());

const t = (seconds: number) => ({ ticks: String(Math.round(seconds * TICKS)) });

/**
 * Three 6 s clips on V1 at 25 fps. `place` decides where Premiere puts the
 * transition relative to the cut, mirroring live Premiere 25.2 behavior: a
 * 1 s (25-frame) Cross Dissolve centered on the 6 s cut lands at 5.52-6.52 s.
 */
function hostWith(place: (cutSeconds: number) => [number, number]) {
  const clips = [[0, 6], [6, 12], [12, 18]].map(([start, end], index) => ({ nodeId: `n${index + 1}`, name: `clip${index}`, start: t(start), end: t(end) }));
  const domTransitions: Array<{ start: { ticks: string }; end: { ticks: string } }> = [];
  const domTrack = {
    clips: Object.assign({ numItems: clips.length }, clips),
    transitions: {
      get numItems() { return domTransitions.length; },
    } as Record<string | number, unknown>,
  };
  const qeClips = clips.map((clip) => ({
    type: "Clip",
    start: clip.start,
    addTransition: () => {
      const cutSeconds = parseFloat(clip.start.ticks) / TICKS;
      const [start, end] = place(cutSeconds);
      const placed = { start: t(start), end: t(end) };
      domTrack.transitions[domTransitions.length] = placed;
      domTransitions.push(placed);
    },
  }));
  const context = {
    app: {
      enableQE: () => {},
      project: { activeSequence: { timebase: String(FRAME), videoTracks: { numTracks: 1, 0: domTrack }, audioTracks: { numTracks: 0 } } },
    },
    qe: {
      project: {
        getActiveSequence: () => ({ getVideoTrackAt: () => ({ numItems: qeClips.length, getItemAt: (i: number) => qeClips[i] }) }),
        getVideoTransitionByName: (name: string) => ({ name }),
      },
    },
  };
  mockedSendCommand.mockImplementation(async (script: string) => JSON.parse(String(runInNewContext(`${getHelpersSource()}\n${script}`, context))));
}

const add = (cut: number) =>
  tools.add_transition.handler({ transition_name: "Cross Dissolve", track_index: 0, cut_point_seconds: cut, duration_seconds: 1 }) as Promise<{ success: boolean; error?: string; data?: Record<string, unknown> }>;

describe("add_transition readback", () => {
  it("verifies an odd-frame dissolve that Premiere centers half a frame off the cut", async () => {
    // Live readback was 5.52000001073161-6.52000001073161 s: 12 frames before the
    // cut, 13 after, plus a few ticks of drift, so the midpoint sits just over
    // half a frame from the cut.
    const drift = 2726 / TICKS;
    hostWith((cut) => [cut - (12 * FRAME) / TICKS + drift, cut + (13 * FRAME) / TICKS + drift]);
    await expect(add(6)).resolves.toMatchObject({ success: true, data: { verified: true } });
  });

  it("verifies a transition pushed entirely to one side of the cut (no handles)", async () => {
    hostWith((cut) => [cut - 1, cut]);
    await expect(add(12)).resolves.toMatchObject({ success: true, data: { verified: true } });
  });

  it("still fails when the new transition does not cover the requested cut", async () => {
    hostWith(() => [1, 2]);
    await expect(add(6)).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("did not find it at the requested cut point"),
    });
  });
});

describe("add_transition_to_clip and batch_add_transitions readback", () => {
  it("batch verifies odd-frame dissolves at every cut (live: 3 of 4 reported)", async () => {
    const drift = 2726 / TICKS;
    hostWith((cut) => [cut - (12 * FRAME) / TICKS + drift, cut + (13 * FRAME) / TICKS + drift]);
    const result = await tools.batch_add_transitions.handler({ transition_name: "Cross Dissolve", track_index: 0, duration_seconds: 1 }) as { success: boolean; error?: string };
    expect(result.success).toBe(true);
  });

  it("add_transition_to_clip verifies a dissolve that covers the clip start", async () => {
    const drift = 2726 / TICKS;
    hostWith((cut) => [cut - (12 * FRAME) / TICKS + drift, cut + (13 * FRAME) / TICKS + drift]);
    const result = await tools.add_transition_to_clip.handler({ node_id: "n2", transition_name: "Cross Dissolve", position: "start", duration_seconds: 1 }) as { success: boolean; error?: string };
    expect(result).toMatchObject({ success: true });
  });
});

describe("batch_add_transitions with an existing transition", () => {
  it("leaves a cut that already has a transition and verifies the rest", async () => {
    hostWith((cut) => [cut - 0.5, cut + 0.5]);
    await tools.add_transition_to_clip.handler({ node_id: "n2", transition_name: "Cross Dissolve", position: "start", duration_seconds: 1 });
    const result = await tools.batch_add_transitions.handler({ transition_name: "Cross Dissolve", track_index: 0, duration_seconds: 1 }) as { success: boolean; data?: Record<string, unknown> };
    expect(result).toMatchObject({ success: true, data: { added: 1, alreadyPresent: 1, verified: true } });
  });
});
