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
import { getTrackTargetingTools } from "../../src/tools/track-targeting.js";

const mockedSendCommand = vi.mocked(sendCommand);
const bridgeOptions: BridgeOptions = { tempDir: "/tmp/motion-units", timeoutMs: 5000 };
const tools = getTrackTargetingTools(bridgeOptions);
beforeEach(() => vi.clearAllMocks());

/** A 1920x1080 clip whose Motion uses Premiere 25.2's normalized Position and a renamed "Scale Height". */
function host(position: number[] = [0.5, 0.5], uniform = true, heightName = "Scale Height", withWidth = true) {
  const props: Record<string, unknown> = { Position: position, [heightName]: 100, ...(withWidth ? { "Scale Width": 100 } : {}), "Uniform Scale": uniform, "Anchor Point": [0.5, 0.5] };
  const list = Object.keys(props).map((displayName) => ({
    displayName,
    getValue: () => props[displayName],
    setValue: (v: unknown) => { props[displayName] = v; },
  }));
  const motion = { displayName: "Motion", properties: { numItems: list.length, ...list } };
  const clip = { nodeId: "c1", name: "Speaker", components: { numItems: 1, 0: motion }, projectItem: { getProjectMetadata: () => "<Column.Intrinsic.VideoInfo>1920 x 1080 (1.0)</Column.Intrinsic.VideoInfo>" } };
  const seq = { frameSizeHorizontal: 1920, frameSizeVertical: 1080, videoTracks: { numTracks: 1, 0: { clips: { numItems: 1, 0: clip } } }, audioTracks: { numTracks: 0 } };
  mockedSendCommand.mockImplementation(async (script: string) => JSON.parse(String(runInNewContext(`${getHelpersSource()}\n${script}`, { app: { project: { activeSequence: seq } } }))));
  return props;
}

describe("Motion units", () => {
  it("set_clip_position converts sequence pixels to normalized Position", async () => {
    const props = host();
    await expect(tools.set_clip_position.handler({ node_id: "c1", x: 1152, y: 540 })).resolves.toMatchObject({ success: true, data: { verified: true } });
    expect(props.Position).toEqual([0.6, 0.5]);
  });

  it("repairs a clip that was pushed off screen by a raw pixel write", async () => {
    const props = host([1152, 540]);
    await tools.set_clip_position.handler({ node_id: "c1", x: 960, y: 540 });
    expect(props.Position).toEqual([0.5, 0.5]);
  });

  it("set_clip_anchor_point converts source pixels to normalized Anchor Point", async () => {
    const props = host();
    await tools.set_clip_anchor_point.handler({ node_id: "c1", x: 480, y: 270 });
    expect(props["Anchor Point"]).toEqual([0.25, 0.25]);
  });

  it("set_clip_scale finds Scale after Premiere renamed it Scale Height (uniform scale back on)", async () => {
    const props = host();
    await expect(tools.set_clip_scale.handler({ node_id: "c1", scale: 120 })).resolves.toMatchObject({ success: true });
    expect(props["Scale Height"]).toBe(120);
  });

  it("scales both axes when Uniform Scale is off (live 25.2.3: Scale alone stretched the height)", async () => {
    const props = host([0.5, 0.5], false, "Scale");
    await expect(tools.set_clip_scale.handler({ node_id: "c1", scale: 120 })).resolves.toMatchObject({ success: true, data: { uniformScale: false, verified: true } });
    expect(props.Scale).toBe(120);
    expect(props["Scale Width"]).toBe(120);
  });

  it("refuses, changing nothing, when Uniform Scale is off and there is no Scale Width", async () => {
    const props = host([0.5, 0.5], false, "Scale", false);
    await expect(tools.set_clip_scale.handler({ node_id: "c1", scale: 120 })).resolves.toMatchObject({ success: false, error: expect.stringContaining("Scale Width") });
    expect(props.Scale).toBe(100);
  });

  it("fails when Premiere does not apply the scale", async () => {
    const props = host([0.5, 0.5], true, "Scale");
    Object.defineProperty(props, "Scale", { get: () => 100, set: () => {} });
    await expect(tools.set_clip_scale.handler({ node_id: "c1", scale: 120 })).resolves.toMatchObject({ success: false, error: expect.stringContaining("reads back as 100") });
  });
});
