import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { getHelpersSource } from "../../src/bridge/script-builder.js";
vi.mock("../../src/bridge/file-bridge.js", () => ({ sendCommand: vi.fn(), sendRawCommand: vi.fn() }));
import { sendCommand } from "../../src/bridge/file-bridge.js";
import { getSourceToTimelineTools } from "../../src/tools/source-to-timeline.js";
import { capabilityForTool } from "../../src/security/capabilities.js";

const options = { tempDir: "/tmp/source-map", timeoutMs: 5000 };
const tools = getSourceToTimelineTools(options) as any;
const ticks = (seconds: number) => ({ ticks: String(Math.round(seconds * 254016000000)) });
type ClipArgs = { id: string; start: number; end: number; input: number; output: number; source?: string; path?: string; speed?: number; reverse?: boolean };
function clip(args: ClipArgs) {
  return {
    nodeId: args.id,
    projectItem: { nodeId: args.source ?? "source", getMediaPath: () => args.path ?? "/media/host.wav" },
    start: ticks(args.start), end: ticks(args.end), inPoint: ticks(args.input), outPoint: ticks(args.output),
    getSpeed: () => args.speed ?? 1,
    isSpeedReversed: () => args.reverse ?? false,
  };
}
function fixture(items: ClipArgs[] = []) {
  const values = Array.from({ length: 300 }, (_, i) => clip({ id: `other-${i}`, start: i * 3, end: i * 3 + 1, input: 0, output: 1, source: `other-source-${i}` }));
  for (let i = 0; i < items.length; i++) values[20 + i * 10] = clip(items[i]);
  const track = { name: "V1", clips: Object.assign(values, { numItems: values.length }) };
  const seq = { name: "Edited show", sequenceID: "seq-1", videoTracks: Object.assign([track], { numTracks: 1 }), audioTracks: { numTracks: 0 } };
  const project = { activeSequence: seq, sequences: Object.assign([seq], { numSequences: 1 }) };
  const app = { project };
  vi.mocked(sendCommand).mockImplementation(async script => JSON.parse(String(runInNewContext(`${getHelpersSource()}\n${script}`, { app }))));
  return { values, app };
}

