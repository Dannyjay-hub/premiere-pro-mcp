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
import { getAdvancedTools } from "../../src/tools/advanced.js";
import { getTimelineTools } from "../../src/tools/timeline.js";

const mockedSendCommand = vi.mocked(sendCommand);
const TICKS = 254016000000;
const bridgeOptions: BridgeOptions = { tempDir: "/tmp/linked-trim", timeoutMs: 5000 };
const tools = getAdvancedTools(bridgeOptions);
type Result = { success: boolean; error?: string; data?: Record<string, unknown> };

beforeEach(() => vi.clearAllMocks());

const ticksOf = (value: unknown) => parseFloat(typeof value === "object" && value ? String((value as { ticks: string }).ticks) : String(value));
const secs = (t: number) => Math.round((t / TICKS) * 1000) / 1000;

function makeClip(id: string, start: number, end: number, inPoint: number, options: { rejectInPoint?: boolean } = {}) {
  let s = start * TICKS; let e = end * TICKS; let i = inPoint * TICKS; let o = (inPoint + end - start) * TICKS;
  const clip = {
    nodeId: id,
    name: "Interview A.mp4",
    group: null as unknown[] | null,
    get start() { return { ticks: String(Math.round(s)) }; }, set start(v: unknown) { s = ticksOf(v); },
    get end() { return { ticks: String(Math.round(e)) }; }, set end(v: unknown) { e = ticksOf(v); },
    get inPoint() { return { ticks: String(Math.round(i)) }; },
    set inPoint(v: unknown) { if (options.rejectInPoint) throw new Error("locked"); i = ticksOf(v); },
    get outPoint() { return { ticks: String(Math.round(o)) }; }, set outPoint(v: unknown) { o = ticksOf(v); },
    get duration() { return { ticks: String(Math.round(e - s)) }; },
    components: { numItems: 0 },
    projectItem: { getMediaPath: () => "/Users/me/Desktop/Interview A.mp4" },
    getSpeed: () => 1,
    isSpeedReversed: () => false,
    getLinkedItems() {
      if (!clip.group) return null;
      const list: Record<string | number, unknown> = { numItems: clip.group.length };
      clip.group.forEach((m, k) => { list[k] = m; });
      return list;
    },
    snapshot: () => [secs(s), secs(e), secs(i), secs(o)],
  };
  return clip;
}

/** Three linked shots on V1/A1: 0-10, 10-30, 30-60 (source time = timeline time). */
function host(options: { audioRejectsInPoint?: boolean } = {}) {
  const ranges: Array<[number, number]> = [[0, 10], [10, 30], [30, 60]];
  const video = ranges.map(([a, b], k) => makeClip(`v${k}`, a, b, a));
  const audio = ranges.map(([a, b], k) => makeClip(`a${k}`, a, b, a, { rejectInPoint: options.audioRejectsInPoint && k === 1 }));
  video.forEach((v, k) => { v.group = [v, audio[k]]; audio[k].group = [v, audio[k]]; });
  const collection = (list: unknown[]) => new Proxy({}, { get: (_t, key) => (key === "numItems" ? list.length : list[Number(key)]) });
  const seq = {
    sequenceID: "seq",
    timebase: String(TICKS / 25),
    videoTracks: { numTracks: 1, 0: { clips: collection(video) } },
    audioTracks: { numTracks: 1, 0: { clips: collection(audio) } },
  };
  const context = {
    app: { project: { activeSequence: seq, sequences: { numSequences: 1, 0: seq } } },
    Time: function Time(this: { ticks: string }) { this.ticks = "0"; },
  };
  mockedSendCommand.mockImplementation(async (script: string) => JSON.parse(String(runInNewContext(`${getHelpersSource()}\n${script}`, context))));
  return { video, audio };
}

describe("trim edits keep linked audio in sync", () => {
  it("slip_edit slips the linked audio too", async () => {
    const { video, audio } = host();
    const result = await tools.slip_edit.handler({ node_id: "v1", offset_seconds: 1 }) as Result;
    expect(result.success).toBe(true);
    expect(result.data?.linkedPartnersEdited).toEqual([{ nodeId: "a1", trackType: "audio", trackIndex: 0 }]);
    expect(video[1].snapshot()).toEqual([10, 30, 11, 31]);
    expect(audio[1].snapshot()).toEqual(video[1].snapshot());
  });

  it("roll_edit rolls the linked audio cut too", async () => {
    const { video, audio } = host();
    await expect(tools.roll_edit.handler({ node_id: "v1", offset_seconds: 0.5 })).resolves.toMatchObject({ success: true });
    for (const list of [video, audio]) {
      expect(list[1].snapshot().slice(0, 2)).toEqual([10, 30.5]);
      expect(list[2].snapshot().slice(0, 3)).toEqual([30.5, 60, 30.5]);
    }
  });

  it("slide_edit trims both neighbours' source points so their pictures do not shift", async () => {
    const { video, audio } = host();
    await expect(tools.slide_edit.handler({ node_id: "v1", offset_seconds: -0.5 })).resolves.toMatchObject({ success: true });
    for (const list of [video, audio]) {
      expect(list[0].snapshot()).toEqual([0, 9.5, 0, 9.5]);
      expect(list[1].snapshot().slice(0, 3)).toEqual([9.5, 29.5, 10]);
      // Live Premiere 25.2 bug: the following clip kept in=30 and showed source 30.5 at 30.0.
      expect(list[2].snapshot().slice(0, 3)).toEqual([29.5, 60, 29.5]);
    }
  });

  it("include_linked false edits only the given clip", async () => {
    const { video, audio } = host();
    await expect(tools.slip_edit.handler({ node_id: "v1", offset_seconds: 1, include_linked: false })).resolves.toMatchObject({ success: true, data: { linkedPartnersEdited: [] } });
    expect(video[1].snapshot()[2]).toBe(11);
    expect(audio[1].snapshot()[2]).toBe(10);
  });

  it("reports a partial edit when the linked partner cannot follow", async () => {
    host({ audioRejectsInPoint: true });
    const result = await tools.slip_edit.handler({ node_id: "v1", offset_seconds: 1 }) as Result;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/slip was applied to the clip but not to its linked audio clip on track 1.*Use Undo/);
  });
});

