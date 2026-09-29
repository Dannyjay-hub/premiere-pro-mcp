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
import { getTrackTools } from "../../src/tools/tracks.js";
import { getCompetitorGapTools } from "../../src/tools/competitor-gaps.js";

const mockedSendCommand = vi.mocked(sendCommand);
const bridgeOptions: BridgeOptions = { tempDir: "/tmp/test-bridge", timeoutMs: 5000 };

beforeEach(() => vi.clearAllMocks());

// Regexes inside TypeScript template literals need "\\s": a single "\s" is
// emitted as a literal "s" and the generated ExtendScript silently mismatches.
describe("regexes in generated ExtendScript keep their escapes", () => {
  it("reads a clip's own frame size from its VideoInfo metadata", () => {
    const clip = { projectItem: { getProjectMetadata: () => "<premierePrivateProjectMetaData:Column.Intrinsic.VideoInfo>3840 x 2160 (1.0)</x>" } };
    const seq = { frameSizeHorizontal: 1920, frameSizeVertical: 1080 };
    const size = runInNewContext(`${getHelpersSource()}\n__clipSourceFrameSize(clip, seq)`, { clip, seq, app: {} });
    expect(size).toEqual({ width: 3840, height: 2160 });
  });

  it("emits a whitespace-aware default track-name pattern in delete_track", async () => {
    await getTrackTools(bridgeOptions).delete_track.handler({ track_type: "video", track_index: 1 } as never);
    const script = String(mockedSendCommand.mock.calls[0][0]);
    expect(script).toContain("/^(.*[^0-9\\s])\\s*([0-9]+)$/");
  });
});

describe("set_clip_properties_batch scale with Uniform Scale off (#648 review)", () => {
  function host(uniform: boolean) {
    const values: Record<string, unknown> = { Scale: 100, "Scale Width": 100, "Uniform Scale": uniform };
    const prop = (displayName: string) => ({
      displayName,
      getValue: () => values[displayName],
      setValue: (value: unknown) => { values[displayName] = value; },
    });
    const props = [prop("Position"), prop("Scale"), prop("Scale Width"), prop("Uniform Scale")];
    const motion = { displayName: "Motion", matchName: "AE.ADBE Motion", properties: { numItems: props.length, ...props } };
    const clip = { nodeId: "clip-1", name: "A001", components: { numItems: 1, 0: motion } };
    const seq = { videoTracks: { numTracks: 1, 0: { clips: { numItems: 1, 0: clip } } }, audioTracks: { numTracks: 0 } };
    return { app: { project: { activeSequence: seq } }, values };
  }

  async function run(app: unknown) {
    await getCompetitorGapTools(bridgeOptions).set_clip_properties_batch.handler({ items: [{ node_id: "clip-1", scale: 110 }] } as never);
    const script = String(mockedSendCommand.mock.calls[0][0]);
    return JSON.parse(String(runInNewContext(`${getHelpersSource()}\n${script}`, { app })));
  }

  it("writes the width too so the picture is not stretched", async () => {
    const { app, values } = host(false);
    const result = await run(app);
    expect(result, JSON.stringify(result)).toMatchObject({ success: true });
    expect(values.Scale).toBe(110);
    expect(values["Scale Width"]).toBe(110);
  });

  it("leaves Scale Width alone when Uniform Scale is on", async () => {
    const { app, values } = host(true);
    const result = await run(app);
    expect(result.success).toBe(true);
    expect(values.Scale).toBe(110);
    expect(values["Scale Width"]).toBe(100);
  });
});
