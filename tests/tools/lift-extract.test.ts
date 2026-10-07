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
import { getUtilityTools } from "../../src/tools/utility.js";

const mockedSendCommand = vi.mocked(sendCommand);
const TICKS = 254016000000;
const bridgeOptions: BridgeOptions = { tempDir: "/tmp/lift-extract", timeoutMs: 5000 };
const utility = getUtilityTools(bridgeOptions);

type Result = { success: boolean; error?: string; data?: Record<string, unknown> };

beforeEach(() => vi.clearAllMocks());

function run(context: Record<string, unknown>) {
  mockedSendCommand.mockImplementation(async (script: string) =>
    JSON.parse(String(runInNewContext(`${getHelpersSource()}\n${script}`, context))));
}

/**
 * Two clips per track (0-40 s and 40-60 s) at 25 fps. Premiere 25.2's QE
 * sequence has no lift() - the Lift command is exposed as left() - and
 * extract() ripples the range out. Both act only on targeted, unlocked tracks.
 */
type FakeClip = { nodeId: string; name: string; start: { ticks: string }; end: { ticks: string } };
function inOutHost(options: {
  inSeconds: number; outSeconds: number; lift?: "left" | "lift" | "noop";
  lockedAudio?: boolean; untargetedAudio?: boolean; extractNoShift?: boolean; extractTouchesUntargeted?: boolean;
  dropVideoFrameBeforeIn?: boolean; videoUsesMarkFrames?: boolean; qeMarks?: boolean;
}) {
  const marks = { in: options.inSeconds, out: options.outSeconds };
  const t = (seconds: number) => ({ ticks: String(Math.round(seconds * TICKS)) });
  let pieces = 0;
  const makeTrack = (kind: string, locked = false, targeted = true) => {
    const list: FakeClip[] = [
      { nodeId: `${kind}-a`, name: "recap", start: t(0), end: t(40) },
      { nodeId: `${kind}-b`, name: "outro", start: t(40), end: t(60) },
    ];
    const clipsView: Record<string | number, unknown> = {};
    Object.defineProperty(clipsView, "numItems", { get: () => list.length });
    const sync = () => { for (const key of Object.keys(clipsView)) delete clipsView[key]; list.forEach((clip, i) => { clipsView[i] = clip; }); };
    sync();
    return { list, sync, locked, targeted, isLocked: () => locked, isTargeted: () => targeted, clips: clipsView };
  };
  const video = [makeTrack("v")];
  const audio = [makeTrack("a", options.lockedAudio, !options.untargetedAudio)];
  const all = [...video, ...audio];
  const seq = {
    timebase: String(TICKS / 25),
    end: String(60 * TICKS),
    getInPoint: () => marks.in,
    getOutPoint: () => marks.out,
    setInPoint: (seconds: number) => { marks.in = seconds; },
    setOutPoint: (seconds: number) => { marks.out = seconds; },
    videoTracks: Object.assign({ numTracks: 1 }, video),
    audioTracks: Object.assign({ numTracks: 1 }, audio),
  };
  const secondsOf = (time: { ticks: string }) => parseFloat(time.ticks) / TICKS;
  const cut = (ripple: boolean) => {
    const frame = 1 / 25;
    // Live 26.5.2: video is cut from the frame the In falls in through the frame
    // the Out falls in, and Extract ripples by whole frames of Out minus In.
    const videoIn = Math.floor(marks.in / frame + 1e-9) * frame;
    const videoOut = Math.ceil(marks.out / frame - 1e-9) * frame;
    const markShift = options.videoUsesMarkFrames ? Math.floor((marks.out - marks.in) / frame + 1e-9) * frame : marks.out - marks.in;
    const shift = ripple && !options.extractNoShift ? markShift : 0;
    for (const track of all) {
      if (track.locked || (!track.targeted && !(ripple && options.extractTouchesUntargeted))) continue;
      const a = options.videoUsesMarkFrames && video.includes(track) ? videoIn : marks.in;
      const b = options.videoUsesMarkFrames && video.includes(track) ? videoOut : marks.out;
      const next: FakeClip[] = [];
      for (const clip of track.list) {
        const s = secondsOf(clip.start), e = secondsOf(clip.end);
        if (s >= b) { next.push({ ...clip, start: t(s - shift), end: t(e - shift) }); continue; }
        if (e <= a) { next.push(clip); continue; }
        // Live 26.5.2: with a video transition on the cut before the in point,
        // QE lift/extract also removed that one-frame piece of video.
        const keepUntil = options.dropVideoFrameBeforeIn && video.includes(track) ? a - 1 / 25 : a;
        if (s < a) next.push({ ...clip, end: t(keepUntil) });
        if (e > b) next.push({ nodeId: `piece${pieces++}`, name: clip.name, start: t(b - shift), end: t(e - shift) });
      }
      track.list.splice(0, track.list.length, ...next);
      track.sync();
    }
    seq.end = String(Math.max(...all.flatMap((track) => track.list.map((clip) => parseFloat(clip.end.ticks)))));
    return true;
  };
  const qeSeq: Record<string, unknown> = { extract: () => cut(true) };
  if (options.qeMarks) {
    const parse = (timecode: string) => {
      const [h, m, sec, f] = timecode.split(/[:;]/).map(Number);
      return ((h * 60 + m) * 60 + sec) + f / 25;
    };
    qeSeq.setInPoint = (timecode: string) => { marks.in = parse(timecode); };
    qeSeq.setOutPoint = (timecode: string) => { marks.out = parse(timecode); };
  }
  if (options.lift === "lift") qeSeq.lift = () => cut(false);
  if (options.lift === "left" || options.lift === undefined) qeSeq.left = () => cut(false);
  if (options.lift === "noop") qeSeq.left = () => true;
  run({
    app: { enableQE: () => {}, project: { activeSequence: seq } },
    qe: { project: { getActiveSequence: () => qeSeq } },
  });
  const spans = (track: { list: FakeClip[] }) => track.list.map((c) => [secondsOf(c.start), secondsOf(c.end)]);
  return { video, audio, seq, spans, marks };
}