describe("trim_clip and set_clip_duration move the visible edge and follow linked audio", () => {
  const timeline = getTimelineTools(bridgeOptions);

  it("a head trim moves the clip start with its in point (Premiere 25.2 left the start in place)", async () => {
    const { video, audio } = host();
    const result = await timeline.trim_clip.handler({ node_id: "v1", new_in_seconds: 15 }) as Result;
    expect(result).toMatchObject({ success: true, data: { verified: true } });
    expect(video[1].snapshot()).toEqual([15, 30, 15, 30]);
    expect(audio[1].snapshot()).toEqual([15, 30, 15, 30]);
  });

  it("a tail trim moves the clip end with its out point", async () => {
    const { video, audio } = host();
    await expect(timeline.trim_clip.handler({ node_id: "v1", new_out_seconds: 25 })).resolves.toMatchObject({ success: true });
    expect(video[1].snapshot()).toEqual([10, 25, 10, 25]);
    expect(audio[1].snapshot()).toEqual([10, 25, 10, 25]);
  });

  it("set_clip_duration keeps the out point consistent with the new end", async () => {
    const { video, audio } = host();
    await expect(timeline.set_clip_duration.handler({ node_id: "v1", duration_seconds: 12 })).resolves.toMatchObject({ success: true });
    expect(video[1].snapshot()).toEqual([10, 22, 10, 22]);
    expect(audio[1].snapshot()).toEqual([10, 22, 10, 22]);
  });
});

describe("remove_from_timeline takes linked partners and verifies", () => {
  const timeline = getTimelineTools(bridgeOptions);
  const removable = (options: { stubborn?: string } = {}) => {
    const { video, audio } = host();
    for (const list of [video, audio]) {
      for (const clip of [...list]) {
        (clip as unknown as { remove: () => number }).remove = () => {
          if (clip.nodeId !== options.stubborn) list.splice(list.indexOf(clip), 1);
          return 0;
        };
      }
    }
    return { video, audio };
  };

  it("removes the shot's audio with it by default (live: plan remove left the audio behind)", async () => {
    const { video, audio } = removable();
    const result = await timeline.remove_from_timeline.handler({ node_id: "v1" }) as Result;
    expect(result).toMatchObject({ success: true, data: { removedClipIds: ["v1", "a1"], linkedPartnersRemoved: 1, verified: true } });
    expect(video.map((c) => c.nodeId)).toEqual(["v0", "v2"]);
    expect(audio.map((c) => c.nodeId)).toEqual(["a0", "a2"]);
  });

  it("keeps the partner when include_linked is false", async () => {
    const { audio } = removable();
    await expect(timeline.remove_from_timeline.handler({ node_id: "v1", include_linked: false })).resolves.toMatchObject({ success: true, data: { linkedPartnersRemoved: 0 } });
    expect(audio).toHaveLength(3);
  });

  it("fails when Premiere leaves a clip behind", async () => {
    removable({ stubborn: "a1" });
    await expect(timeline.remove_from_timeline.handler({ node_id: "v1" })).resolves.toMatchObject({ success: false, error: expect.stringContaining("did not remove") });
  });

  it("routes ripple removal through the verified ripple delete, never remove(true, ...)", async () => {
    mockedSendCommand.mockResolvedValue({ success: true, data: {} });
    await timeline.remove_from_timeline.handler({ node_id: "v1", ripple: true });
    const script = String(mockedSendCommand.mock.calls.at(-1)?.[0]);
    expect(script).not.toMatch(/\.remove\(true/);
    expect(script).toContain("Ripple delete refused");
  });
});

describe("slide_edit checks linked partners before changing anything", () => {
  it("refuses without moving the picture when the linked audio has a gap (live: video slid, audio refused)", async () => {
    const { video, audio } = host();
    audio[1].start = { ticks: String(10.5 * TICKS) };
    const before = video.map((clip) => clip.snapshot());
    const result = await tools.slide_edit.handler({ node_id: "v1", offset_seconds: 1 }) as Result;
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("Nothing was changed") });
    expect(video.map((clip) => clip.snapshot())).toEqual(before);
  });
});

describe("rename_clip", () => {
  it("renames through the clip itself, so a gap before it cannot misdirect the rename (live: QE index hit the gap)", async () => {
    const { video } = host();
    await expect(tools.rename_clip.handler({ node_id: "v1", new_name: "Speaker close-up" }))
      .resolves.toMatchObject({ success: true, data: { renamed: true, verified: true, newName: "Speaker close-up" } });
    expect(video[1].name).toBe("Speaker close-up");
  });
});
