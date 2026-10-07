import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/bridge/file-bridge.js", () => ({ sendCommand: vi.fn() }));
import { sendCommand } from "../../src/bridge/file-bridge.js";
import { getHelpersSource } from "../../src/bridge/script-builder.js";
import { getPlayheadTools } from "../../src/tools/playhead.js";
import { getTrackTargetingTools } from "../../src/tools/track-targeting.js";
import { getTimelineTools } from "../../src/tools/timeline.js";
import { getAdvancedTools } from "../../src/tools/advanced.js";
import { getUtilityTools } from "../../src/tools/utility.js";
import { createHost2652, HostTime, FRAME_NTSC_23976, FRAME_NTSC_2997, TICKS } from "../helpers/premiere-26-5-2.js";
const options = { tempDir: "/tmp/host-rules", timeoutMs: 1000 };
const sent = vi.mocked(sendCommand);
const playhead = getPlayheadTools(options), targeting = getTrackTargetingTools(options);
const timeline = getTimelineTools(options), advanced = getAdvancedTools(options), utility = getUtilityTools(options);
type Host = ReturnType<typeof createHost2652>;
function install(host: Host) {
  sent.mockImplementation(async script => JSON.parse(String(runInNewContext(`${getHelpersSource()}\n${script}`, { app: host.app, Time: HostTime }))));
}
function expression(host: Host, script: string, extra = {}) { return runInNewContext(`${getHelpersSource()}\n${script}`, { app: host.app, Time: HostTime, ...extra }); }
beforeEach(() => { vi.clearAllMocks(); });
describe("shared 26.5.2 host rules and integration receipts", () => {
  it("floors sequence marks to 48 kHz and recognizes the unset sentinel", async () => {
    const host = createHost2652(); install(host);
    host.sequence.setInPoint(0.0333666666667);
    expect(Number(host.sequence.getInPoint())).toBe(Math.floor(0.0333666666667 * 48000) / 48000);
    host.sequence.setOutPoint(4);
    expect(await targeting.clear_sequence_in_out.handler({})).toMatchObject({ success: true, data: { verified: true, inSet: false, outSet: false, inSeconds: null, outSeconds: null } });
    expect(host.sequence.getInPoint()).toBe("-400000");
  });
  it("stores sequence marks on or after the requested NTSC frame", async () => {
    const host = createHost2652();
    host.sequence.setSettings({ ...host.sequence.getSettings(), videoFrameRate: new HostTime(FRAME_NTSC_2997) });
    host.addClip(host.addItem({ hasAudio: false }), { durationSeconds: 10, linked: false }); install(host);
    const input = FRAME_NTSC_2997 / TICKS, output = input * 10;
    expect(await playhead.set_sequence_in_out_points.handler({ in_seconds: input, out_seconds: output })).toMatchObject({ success: true, data: { verified: true } });
    expect(Number(host.sequence.getInPoint())).toBeGreaterThanOrEqual(input);
    expect(Number(host.sequence.getInPoint()) - input).toBeLessThan(1 / 48000);
    expect(Number(host.sequence.getOutPoint())).toBeGreaterThanOrEqual(output);
  });
  it("floors video marks to the media frame grid and reports applied seconds", async () => {
    const host = createHost2652(), item = host.addItem({ frameTicks: FRAME_NTSC_23976, hasAudio: false }); install(host);
    expect(await targeting.set_item_in_out.handler({ item_id: item.nodeId, in_seconds: 0.5, media_type: 1 })).toMatchObject({ success: true, data: { verified: true, requestedInSeconds: 0.5 } });
    const observed = item.getInPoint(1).seconds;
    expect(observed).toBeCloseTo(11 * FRAME_NTSC_23976 / TICKS, 10);
    expect(observed).toBeLessThan(0.5);
  });
  it("reads inclusive private metadata and restores it during replacement preflight", () => {
    const host = createHost2652(), item = host.addItem({ frameTicks: TICKS / 25, hasAudio: false, soft: true });
    expect(item.getInPoint(1).seconds).toBe(0); expect(item.getOutPoint(1).seconds).toBe(175.3417);
    const marks = expression(host, "__itemMarksForRestore(item, 1)", { item });
    expect(marks).toMatchObject({ inTicks: String(20*TICKS), outTicks: String(30*TICKS) });
    expect(item.getProjectMetadata()).toContain("00:00:29:24");
    expect(expression(host, `__itemAcceptsRange(item, "${22*TICKS}", "${24*TICKS}", 1, ${TICKS/25})`, { item })).toMatchObject({ ok: true, marksRestored: true });
    expect(item.getInPoint(1).seconds).toBe(20); expect(item.getOutPoint(1).seconds).toBe(30);
  });
  it("duplicates a soft subclip without restoring whole-media marks", async () => {
    const host = createHost2652(), item = host.addItem({ frameTicks: TICKS / 25, hasAudio: false, soft: true });
    const original = host.addClip(item, { startSeconds: 0, inSeconds: 20, outSeconds: 30, durationSeconds: 10, linked: false });
    host.addClip(item, { trackIndex: 1, startSeconds: 20, durationSeconds: 1, linked: false }).remove(); install(host);
    expect(await timeline.duplicate_clip.handler({ node_id: original.nodeId })).toMatchObject({ success: true, data: { verified: true, duplicated: true } });
    expect(item.getInPoint(1).seconds).toBe(20); expect(item.getOutPoint(1).seconds).toBe(30);
  });
  it("places audio on the matching track for a track-level A/V overwrite", () => {
    const host = createHost2652(), item = host.addItem({ hasVideo: true, hasAudio: true });
    const temporary = host.addClip(item, { trackIndex: 1, durationSeconds: 1 });
    temporary.remove(); host.audio[0].remove();
    host.sequence.videoTracks[1].overwriteClip(item, new HostTime(2*TICKS));
    expect(host.video).toHaveLength(1); expect(host.audio).toHaveLength(1);
    expect(host.video[0].trackIndex).toBe(1); expect(host.audio[0].trackIndex).toBe(1);
    expect(host.audio[0].start.seconds).toBe(2);
  });
  it("refuses A/V replacement before removing or overwriting anything", async () => {
    const host = createHost2652(), original = host.addClip(host.addItem({ hasAudio: false }), { durationSeconds: 10, linked: false });
    const replacement = host.addItem({ name: "Replacement A/V" }); install(host);
    expect(await timeline.replace_clip.handler({ node_id: original.nodeId, new_item_id: replacement.nodeId })).toMatchObject({ success: false, error: expect.stringContaining("also has audio") });
    expect(host.video).toEqual([original]); expect(host.audio).toHaveLength(0);
  });
  it("refuses incomplete linked selection and verifies a complete unlink", async () => {
    const host = createHost2652(), video = host.addClip(host.addItem(), { durationSeconds: 10 }), audio = host.audio[0]; install(host);
    video.setSelected(true);
    expect(host.sequence.unlinkSelection()).toBe(false);
    expect(await advanced.unlink_selection.handler()).toMatchObject({ success: false, data: { unselectedPartners: [audio.nodeId] } });
    expect(video.partners).toEqual([audio]);
    audio.setSelected(true);
    expect(await advanced.unlink_selection.handler()).toMatchObject({ success: true, data: { verified: true, outcome: "verified", unlinked: true } });
    expect(video.getLinkedItems()).toBeNull(); expect(audio.getLinkedItems()).toBeNull();
  });
  it("reports ignored work-area setters as failure and restores the disabled bar", async () => {
    const host = createHost2652(); install(host);
    expect(await playhead.set_work_area.handler({ in_seconds: 2, out_seconds: 8 })).toMatchObject({ success: false, data: { verified: false, outcome: "failed", barRestored: true } });
    expect(host.sequence.getWorkAreaInPoint()).toBe("0"); expect(host.sequence.getWorkAreaOutPoint()).toBe("10");
    expect(host.sequence.isWorkAreaEnabled()).toBe(false);
  });
  it("normalizes legacy display codes despite the host accepting arbitrary numbers", async () => {
    const host = createHost2652(); install(host);
    host.sequence.videoDisplayFormat = 2; expect(host.sequence.videoDisplayFormat).toBe(2);
    const time = new HostTime(4000 * FRAME_NTSC_2997), frame = new HostTime(FRAME_NTSC_2997);
    expect(time.getFormatted(frame, 2)).toBe("00:02:13:10");
    expect(time.getFormatted(frame, 102)).toBe("00;02;13;14");
    expect(await utility.set_sequence_display_format.handler({ video_display_format: 2, audio_display_format: 0 })).toMatchObject({ success: true, data: { verified: true, videoDisplayFormat: 102, audioDisplayFormat: 200 } });
    expect(await utility.set_sequence_display_format.handler({ video_display_format: 999 })).toMatchObject({ success: false });
    expect(host.sequence.videoDisplayFormat).toBe(102);
  });
  it("reports collateral clip movement caused by frame-rate changes", async () => {
    const host = createHost2652();
    host.sequence.setSettings({ ...host.sequence.getSettings(), videoFrameRate: new HostTime(FRAME_NTSC_2997) });
    const clip = host.addClip(host.addItem({ hasAudio: false }), { startSeconds: FRAME_NTSC_2997/TICKS, durationSeconds: 30*FRAME_NTSC_2997/TICKS, linked: false });
    const before = clip.start.seconds; install(host);
    expect(await utility.set_sequence_frame_rate.handler({ frame_rate: 25 })).toMatchObject({ success: true, data: { verified: true, clipsMoved: 1, clipsMissing: 0, movedClips: [expect.objectContaining({ startShiftSeconds: expect.any(Number) })] } });
    expect(clip.start.seconds).not.toBe(before); expect(clip.start.seconds).toBe(0.04);
  });
});
