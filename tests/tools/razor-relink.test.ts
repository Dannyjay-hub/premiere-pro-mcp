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
import { getTrackTargetingTools } from "../../src/tools/track-targeting.js";

const mockedSendCommand = vi.mocked(sendCommand);
const TICKS = 254016000000;
const FPS = 25;
const bridgeOptions: BridgeOptions = { tempDir: "/tmp/razor-relink", timeoutMs: 5000 };
const tools = getTrackTargetingTools(bridgeOptions);
type Result = { success: boolean; error?: string; data?: Record<string, unknown> };

beforeEach(() => vi.clearAllMocks());

type FakeClip = {
  nodeId: string;
  name: string;
  start: { ticks: string; seconds: number };
  end: { ticks: string; seconds: number };
  group: FakeClip[] | null;
  selected: boolean;
  getLinkedItems: () => unknown;
  isSelected: () => boolean;
  setSelected: (value: boolean) => void;
};

/**
 * One linked video/audio pair over 0-121.6 s. Like Premiere 25.2, a QE razor
 * keeps the left piece linked and leaves the right piece unlinked.
 */
function host(options: { linkWorks?: boolean } = {}) {
  let ids = 0;
  const time = (seconds: number) => ({ ticks: String(Math.round(seconds * TICKS)), seconds });
  const make = (start: number, end: number): FakeClip => {
    const clip: FakeClip = {
      nodeId: `n${++ids}`,
      name: "Interview A.mp4",
      start: time(start),
      end: time(end),
      group: null,
      selected: false,
      getLinkedItems() {
        if (!clip.group) return null;
        const list: Record<string | number, unknown> = { numItems: clip.group.length };
        clip.group.forEach((member, index) => { list[index] = member; });
        return list;
      },
      isSelected: () => clip.selected,
      setSelected(value: boolean) { clip.selected = value; },
    };
    return clip;
  };
  const video = [make(0, 121.6)];
  const audio = [make(0, 121.6)];
  const pair = [video[0], audio[0]];
  video[0].group = pair;
  audio[0].group = pair;
  const collection = (list: FakeClip[]) => new Proxy({}, {
    get: (_target, key) => (key === "numItems" ? list.length : list[Number(key)]),
  });
  const razorTrack = (list: FakeClip[]) => ({
    razor(timecode: string) {
      const [h, m, s, f] = timecode.split(":").map(Number);
      const at = h * 3600 + m * 60 + s + f / FPS;
      const index = list.findIndex((c) => c.start.seconds < at && c.end.seconds > at);
      if (index < 0) return;
      const left = list[index];
      const right = make(at, left.end.seconds);
      left.end = time(at);
      list.splice(index + 1, 0, right);
    },
  });
  const all = () => [...video, ...audio];
  const seq = {
    sequenceID: "seq",
    timebase: String(TICKS / FPS),
    videoTracks: { numTracks: 1, 0: { clips: collection(video) } },
    audioTracks: { numTracks: 1, 0: { clips: collection(audio) } },
    getPlayerPosition: () => time(0),
    getSelection: () => all().filter((c) => c.selected),
    linkSelection() {
      if (options.linkWorks === false) return;
      const chosen = all().filter((c) => c.selected);
      chosen.forEach((c) => { c.group = chosen; });
    },
  };
  const context = {
    app: { enableQE: () => {}, project: { activeSequence: seq, sequences: { numSequences: 1, 0: seq } } },
    qe: { project: { getActiveSequence: () => ({ getVideoTrackAt: () => razorTrack(video), getAudioTrackAt: () => razorTrack(audio) }) } },
  };
  mockedSendCommand.mockImplementation(async (script: string) => JSON.parse(String(runInNewContext(`${getHelpersSource()}\n${script}`, context))));
  return { video, audio };
}

describe("razor_all_tracks keeps linked video and audio linked", () => {
  it("relinks the right-hand pieces after each cut", async () => {
    const { video, audio } = host();
    video[0].selected = true;
    for (const cut of [10, 30]) {
      await expect(tools.razor_all_tracks.handler({ time_seconds: cut })).resolves.toMatchObject({
        success: true,
        data: { relinkedGroups: 1, verified: true },
      });
    }
    expect(video.map((c) => c.start.seconds)).toEqual([0, 10, 30]);
    for (let i = 0; i < 3; i++) {
      expect(video[i].group).toContain(audio[i]);
      expect(audio[i].group).toContain(video[i]);
    }
    // The user's selection is restored.
    expect(video.map((c) => c.selected)).toEqual([true, false, false]);
    expect(audio.some((c) => c.selected)).toBe(false);
  });

  it("reports an unverified result when Premiere will not relink", async () => {
    host({ linkWorks: false });
    const result = await tools.razor_all_tracks.handler({ time_seconds: 10 }) as Result;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/did not keep 1 linked video\/audio group/);
  });
});
