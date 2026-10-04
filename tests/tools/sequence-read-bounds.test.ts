import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { getHelpersSource } from "../../src/bridge/script-builder.js";
vi.mock("../../src/bridge/file-bridge.js", () => ({ sendCommand: vi.fn(), sendRawCommand: vi.fn() }));
import { sendCommand } from "../../src/bridge/file-bridge.js";
import { getDiscoveryTools } from "../../src/tools/discovery.js";
import { getScriptingTools } from "../../src/tools/scripting.js";
import { getInspectionTools } from "../../src/tools/inspection.js";
const options = { tempDir: "/tmp/bounds", timeoutMs: 5000 };
const tools = { ...getDiscoveryTools(options), ...getScriptingTools(options), ...getInspectionTools(options) };
const tick = (seconds: number) => ({ ticks: String(seconds * 254016000000) });
function fixture(count = 800, name = "Clip") {
  const clips = Array.from({ length: count }, (_, i) => ({ nodeId: `clip-${i}`, name, start: tick(i * 2 + 1), end: tick(i * 2 + 2), inPoint: tick(0), outPoint: tick(1), duration: tick(1), mediaType: "Video", components: { numItems: 0 } }));
  const track = { name: "V1", clips: Object.assign(clips, { numItems: clips.length }), transitions: { numItems: 0 }, isMuted: () => false, isLocked: () => false };
  const seq = { name: "Long show", sequenceID: "seq", end: tick(count * 2).ticks, videoTracks: Object.assign([track], { numTracks: 1 }), audioTracks: { numTracks: 0 } };
  const project = { activeSequence: seq, sequences: Object.assign([seq], { numSequences: 1 }) };
  vi.mocked(sendCommand).mockImplementation(async script => JSON.parse(String(runInNewContext(`${getHelpersSource()}\n${script}`, { app: { project } }))));
}
const readTools = ["get_active_sequence", "get_sequence_structure", "get_full_sequence_info", "get_timeline_gaps"] as const;
describe("bounded sequence reads", () => {
  it.each(readTools)("%s limits default payload and pages without duplicates", async name => {
    fixture();
    const first = await tools[name].handler({}) as any;
    expect(first.success).toBe(true);
    expect(first.data.pagination).toMatchObject({ totalClips: 800, matchingCount: 800, returned: 50, truncated: true, nextOffset: 50 });
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(25000);
    const second = await tools[name].handler({ clip_offset: 50, clip_limit: 10 }) as any;
    expect(second.data.pagination).toMatchObject({ returned: 10, nextOffset: 60 });
    const items = (data: any) => data.gaps ?? data.videoTracks.flatMap((t: any) => t.clips);
    expect(items(first.data)[0]).not.toEqual(items(second.data)[0]);
  });
  it.each(readTools)("%s filters overlapping windows and reports track counts", async name => {
    fixture();
    const value = await tools[name].handler({ start_seconds: 3.5, end_seconds: 7.5 }) as any;
    expect(value.data.pagination).toMatchObject({ matchingCount: name === "get_timeline_gaps" ? 2 : 3, truncated: false, nextOffset: null });
    const empty = await tools[name].handler({ track_type: "audio" }) as any;
    expect(empty.data.pagination).toMatchObject({ totalClips: 800, returned: 0 });
  });
  it.each(readTools)("%s rejects injection and invalid bounds before dispatch", async name => {
    vi.mocked(sendCommand).mockClear();
    for (const args of [{ track_type: 'video"; evil()' }, { clip_limit: 201 }, { clip_offset: -1 }, { start_seconds: NaN }, { start_seconds: 4, end_seconds: 3 }]) {
      await expect(tools[name].handler(args as never)).rejects.toThrow();
    }
    expect(sendCommand).not.toHaveBeenCalled();
  });
  it("shortens pages by payload size and resumes at the first omitted clip", async () => {
    fixture(100, "x".repeat(3000));
    const first = await tools.get_active_sequence.handler({}) as any;
    const returned = first.data.pagination.returned;
    expect(returned).toBeGreaterThan(0);
    expect(returned).toBeLessThan(50);
    const second = await tools.get_active_sequence.handler({ clip_offset: first.data.pagination.nextOffset }) as any;
    expect(second.data.videoTracks[0].clips[0].nodeId).toBe(`clip-${returned}`);
  });
});