describe("lift_selection and extract_selection", () => {
  it.each([utility.lift_selection, utility.extract_selection])("refuses off-grid stored marks before the selection edit", async (tool) => {
    const host = inOutHost({ inSeconds: 30.01, outSeconds: 35 });
    const before = host.spans(host.video[0]);
    await expect(tool.handler()).resolves.toMatchObject({ success: false, error: expect.stringContaining("stored sequence in/out marks are off") });
    expect(host.spans(host.video[0])).toEqual(before);
  });

  it("lifts through QE's misspelled left() and verifies the gap (live 25.2)", async () => {
    const host = inOutHost({ inSeconds: 30, outSeconds: 35 });
    const result = await utility.lift_selection.handler() as Result;
    expect(result).toMatchObject({ success: true, data: { lifted: true, gapSeconds: 5, tracksEdited: ["V1", "A1"], verified: true } });
    expect(host.spans(host.video[0])).toEqual([[0, 30], [35, 40], [40, 60]]);
  });

  it.each([
    [utility.lift_selection, /lift removed more or less than the in\/out range: V1 holds/],
    [utility.extract_selection, /extract did not close the in\/out range as expected: V1 holds/],
  ])("reports a frame Premiere removed before the in point instead of verifying it", async (tool, message) => {
    const host = inOutHost({ inSeconds: 30, outSeconds: 35, dropVideoFrameBeforeIn: true });
    const result = await tool.handler() as Result;
    expect(result).toMatchObject({ success: false, data: { timelineChanged: true } });
    expect(result.error).toMatch(/^The timeline changed, but /);
    expect(result.error).toMatch(message);
    expect(host.spans(host.video[0])[0]).toEqual([0, 29.96]);
  });

  // Live 26.5.2 stores marks floored to 48 kHz samples, so a mark on a frame can read just before it.
  const flooredIn = Math.floor(30 * 48000 - 1) / 48000;
  const flooredOut = Math.floor(35 * 48000 - 1) / 48000;

  it.each([
    [utility.lift_selection, [[0, 30], [35, 40], [40, 60]]],
    [utility.extract_selection, [[0, 30], [30, 35], [35, 55]]],
  ])("re-writes marks stored just before a frame on the exact frame, then edits exactly", async (tool, expected) => {
    const host = inOutHost({ inSeconds: flooredIn, outSeconds: flooredOut, videoUsesMarkFrames: true, qeMarks: true });
    const result = await tool.handler() as Result;
    expect(result).toMatchObject({ success: true, data: { marksRewritten: true, verified: true } });
    expect(host.marks).toEqual({ in: 30, out: 35 });
    expect(host.spans(host.video[0])).toEqual(expected);
  });

  it.each([utility.lift_selection, utility.extract_selection])("reports the lost frame when QE cannot re-write the marks", async (tool) => {
    const host = inOutHost({ inSeconds: flooredIn, outSeconds: flooredOut, videoUsesMarkFrames: true });
    const result = await tool.handler() as Result;
    expect(result).toMatchObject({ success: false, data: { timelineChanged: true } });
    expect(result.error).toMatch(/V1 holds/);
    expect(host.spans(host.video[0])[0]).toEqual([0, 29.96]);
  });

  it("fails without claiming a change when Premiere's lift does nothing", async () => {
    inOutHost({ inSeconds: 30, outSeconds: 35, lift: "noop" });
    await expect(utility.lift_selection.handler()).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/^Nothing was changed: .*left clips inside the in\/out range/),
      data: { timelineChanged: false },
    });
  });

  it("only checks targeted tracks: an untargeted track keeping its clips is not a failure", async () => {
    const host = inOutHost({ inSeconds: 30, outSeconds: 35, untargetedAudio: true });
    await expect(utility.lift_selection.handler()).resolves.toMatchObject({ success: true, data: { tracksEdited: ["V1"] } });
    expect(host.spans(host.audio[0])).toEqual([[0, 40], [40, 60]]);
  });

  it("refuses when the range holds clips only on untargeted tracks, changing nothing", async () => {
    const host = inOutHost({ inSeconds: 30, outSeconds: 35 });
    host.video[0].targeted = false;
    host.audio[0].targeted = false;
    await expect(utility.lift_selection.handler()).resolves.toMatchObject({ success: false, error: expect.stringContaining("targeted") });
    expect(host.spans(host.video[0])).toEqual([[0, 40], [40, 60]]);
  });

  it("refuses to lift when no marks are set (cleared marks read 0..end)", async () => {
    const host = inOutHost({ inSeconds: 0, outSeconds: 60 });
    await expect(utility.lift_selection.handler()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("spans the whole sequence"),
    });
    expect(host.video[0].list).toHaveLength(2);
  });

  it("extracts and verifies each targeted track closed up by the range", async () => {
    const host = inOutHost({ inSeconds: 50, outSeconds: 55 });
    await expect(utility.extract_selection.handler()).resolves.toMatchObject({
      success: true,
      data: { extracted: true, removedSeconds: 5, sequenceEndSeconds: 55, verified: true },
    });
    expect(parseFloat(host.seq.end) / TICKS).toBe(55);
  });

  it("does not demand a ripple on a locked track", async () => {
    inOutHost({ inSeconds: 30, outSeconds: 35, lockedAudio: true });
    await expect(utility.extract_selection.handler()).resolves.toMatchObject({
      success: true,
      data: { extracted: true, lockedTracksKept: true, tracksEdited: ["V1"] },
    });
  });

  it("says the timeline changed when extract removes the range but does not close it", async () => {
    inOutHost({ inSeconds: 30, outSeconds: 35, extractNoShift: true });
    await expect(utility.extract_selection.handler()).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/^The timeline changed, but Premiere's extract did not close/),
      data: { timelineChanged: true },
    });
  });

  it("lists an untargeted track that Premiere's extract changed too (live 25.2.3: linked audio)", async () => {
    inOutHost({ inSeconds: 30, outSeconds: 35, untargetedAudio: true, extractTouchesUntargeted: true });
    await expect(utility.extract_selection.handler()).resolves.toMatchObject({
      success: true,
      data: { tracksEdited: ["V1"], otherTracksChanged: ["A1"] },
    });
  });

  it("reports no other tracks when only targeted tracks changed", async () => {
    inOutHost({ inSeconds: 30, outSeconds: 35, untargetedAudio: true });
    await expect(utility.lift_selection.handler()).resolves.toMatchObject({ success: true, data: { otherTracksChanged: [] } });
  });
});
