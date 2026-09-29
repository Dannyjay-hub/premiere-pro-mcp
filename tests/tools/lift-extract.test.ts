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
  lockedAudio?: boolean; untargetedAudio?: boolean; extractNoShift?: boolean;
}) {
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
    getInPoint: () => options.inSeconds,
    getOutPoint: () => options.outSeconds,
    videoTracks: Object.assign({ numTracks: 1 }, video),
    audioTracks: Object.assign({ numTracks: 1 }, audio),
  };
  const secondsOf = (time: { ticks: string }) => parseFloat(time.ticks) / TICKS;
  const cut = (ripple: boolean) => {
    const a = options.inSeconds, b = options.outSeconds;
    const shift = ripple && !options.extractNoShift ? b - a : 0;
    for (const track of all) {
      if (track.locked || !track.targeted) continue;
      const next: FakeClip[] = [];
      for (const clip of track.list) {
        const s = secondsOf(clip.start), e = secondsOf(clip.end);
        if (s >= b) { next.push({ ...clip, start: t(s - shift), end: t(e - shift) }); continue; }
        if (e <= a) { next.push(clip); continue; }
        if (s < a) next.push({ ...clip, end: t(a) });
        if (e > b) next.push({ nodeId: `piece${pieces++}`, name: clip.name, start: t(b - shift), end: t(e - shift) });
      }
      track.list.splice(0, track.list.length, ...next);
      track.sync();
    }
    seq.end = String(Math.max(...all.flatMap((track) => track.list.map((clip) => parseFloat(clip.end.ticks)))));
    return true;
  };
  const qeSeq: Record<string, unknown> = { extract: () => cut(true) };
  if (options.lift === "lift") qeSeq.lift = () => cut(false);
  if (options.lift === "left" || options.lift === undefined) qeSeq.left = () => cut(false);
  if (options.lift === "noop") qeSeq.left = () => true;
  run({
    app: { enableQE: () => {}, project: { activeSequence: seq } },
    qe: { project: { getActiveSequence: () => qeSeq } },
  });
  const spans = (track: { list: FakeClip[] }) => track.list.map((c) => [secondsOf(c.start), secondsOf(c.end)]);
  return { video, audio, seq, spans };
}

describe("lift_selection and extract_selection", () => {
  it("lifts through QE's misspelled left() and verifies the gap (live 25.2)", async () => {
    const host = inOutHost({ inSeconds: 30, outSeconds: 35 });
    const result = await utility.lift_selection.handler() as Result;
    expect(result).toMatchObject({ success: true, data: { lifted: true, gapSeconds: 5, tracksEdited: ["V1", "A1"], verified: true } });
    expect(host.spans(host.video[0])).toEqual([[0, 30], [35, 40], [40, 60]]);
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
});
