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
import { getSourceMonitorTools } from "../../src/tools/source-monitor.js";

const mockedSendCommand = vi.mocked(sendCommand);
const tools = getSourceMonitorTools({ tempDir: "/tmp/source-monitor", timeoutMs: 5000 } as BridgeOptions);
const TICKS = 254016000000;
type Item = { nodeId: string; name: string; type: number };

beforeEach(() => vi.clearAllMocks());

type Placement = { item: Item; startTicks: number };

/**
 * Source Monitor as measured on Premiere 25.2.3: opening pushes a clip,
 * closeClip shows the previously opened one, closeAllClips empties it.
 */
function host(options: { ignoreOpen?: boolean; ignoreClose?: boolean; ignoreOverwrite?: boolean; videoTracks?: number; audioTracks?: number; playheadSeconds?: number } = {}) {
  const items: Item[] = [
    { nodeId: "a1", name: "mono-440.wav", type: 1 },
    { nodeId: "v1", name: "CCI DAY 1.mp4", type: 1 },
  ];
  const opened: Item[] = [];
  const track = () => {
    const placements: Placement[] = [];
    return {
      placements,
      clips: new Proxy({}, {
        get: (_t, key) => key === "numItems"
          ? placements.length
          : (placements[Number(key)] && { projectItem: placements[Number(key)].item, start: { ticks: String(placements[Number(key)].startTicks) } }),
      }),
    };
  };
  const video = Array.from({ length: options.videoTracks ?? 1 }, track);
  const audio = Array.from({ length: options.audioTracks ?? 1 }, track);
  const playerTicks = Math.round((options.playheadSeconds ?? 5) * TICKS);
  const seq = {
    timebase: String(TICKS / 25),
    videoTracks: Object.assign({ numTracks: video.length }, video),
    audioTracks: Object.assign({ numTracks: audio.length }, audio),
    getPlayerPosition: () => ({ ticks: String(playerTicks) }),
    overwriteClip: (item: Item, ticks: string, v: number, a: number) => {
      if (options.ignoreOverwrite) return;
      video[v].placements.push({ item, startTicks: Number(ticks) });
      audio[a].placements.push({ item, startTicks: Number(ticks) });
    },
  };
  const sourceMonitor = {
    openProjectItem: (item: Item) => { if (!item) throw new Error("crash"); if (!options.ignoreOpen) opened.push(item); return true; },
    getProjectItem: () => opened[opened.length - 1] ?? null,
    closeClip: () => { if (!options.ignoreClose) opened.pop(); return true; },
    closeAllClips: () => { if (!options.ignoreClose) opened.length = 0; return true; },
  };
  const rootItem = { children: Object.assign({ numItems: items.length }, items) };
  mockedSendCommand.mockImplementation(async (script: string) =>
    JSON.parse(String(runInNewContext(`${getHelpersSource()}\n${script}`, { app: { project: { rootItem, activeSequence: seq }, sourceMonitor } }))));
  return { opened, video, audio, sourceMonitor };
}

describe("open and close read the Source Monitor back", () => {
  it("open_in_source confirms the clip now showing", async () => {
    host();
    await expect(tools.open_in_source.handler({ item_id: "a1" })).resolves.toMatchObject({ success: true, data: { verified: true, item: "mono-440.wav", nodeId: "a1" } });
  });

  it("open_in_source fails when Premiere does not show the clip", async () => {
    host({ ignoreOpen: true });
    await expect(tools.open_in_source.handler({ item_id: "a1" })).resolves.toMatchObject({ success: false, error: expect.stringContaining("did not show mono-440.wav") });
  });

  it("open_in_source refuses a missing item without calling Premiere", async () => {
    const state = host();
    await expect(tools.open_in_source.handler({ item_id: "nope" })).resolves.toMatchObject({ success: false, error: "Project item not found" });
    expect(state.opened).toEqual([]);
  });

  it("close_source_monitor names the clip it closed and the one now showing", async () => {
    host();
    await tools.open_in_source.handler({ item_id: "a1" });
    await tools.open_in_source.handler({ item_id: "v1" });
    await expect(tools.close_source_monitor.handler()).resolves.toMatchObject({ success: true, data: { item: "CCI DAY 1.mp4", nowShowing: "mono-440.wav" } });
  });

  it("close_source_monitor fails when nothing is open or the clip stays", async () => {
    host();
    await expect(tools.close_source_monitor.handler()).resolves.toMatchObject({ success: false, error: "No clip open in Source Monitor" });
    host({ ignoreClose: true });
    await tools.open_in_source.handler({ item_id: "a1" });
    await expect(tools.close_source_monitor.handler()).resolves.toMatchObject({ success: false, error: expect.stringContaining("still shows mono-440.wav") });
  });

  it("close_all_source_clips verifies the monitor is empty", async () => {
    host();
    await tools.open_in_source.handler({ item_id: "a1" });
    await expect(tools.close_all_source_clips.handler()).resolves.toMatchObject({ success: true, data: { verified: true } });
    host({ ignoreClose: true });
    await tools.open_in_source.handler({ item_id: "a1" });
    await expect(tools.close_all_source_clips.handler()).resolves.toMatchObject({ success: false });
  });
});

describe("overwrite_from_source verifies the placement", () => {
  it("reports a verified placement at the playhead", async () => {
    const state = host();
    await tools.open_in_source.handler({ item_id: "v1" });
    await expect(tools.overwrite_from_source.handler({})).resolves.toMatchObject({
      success: true,
      data: { verified: true, item: "CCI DAY 1.mp4", atSeconds: 5, placedOnVideoTrack: true, placedOnAudioTrack: true },
    });
    expect(state.video[0].placements).toHaveLength(1);
  });

  it("fails when Premiere places nothing", async () => {
    host({ ignoreOverwrite: true });
    await tools.open_in_source.handler({ item_id: "v1" });
    await expect(tools.overwrite_from_source.handler({})).resolves.toMatchObject({ success: false, error: expect.stringContaining("no verifiable new placement") });
  });

  it("refuses an out-of-range or invalid track before writing", async () => {
    const state = host({ videoTracks: 2, audioTracks: 1 });
    await tools.open_in_source.handler({ item_id: "v1" });
    await expect(tools.overwrite_from_source.handler({ audio_track_index: 3 })).resolves.toMatchObject({ success: false, error: expect.stringContaining("Audio track index 3 is out of range") });
    await expect(tools.overwrite_from_source.handler({ video_track_index: 1.5 })).resolves.toMatchObject({ success: false, error: expect.stringContaining("non-negative integers") });
    expect(state.video[0].placements).toHaveLength(0);
  });
});
