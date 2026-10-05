import { describe, expect, it, vi, beforeEach } from "vitest";
import { runInNewContext } from "node:vm";
import { getHelpersSource } from "../../src/bridge/script-builder.js";
import { planRangeClip, rippleRemoveRangesScript, getRippleRemoveRangesTools, TimelineRange } from "../../src/tools/ripple-remove-ranges.js";
import { BridgeOptions, sendCommand } from "../../src/bridge/file-bridge.js";

vi.mock("../../src/bridge/file-bridge.js", () => ({ sendCommand: vi.fn(), getTempDir: vi.fn(() => "/tmp/test") }));
const bridge: BridgeOptions = { tempDir: "/tmp/ripple-range-tests", timeoutMs: 1500 };
const ranges: TimelineRange[] = Array.from({ length: 50 }, (_, i) => ({ start: i * 20, end: i * 20 + 2 }));
const TICKS = 254016000000;

function fakeTimeline(options: { clips: Array<{ id: string; start: number; end: number }>; locked?: boolean; frameRate?: number }) {
  let nextId = 0;
  let undoIndex = 0;
  const moveCalls = new Map<string, number>();
  const original = new Map(options.clips.map((clip) => [clip.id, { ...clip }]));
  const toTicks = (seconds: number) => String(Math.round(seconds * TICKS));
  const fromTicks = (time: { ticks: string }) => Number(time.ticks) / TICKS;
  const makeClip = (id: string, start: number, end: number) => ({
    nodeId: id, name: id, start: { ticks: toTicks(start) }, end: { ticks: toTicks(end) },
    move(delta: { ticks: string }) {
      moveCalls.set(id, (moveCalls.get(id) ?? 0) + 1);
      const amount = Number(delta.ticks);
      this.start.ticks = String(Number(this.start.ticks) + amount);
      this.end.ticks = String(Number(this.end.ticks) + amount);
      undoIndex++;
    },
    remove() {
      const index = list.findIndex((clip) => clip.nodeId === id);
      if (index >= 0) list.splice(index, 1);
      undoIndex++;
    },
  });
  const list: ReturnType<typeof makeClip>[] = [];
  for (const clip of options.clips) list.push(makeClip(clip.id, clip.start, clip.end));
  Object.defineProperty(list, "numItems", { get: () => list.length });
  let clipReads = 0;
  const clipsDom = new Proxy(list, { get(target, property, receiver) {
    if (typeof property === "string" && /^\d+$/.test(property)) clipReads++;
    return Reflect.get(target, property, receiver);
  } });
  const track = { clips: clipsDom, isLocked: () => options.locked === true };
  const qeTrack = {
    isLocked: () => options.locked === true,
    isSyncLocked: () => true,
    razor(timecode: string) {
      const [hh, mm, ss, ff] = timecode.split(":").map(Number);
      const cut = (((hh * 60 + mm) * 60 + ss) * 25 + ff) * TICKS / 25;
      for (let i = 0; i < list.length; i++) {
        const clip = list[i];
        const start = Number(clip.start.ticks), end = Number(clip.end.ticks);
        if (start < cut && end > cut) {
          const seconds = cut / TICKS;
          const left = makeClip(`${clip.nodeId}-razor-${++nextId}`, start / TICKS, seconds);
          const right = makeClip(`${clip.nodeId}-razor-${++nextId}`, seconds, end / TICKS);
          list.splice(i, 1, left, right);
          undoIndex++;
          i++;
        }
      }
    },
  };
  const sequence = {
    sequenceID: "fake-sequence",
    timebase: String(TICKS / (options.frameRate ?? 25)),
    videoTracks: Object.assign({ numTracks: 1 }, [track]),
    audioTracks: { numTracks: 0 },
  };
  const qeSequence = { getVideoTrackAt: () => qeTrack, getAudioTrackAt: () => qeTrack, getUndoStackIndex: () => undoIndex };
  const context = { app: { project: { activeSequence: sequence }, enableQE() {} }, qe: { project: { getActiveSequence: () => qeSequence, undoStackIndex: () => undoIndex } }, Time: class { ticks = "0"; } };
  const run = (script: string) => JSON.parse(String(runInNewContext(`${getHelpersSource()}\n${script}`, context))) as { success: boolean; data?: Record<string, any>; error?: string };
  return { run, moveCalls, list, original, fromTicks, get clipReads() { return clipReads; } };
}