describe("map_source_ranges_to_timeline", () => {
  it("maps a 300-clip track across a cut, reports source gaps, and preserves cold-open reuse placements", async () => {
    fixture([
      { id: "late-a", start: 100, end: 102, input: 10, output: 12 },
      { id: "cut-left", start: 20, end: 25, input: 0, output: 5 },
      { id: "cut-right", start: 40, end: 44, input: 8, output: 12 },
    ]);
    const result = await tools.map_source_ranges_to_timeline.handler({
      sequence_id: "seq-1", track_type: "video", track_index: 0, source_project_item_id: "source",
      ranges: [{ start_seconds: 3, end_seconds: 10 }, { start_seconds: 10, end_seconds: 12 }],
    });
    expect(result).toMatchObject({ success: true, data: { pagination: { totalRanges: 2, returned: 2, truncated: false } } });
    expect(result.data.ranges[0]).toMatchObject({
      inputIndex: 0,
      fragments: [
        { timelineStartSeconds: 23, timelineEndSeconds: 25, clipNodeId: "cut-left" },
        { timelineStartSeconds: 40, timelineEndSeconds: 42, clipNodeId: "cut-right" },
      ],
      unplaced: [{ startSeconds: 5, endSeconds: 8 }],
    });
    expect(result.data.ranges[1].fragments).toEqual([
      { timelineStartSeconds: 100, timelineEndSeconds: 102, clipNodeId: "late-a" },
      { timelineStartSeconds: 42, timelineEndSeconds: 44, clipNodeId: "cut-right" },
    ].sort((a, b) => a.timelineStartSeconds - b.timelineStartSeconds));
  });

  it("maps duplicate source use in timeline order and pages ranges by continuation offset", async () => {
    fixture([
      { id: "cold-open", start: 1, end: 3, input: 30, output: 32 },
      { id: "later-reuse", start: 80, end: 82, input: 30, output: 32 },
    ]);
    const args = { track_type: "video", track_index: 0, media_path: "/media/host.wav", ranges: [
      { start_seconds: 0, end_seconds: 1 }, { start_seconds: 30, end_seconds: 31 }, { start_seconds: 32, end_seconds: 33 },
    ], range_limit: 2 };
    const first = await tools.map_source_ranges_to_timeline.handler(args);
    expect(first.data.pagination).toMatchObject({ returned: 2, truncated: true, nextOffset: 2 });
    expect(first.data.ranges[1].fragments.map((f: any) => f.clipNodeId)).toEqual(["cold-open", "later-reuse"]);
    const second = await tools.map_source_ranges_to_timeline.handler({ ...args, range_offset: first.data.pagination.nextOffset });
    expect(second.data.ranges[0]).toMatchObject({ inputIndex: 2, unplaced: [{ startSeconds: 32, endSeconds: 33 }] });
  });

  it("accepts 100 as normal speed on older hosts", async () => {
    fixture([{ id: "normal-100", start: 20, end: 22, input: 0, output: 2, speed: 100 }]);
    const result = await tools.map_source_ranges_to_timeline.handler({ track_type: "video", track_index: 0, source_project_item_id: "source", ranges: [{ start_seconds: 0, end_seconds: 1 }] });
    expect(result).toMatchObject({ success: true, data: { ranges: [{ fragments: [{ clipNodeId: "normal-100" }] }] } });
  });

  it.each([
    { speed: 2, reverse: false },
    { speed: 0.5, reverse: false },
    { speed: 1, reverse: true },
  ])("refuses retimed or reversed playback $speed/$reverse", async ({ speed, reverse }) => {
    fixture([{ id: "retimed", start: 20, end: 22, input: 0, output: 4, speed, reverse }]);
    const result = await tools.map_source_ranges_to_timeline.handler({ track_type: "video", track_index: 0, source_project_item_id: "source", ranges: [{ start_seconds: 0, end_seconds: 1 }] });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("non-1x or reversed") });
  });

  it("escapes source IDs before embedding them in the host script", async () => {
    const id = 'source"; app.__injected = true; //';
    const { app } = fixture([{ id: "escaped-id", start: 10, end: 11, input: 0, output: 1, source: id }]);
    const result = await tools.map_source_ranges_to_timeline.handler({ track_type: "video", track_index: 0, source_project_item_id: id, ranges: [{ start_seconds: 0, end_seconds: 1 }] });
    expect(result).toMatchObject({ success: true, data: { ranges: [{ fragments: [{ clipNodeId: "escaped-id" }] }] } });
    expect((app as any).__injected).toBeUndefined();
  });

  it("skips generated clips without a project item but refuses unreadable source identities", async () => {
    const { values } = fixture([{ id: "placed", start: 10, end: 11, input: 0, output: 1 }]);
    values[0].projectItem = null as any;
    const valid = await tools.map_source_ranges_to_timeline.handler({ track_type: "video", track_index: 0, source_project_item_id: "source", ranges: [{ start_seconds: 0, end_seconds: 1 }] });
    expect(valid).toMatchObject({ success: true, data: { ranges: [{ fragments: [{ clipNodeId: "placed" }], unplaced: [] }] } });

    const unreadableId = fixture();
    unreadableId.values[0].projectItem = Object.defineProperty({}, "nodeId", { get() { throw new Error("unavailable"); } }) as any;
    const idFailure = await tools.map_source_ranges_to_timeline.handler({ track_type: "video", track_index: 0, source_project_item_id: "source", ranges: [{ start_seconds: 0, end_seconds: 1 }] });
    expect(idFailure).toMatchObject({ success: false, error: expect.stringContaining("source project item identity") });

    const unreadablePath = fixture();
    unreadablePath.values[0].projectItem = { nodeId: "item-0", getMediaPath() { throw new Error("unavailable"); } } as any;
    const pathFailure = await tools.map_source_ranges_to_timeline.handler({ track_type: "video", track_index: 0, media_path: "/media/host.wav", ranges: [{ start_seconds: 0, end_seconds: 1 }] });
    expect(pathFailure).toMatchObject({ success: false, error: expect.stringContaining("source media path") });
  });

  it("validates source choice, ranges, and paging before bridge dispatch", async () => {
    vi.mocked(sendCommand).mockClear();
    const valid = { track_type: "video", track_index: 0, source_project_item_id: "source", ranges: [{ start_seconds: 0, end_seconds: 1 }] };
    for (const bad of [
      { ...valid, media_path: "/media/host.wav" },
      { ...valid, ranges: [{ start_seconds: 1, end_seconds: 1 }] },
      { ...valid, ranges: Array.from({ length: 2001 }, () => ({ start_seconds: 0, end_seconds: 1 })) },
      { ...valid, range_offset: -1 },
      { ...valid, range_limit: 201 },
    ]) await expect(tools.map_source_ranges_to_timeline.handler(bad)).rejects.toThrow();
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("requires inspect authority and generates bounded, read-only script", async () => {
    fixture();
    expect(capabilityForTool("map_source_ranges_to_timeline")).toBe("inspect");
    await tools.map_source_ranges_to_timeline.handler({ track_type: "video", track_index: 0, source_project_item_id: "source", ranges: [{ start_seconds: 0, end_seconds: 1 }] });
    const script = String(vi.mocked(sendCommand).mock.calls.at(-1)?.[0]);
    expect(script).toContain("payloadBudgetCharacters: 40000");
    expect(script).toContain("track.clips.numItems");
    expect(script).not.toMatch(/\.move\(|\.remove\(|\.insertClip\(|\.overwriteClip\(/);
  });
});
