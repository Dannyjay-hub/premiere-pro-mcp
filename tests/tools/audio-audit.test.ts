import { beforeEach, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { getHelpersSource } from "../../src/bridge/script-builder.js";
import { getAudioTools } from "../../src/tools/audio.js";
import { sendCommand } from "../../src/bridge/file-bridge.js";
vi.mock("../../src/bridge/file-bridge.js", () => ({ sendCommand: vi.fn() }));
const send = vi.mocked(sendCommand);
const tools = getAudioTools({ tempDir: "/tmp/audio-audit", timeoutMs: 5000 });
beforeEach(() => vi.resetAllMocks());
function muteHost(mode = "ok") {
  let state = false;
  let writes = 0;
  const track = { name: "Dialogue", isMuted() {
    if (mode === "unknown" || (mode === "unreadable" && writes)) return "unknown";
    return state;
  }, setMute: vi.fn((value) => {
    writes++;
    if (mode !== "noop") state = !!value;
    if (mode === "throw") throw Error("host failed after write");
  }) };
  send.mockImplementation(async (script) => JSON.parse(String(runInNewContext(getHelpersSource() + script, {
    app: { project: { activeSequence: { audioTracks: { 0: track, numTracks: 1 } } } },
  }))));
  return track;
}
it("reads mute and unmute back", async () => {
  muteHost();
  for (const muted of [true, false]) expect(await tools.mute_track.handler({ track_index: 0, muted })).toMatchObject({ success: true, data: { muted, verified: true, outcome: "verified" } });
});
it.each(["noop", "unreadable", "throw"])("does not claim mute success on %s", async (mode) => {
  const track = muteHost(mode);
  const result = await tools.mute_track.handler({ track_index: 0, muted: true });
  expect(result).toMatchObject({ success: false, data: { outcome: "committed_unverified" } });
  if (mode === "throw") expect(result).toMatchObject({ data: { timelineChanged: true } });
  expect(track.setMute).toHaveBeenCalledTimes(1);
});
it("refuses unknown pre-state without mutation", async () => {
  const track = muteHost("unknown");
  expect(await tools.mute_track.handler({ track_index: 0, muted: true })).toMatchObject({ success: false });
  expect(track.setMute).not.toHaveBeenCalled();
});
it.each([-1, 0.5, NaN, Infinity])("rejects index %s before dispatch", async (track_index) => {
  expect(await tools.mute_track.handler({ track_index, muted: true })).toMatchObject({ success: false });
  expect(send).not.toHaveBeenCalled();
});
it("refuses out-of-range tracks and nonboolean mute", async () => {
  const track = muteHost();
  expect(await tools.mute_track.handler({ track_index: 2, muted: true })).toMatchObject({ success: false });
  expect(track.setMute).not.toHaveBeenCalled();
  send.mockClear();
  expect(await tools.mute_track.handler({ track_index: 0, muted: "false" as never })).toMatchObject({ success: false });
  expect(send).not.toHaveBeenCalled();
});
