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
 * One 0-60 s clip per track at 25 fps. Premiere 25.2's QE sequence has no lift()
 * - the Lift command is exposed as left() - and extract() ripples the range out.
 */
function inOutHost(options: { inSeconds: number; outSeconds: number; lift?: "left" | "lift" | "noop"; lockedAudio?: boolean }) {
  const t = (seconds: number) => ({ ticks: String(Math.round(seconds * TICKS)) });
  const makeTrack = (locked = false) => {
    const list: Array<{ name: string; start: { ticks: string }; end: { ticks: string } }> = [{ name: "recap", start: t(0), end: t(60) }];
    const clipsView: Record<string | number, unknown> = {};
    Object.defineProperty(clipsView, "numItems", { get: () => list.length });
    const sync = () => list.forEach((clip, i) => { clipsView[i] = clip; });
    sync();
    return { list, sync, locked, isLocked: () => locked, clips: clipsView };
  };
  const video = [makeTrack()];
  const audio = [makeTrack(options.lockedAudio)];
  const all = [...video, ...audio];
  const seq = {
    timebase: String(TICKS / 25),
    end: String(60 * TICKS),
    getInPoint: () => options.inSeconds,
    getOutPoint: () => options.outSeconds,
    videoTracks: Object.assign({ numTracks: 1 }, video),
    audioTracks: Object.assign({ numTracks: 1 }, audio),
  };
  const stack = { index: 10 };
  const cut = (ripple: boolean) => {
    const a = options.inSeconds, b = options.outSeconds;
    for (const track of all) {
      if (track.locked) continue;
      const next: typeof track.list = [];
      for (const clip of track.list) {
        const s = parseFloat(clip.start.ticks) / TICKS, e = parseFloat(clip.end.ticks) / TICKS;
        if (s < a) next.push({ name: clip.name, start: t(s), end: t(Math.min(e, a)) });
        if (e > b) next.push({ name: clip.name, start: t(ripple ? Math.max(s, b) - (b - a) : Math.max(s, b)), end: t(ripple ? e - (b - a) : e) });
      }
      track.list.splice(0, track.list.length, ...next);
      track.sync();
    }
    seq.end = String(Math.max(...all.flatMap((track) => track.list.map((clip) => parseFloat(clip.end.ticks)))));
    stack.index += 1;
    return true;
  };
  const qeSeq: Record<string, unknown> = { extract: () => cut(true) };
  if (options.lift === "lift") qeSeq.lift = () => cut(false);
  if (options.lift === "left" || options.lift === undefined) qeSeq.left = () => cut(false);
  if (options.lift === "noop") qeSeq.left = () => true;
  run({
    app: { enableQE: () => {}, project: { activeSequence: seq } },
    qe: { project: { getActiveSequence: () => qeSeq, undoStackIndex: () => stack.index } },
  });
  return { video, audio, seq };
}

describe("lift_selection and extract_selection", () => {
  it("lifts through QE's misspelled left() and verifies the gap (live 25.2)", async () => {
    const host = inOutHost({ inSeconds: 30, outSeconds: 35 });
    const result = await utility.lift_selection.handler() as Result;
    expect(result).toMatchObject({ success: true, data: { lifted: true, gapSeconds: 5, verified: true} });
    expect(host.video[0].list.map((c) => [parseFloat(c.start.ticks) / TICKS, parseFloat(c.end.ticks) / TICKS])).toEqual([[0, 30], [35, 60]]);
  });

  it("fails when Premiere leaves clips inside the lifted range", async () => {
    inOutHost({ inSeconds: 30, outSeconds: 35, lift: "noop" });
    await expect(utility.lift_selection.handler()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("left clips inside the in/out range"),
    });
  });

  it("refuses to lift when no marks are set (cleared marks read 0..end)", async () => {
    const host = inOutHost({ inSeconds: 0, outSeconds: 60 });
    await expect(utility.lift_selection.handler()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("spans the whole sequence"),
    });
    expect(host.video[0].list).toHaveLength(1);
  });

  it("extracts and verifies the sequence shortened by the range", async () => {
    const host = inOutHost({ inSeconds: 50, outSeconds: 55 });
    await expect(utility.extract_selection.handler()).resolves.toMatchObject({
      success: true,
      data: { extracted: true, removedSeconds: 5, sequenceEndSeconds: 55, verified: true },
    });
    expect(parseFloat(host.seq.end) / TICKS).toBe(55);
  });

  it("does not demand a full ripple when a track is locked", async () => {
    inOutHost({ inSeconds: 50, outSeconds: 55, lockedAudio: true });
    await expect(utility.extract_selection.handler()).resolves.toMatchObject({
      success: true,
      data: { extracted: true, lockedTracksKept: true },
    });
  });
});