describe("ripple_remove_timeline_ranges", () => {
  beforeEach(() => vi.mocked(sendCommand).mockReset());

  it("plans 1,500 clips across 50 removals with at most one move per survivor", () => {
    const clips = Array.from({ length: 1500 }, (_, i) => ({ nodeId: `c${i}`, start: i, end: i + 0.5 }));
    const moveCalls = new Map<string, number>();
    let removed = 0;
    for (const clip of clips) {
      const item = planRangeClip(clip, ranges, 0.001);
      if (item.removed) removed++;
      else if (item.shift > 0) moveCalls.set(item.nodeId, (moveCalls.get(item.nodeId) ?? 0) + 1);
    }
    const reference = (start: number) => ranges.filter((r) => r.end <= start).reduce((sum, r) => sum + r.end - r.start, 0);
    for (const clip of clips) {
      const actual = planRangeClip(clip, ranges, 0.001);
      expect(actual.shift).toBe(reference(clip.start));
      expect(actual.removed).toBe(ranges.some((r) => clip.start >= r.start - 0.001 && clip.end <= r.end + 0.001));
    }
    expect(removed).toBeGreaterThan(0);
    expect(Math.max(...moveCalls.values())).toBe(1);
  });

  it("runs the generated script against 1,500 fake clips and 50 ranges, moving each survivor once to reference positions", () => {
    const host = fakeTimeline({ clips: Array.from({ length: 1500 }, (_, i) => ({ id: `clip-${i}`, start: i, end: i + 1 })) });
    const args = { ranges, scope: "sync_locked" as const, range_content: "delete" as const, allow_large_ripple: true };
    const preview = host.run(rippleRemoveRangesScript(args, false));
    expect(preview.success).toBe(true);
    const fingerprint = String(preview.data?.timelineFingerprint);
    const applied = host.run(rippleRemoveRangesScript(args, true, fingerprint));
    expect(applied.success).toBe(true);
    expect(applied.data?.verified).toBe(true);
    expect(Math.max(...host.moveCalls.values())).toBe(1);
    for (const [id, original] of host.original) {
      const removed = ranges.some((range) => original.start >= range.start && original.end <= range.end);
      const actual = host.list.find((clip) => clip.nodeId === id);
      if (removed) expect(actual).toBeUndefined();
      else {
        const removedBefore = ranges.filter((range) => range.end <= original.start).reduce((sum, range) => sum + range.end - range.start, 0);
        expect(actual).toBeDefined();
        expect(host.fromTicks(actual!.start)).toBeCloseTo(original.start - removedBefore, 5);
        expect(host.fromTicks(actual!.end)).toBeCloseTo(original.end - removedBefore, 5);
      }
    }
    expect(applied.data?.estimatedSeconds).toBe(Math.ceil((applied.data!.clipsShifted * 0.15) + (applied.data!.clipsRemoved + 1) * 0.5));
  });

  it("precomputes razor spans with bounded DOM clip reads for 1,500 clips and 50 ranges", () => {
    const host = fakeTimeline({ clips: Array.from({ length: 1500 }, (_, i) => ({ id: `clip-${i}`, start: i, end: i + 1 })) });
    const testRanges = Array.from({ length: 50 }, (_, i) => ({ start: i * 20 + 0.5, end: i * 20 + 2.5 }));
    const args = { ranges: testRanges, scope: "sync_locked" as const, range_content: "delete" as const, allow_large_ripple: true };
    const preview = host.run(rippleRemoveRangesScript(args, false));
    expect(preview.success).toBe(true);
    const beforeApplyReads = host.clipReads;
    const applied = host.run(rippleRemoveRangesScript(args, true, String(preview.data?.timelineFingerprint)));
    expect(applied.success).toBe(true);
    expect(host.clipReads - beforeApplyReads).toBeLessThanOrEqual(5000);
  });

  it.each([23.976, 29.97])( "refuses non-integer frame rates before mutation (%s fps)", (frameRate) => {
    const host = fakeTimeline({ clips: [{ id: "clip", start: 0, end: 4 }], frameRate });
    const result = host.run(rippleRemoveRangesScript({ ranges: [{ start: 1, end: 2 }], scope: "sync_locked", range_content: "delete" }, false));
    expect(result.success).toBe(false);
    expect(result.error).toContain("integer frame rates only for now");
    expect(host.list).toHaveLength(1);
  });

  it("does not report frame-exact decimal ranges as adjustments", () => {
    const host = fakeTimeline({ clips: [{ id: "clip", start: 0, end: 3 }] });
    const result = host.run(rippleRemoveRangesScript({ ranges: [{ start: 1.08, end: 2.16 }], scope: "sync_locked", range_content: "delete" }, false));
    expect(result.success).toBe(true);
    expect(result.data?.adjustments).toEqual([]);
  });

  it("bounds preview samples, reports per-track counts, and returns undo steps from shared undo tracking", () => {
    const host = fakeTimeline({ clips: Array.from({ length: 100 }, (_, i) => ({ id: `clip-${i}`, start: i, end: i + 1 })) });
    const args = { ranges: [{ start: 10, end: 11 }], scope: "sync_locked" as const, range_content: "delete" as const };
    const preview = host.run(rippleRemoveRangesScript(args, false));
    expect(preview.data?.plannedClips).toHaveLength(50);
    expect(preview.data?.plannedClipsTruncated).toBe(true);
    expect(preview.data?.plannedClipsTotal).toBeGreaterThan(50);
    expect(preview.data?.trackCounts).toHaveProperty("video:0");
    const applied = host.run(rippleRemoveRangesScript(args, true, String(preview.data?.timelineFingerprint)));
    expect(applied.success).toBe(true);
    expect(applied.data?.undoSteps).toBeGreaterThan(0);
    expect(applied.data?.undoStackIndex).toBe(applied.data?.undoSteps);
  });

  it("handles sequence start, adjacent intervals, and a clip fully inside a range", () => {
    const adjacent = [{ start: 0, end: 1 }, { start: 1, end: 2 }];
    expect(planRangeClip({ nodeId: "whole", start: 0, end: 2 }, adjacent, 0.001)).toMatchObject({ removed: true, shift: 0 });
    expect(planRangeClip({ nodeId: "after", start: 2, end: 3 }, adjacent, 0.001)).toMatchObject({ removed: false, shift: 2 });
  });

  it("executes adjacent ranges at sequence start and deletes the full clip in the fake host", () => {
    const host = fakeTimeline({ clips: [{ id: "whole", start: 0, end: 2 }, { id: "after", start: 2, end: 3 }] });
    const args = { ranges: [{ start: 0, end: 1 }, { start: 1, end: 2 }], scope: "sync_locked" as const, range_content: "delete" as const };
    const preview = host.run(rippleRemoveRangesScript(args, false));
    const applied = host.run(rippleRemoveRangesScript(args, true, String(preview.data?.timelineFingerprint)));
    expect(applied.success).toBe(true);
    expect(host.list.map((clip) => clip.nodeId)).toEqual(["after"]);
    expect(host.fromTicks(host.list[0].start)).toBeCloseTo(0, 5);
    expect(host.moveCalls.get("after")).toBe(1);
  });

  it("refuses a locked participating track before razor, removal, or move", () => {
    const host = fakeTimeline({ clips: [{ id: "before", start: 0, end: 1 }, { id: "inside", start: 1, end: 2 }, { id: "after", start: 2, end: 3 }], locked: true });
    const result = host.run(rippleRemoveRangesScript({ ranges: [{ start: 1, end: 2 }], scope: "sync_locked", range_content: "delete" }, false));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/must be readable, unlocked, and sync-locked/);
    expect(host.list).toHaveLength(3);
    expect(host.moveCalls.size).toBe(0);
  });

  it("refuses partial clip overlap in the shared planner", () => {
    expect(() => planRangeClip({ nodeId: "straddler", start: 0.5, end: 2.5 }, [{ start: 1, end: 2 }], 0.001)).toThrow(/partially overlaps/);
  });

  it("emits edit-authority script with lock checks, frame snapping, fingerprint revalidation, and one move call", () => {
    const script = rippleRemoveRangesScript({ ranges: [{ start: 1, end: 2 }], scope: "sync_locked", range_content: "delete", allow_large_ripple: false }, true, "123");
    expect(script).toContain("isSyncLocked");
    expect(script).toContain("isLocked");
    expect(script).toContain("Timeline changed since preview");
    expect(script).toContain("clip.move(delta)");
    expect(script).toContain("summary.plannedClips.push");
    expect(script).toContain("Large ripple refused before mutation");
  });

  it("requires a preview token and rejects overlapping/unsorted ranges before dispatch", async () => {
    const tool = getRippleRemoveRangesTools(bridge).ripple_remove_timeline_ranges;
    const invalid = await tool.handler({ ranges: [{ start: 2, end: 3 }, { start: 1, end: 2.5 }], scope: "sync_locked", range_content: "delete" });
    expect(invalid.success).toBe(false);
    expect(sendCommand).not.toHaveBeenCalled();
    const denied = await tool.handler({ ranges: [{ start: 1, end: 2 }], scope: "sync_locked", range_content: "delete", dry_run: false });
    expect(denied.success).toBe(false);
    expect(denied.error).toMatch(/confirmation_token/);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("returns a full dry-run plan and applies only once with fingerprint and scaled timeout", async () => {
    vi.mocked(sendCommand).mockResolvedValueOnce({ success: true, data: { timelineFingerprint: "fingerprint", plannedClips: [{ nodeId: "clip" }], clipsShifted: 1500 } });
    vi.mocked(sendCommand).mockResolvedValueOnce({ success: true, data: { timelineFingerprint: "fingerprint", clipsShifted: 1500 } });
    vi.mocked(sendCommand).mockResolvedValueOnce({ success: true, data: { verified: true } });
    const tool = getRippleRemoveRangesTools(bridge).ripple_remove_timeline_ranges;
    const args = { ranges: [{ start: 1, end: 2 }], scope: "sync_locked" as const, range_content: "delete" as const, allow_large_ripple: true };
    const preview = await tool.handler(args);
    const token = (preview.data as { confirmationToken: string }).confirmationToken;
    expect((preview.data as { plannedClips: unknown[] }).plannedClips).toHaveLength(1);
    const applied = await tool.handler({ ...args, dry_run: false, confirmation_token: token, allow_large_ripple: true });
    expect(applied.success).toBe(true);
    expect(sendCommand).toHaveBeenCalledTimes(3);
    expect(vi.mocked(sendCommand).mock.calls[2][1]).toMatchObject({ timeoutMs: 630000, mutationOnTimeout: true });
    await expect(tool.handler({ ...args, dry_run: false, confirmation_token: token, allow_large_ripple: true })).resolves.toMatchObject({ success: false });
  });
});
