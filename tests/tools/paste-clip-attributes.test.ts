import { beforeEach, describe, expect, it, vi } from "vitest";
import { createContext, runInContext } from "node:vm";
import { getHelpersSource } from "../../src/bridge/script-builder.js";

vi.mock("../../src/bridge/file-bridge.js", () => ({
  sendCommand: vi.fn(),
}));

import { sendCommand } from "../../src/bridge/file-bridge.js";
import { getClipboardTools } from "../../src/tools/clipboard.js";
import {
  capabilityForTool,
  guardToolHandler,
  isToolPermitted,
  resolveCapabilities,
} from "../../src/security/capabilities.js";

const mockedSendCommand = vi.mocked(sendCommand);
const bridgeOptions = { tempDir: "/tmp/test-bridge", timeoutMs: 5_000 };
const TICKS_PER_SECOND = 254016000000;

class MockTime {
  ticks = "0";
}

type Value = unknown;

/** A ComponentParam mock that stores static values and keyframes by tick string. */
function makeProp(displayName: string, value: Value, options: {
  keys?: Array<[number, Value]>;
  ignoreWrites?: boolean;
  throwOnGet?: boolean;
  /** [alpha, red, green, blue]: a colour parameter, measured on Premiere 25.2. */
  color?: number[];
} = {}) {
  let current = value;
  let color = options.color ? [...options.color] : null;
  let timeVarying = Boolean(options.keys);
  const keys = new Map<string, Value>();
  for (const [ticks, keyValue] of options.keys ?? []) keys.set(String(ticks), keyValue);
  return {
    displayName,
    getValue: vi.fn(() => {
      if (options.throwOnGet) throw new Error("opaque");
      return current;
    }),
    setValue: vi.fn((next: Value) => {
      if (options.ignoreWrites) return;
      current = next;
      // Premiere's packed colour number is above 2^53, so writing it back stores another colour.
      if (color) color = [0, 0, 255, 255];
    }),
    getColorValue: vi.fn(() => {
      if (!color) throw new Error("Unknown error exception");
      return [...color];
    }),
    setColorValue: vi.fn((alpha: number, red: number, green: number, blue: number) => {
      if (!color) throw new Error("Unknown error exception");
      color = [alpha, red, green, blue];
    }),
    isTimeVarying: () => timeVarying,
    setTimeVarying: vi.fn((next: boolean) => {
      if (!next) keys.clear();
      timeVarying = next;
    }),
    areKeyframesSupported: () => true,
    getKeys: () => [...keys.keys()].map((ticks) => Object.assign(new MockTime(), { ticks })),
    getValueAtKey: (time: MockTime) => keys.get(String(time.ticks)),
    addKey: vi.fn((time: MockTime) => { keys.set(String(time.ticks), undefined); }),
    setValueAtKey: vi.fn((time: MockTime, next: Value) => { keys.set(String(time.ticks), next); }),
    keyMap: keys,
  };
}

function collection<T>(items: T[]) {
  Object.defineProperty(items, "numItems", { get: () => items.length });
  return items as T[] & { numItems: number };
}

function makeComponent(displayName: string, matchName: string, props: ReturnType<typeof makeProp>[]) {
  return { displayName, matchName, properties: collection(props) };
}

function makeClip(nodeId: string, name: string, inSeconds: number, startSeconds: number, components: ReturnType<typeof makeComponent>[]) {
  return {
    nodeId,
    name,
    inPoint: { ticks: String(inSeconds * TICKS_PER_SECOND) },
    start: { ticks: String(startSeconds * TICKS_PER_SECOND) },
    components: collection(components),
  };
}

async function scriptFor(args: Record<string, unknown>) {
  mockedSendCommand.mockResolvedValueOnce({ success: true, data: {} } as never);
  await getClipboardTools(bridgeOptions).paste_clip_attributes.handler(args as never);
  expect(mockedSendCommand).toHaveBeenCalledTimes(1);
  return String(mockedSendCommand.mock.calls[0][0]);
}

/**
 * Build the mocked host inside a VM context so arrays created for parameter
 * values satisfy the script's `instanceof Array` checks.
 */
function makeHost(build: (vmArray: (values: number[]) => number[]) => {
  source: ReturnType<typeof makeClip>;
  target: ReturnType<typeof makeClip>;
  targetTrack?: "video" | "audio";
  effectCatalog?: Record<string, () => ReturnType<typeof makeComponent>>;
}) {
  const context = createContext({ Time: MockTime });
  const vmArray = runInContext("(function (values) { return Array.prototype.slice.call(values); })", context) as (values: number[]) => number[];
  const { source, target, targetTrack = "video", effectCatalog = {} } = build(vmArray);
  const videoClips = targetTrack === "video" ? [source, target] : [source];
  const audioClips = targetTrack === "audio" ? [target] : [];
  const qeClip = {
    type: "Clip",
    start: target.start,
    addVideoEffect: vi.fn((effect: { name: string }) => { target.components.push(effectCatalog[effect.name]()); }),
    addAudioEffect: vi.fn(),
  };
  context.app = {
    enableQE: vi.fn(),
    project: {
      activeSequence: {
        videoTracks: collection([{ clips: collection(videoClips) }]) as unknown as { numTracks: number },
        audioTracks: collection([{ clips: collection(audioClips) }]) as unknown as { numTracks: number },
      },
    },
  };
  context.app.project.activeSequence.videoTracks.numTracks = 1;
  context.app.project.activeSequence.audioTracks.numTracks = 1;
  context.qe = {
    project: {
      getActiveSequence: () => ({
        getVideoTrackAt: () => ({ numItems: 1, getItemAt: () => qeClip }),
        getAudioTrackAt: () => ({ numItems: 0, getItemAt: () => null }),
      }),
      getVideoEffectByName: (name: string) => (effectCatalog[name] ? { name } : null),
      getAudioEffectByName: () => null,
    },
  };
  return { context, qeClip, source, target };
}

async function run(host: ReturnType<typeof makeHost>, args: Record<string, unknown>) {
  let hostResult: unknown;
  mockedSendCommand.mockImplementationOnce(async (script: string) => {
    hostResult = JSON.parse(runInContext(getHelpersSource() + "\n" + script, host.context) as string);
    return hostResult as never;
  });
  const result = await getClipboardTools(bridgeOptions).paste_clip_attributes.handler(args as never);
  return { result: result as any, hostResult: hostResult as any };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedSendCommand.mockReset();
});

describe("paste_clip_attributes", () => {
  it("copies intrinsic values, keyframes, and a QE-applied effect with per-property readback", async () => {
    const host = makeHost((vmArray) => {
      const source = makeClip("src", "Source", 2, 0, [
        makeComponent("Motion", "AE.ADBE Motion", [
          makeProp("Position", vmArray([100, 200])),
          makeProp("Scale", 100, { keys: [[2 * TICKS_PER_SECOND, 100], [3 * TICKS_PER_SECOND, 150]] }),
        ]),
        makeComponent("Opacity", "AE.ADBE Opacity", [makeProp("Opacity", 80), makeProp("Blend Mode", 1)]),
        makeComponent("Gaussian Blur", "AE.ADBE Gaussian Blur 2", [makeProp("Blurriness", 20), makeProp("Repeat Edge Pixels", true)]),
      ]);
      const target = makeClip("tgt", "Target", 5, 10, [
        makeComponent("Motion", "AE.ADBE Motion", [makeProp("Position", vmArray([960, 540])), makeProp("Scale", 100)]),
        makeComponent("Opacity", "AE.ADBE Opacity", [makeProp("Opacity", 100), makeProp("Blend Mode", 1)]),
      ]);
      return {
        source,
        target,
        effectCatalog: {
          "Gaussian Blur": () => makeComponent("Gaussian Blur", "AE.ADBE Gaussian Blur 2", [makeProp("Blurriness", 0), makeProp("Repeat Edge Pixels", false)]),
        },
      };
    });

    const { result } = await run(host, { source_node_id: "src", target_node_id: "tgt" });

    expect(result.success).toBe(true);
    expect(result.data.status).toBe("verified");
    expect(result.data.summary).toMatchObject({ failed: 0, notCopied: 0, unchanged: 1, written: 5 });
    expect(result.data.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: "Gaussian Blur", action: "applied_via_qe", status: "ok" }),
      expect.objectContaining({ component: "Motion", action: "matched_existing" }),
    ]));
    expect(host.qeClip.addVideoEffect).toHaveBeenCalledTimes(1);
    expect(result.data.masks).toMatchObject({ copied: false, detectable: false });

    const targetMotion = host.target.components[0];
    expect([...targetMotion.properties[0].getValue() as number[]]).toEqual([100, 200]);
    // Source keys at 2s/3s with a 2s in point land at 5s/6s on a target whose in point is 5s.
    const scale = targetMotion.properties[1] as ReturnType<typeof makeProp>;
    expect([...scale.keyMap.entries()]).toEqual([
      [String(5 * TICKS_PER_SECOND), 100],
      [String(6 * TICKS_PER_SECOND), 150],
    ]);
    const scaleEntry = result.data.properties.find((entry: any) => entry.property === "Scale");
    expect(scaleEntry).toMatchObject({ kind: "keyframes", keyframes: 2, status: "verified", interpolation: "not_copied" });
    expect(host.target.components[2].properties[0].getValue()).toBe(20);
    expect(host.target.components[2].properties[1].getValue()).toBe(true);
  });

  it("reports a partial paste instead of success when values are refused, opaque, or fail readback", async () => {
    const host = makeHost(() => {
      const source = makeClip("src", "Source", 0, 0, [
        makeComponent("Opacity", "AE.ADBE Opacity", [makeProp("Opacity", 50), makeProp("Blend Mode", 4)]),
        makeComponent("Lumetri Color", "AE.ADBE Lumetri", [makeProp("Exposure", 1.5), makeProp("RGB Curves", {}), makeProp("Hidden", 0, { throwOnGet: true })]),
      ]);
      const blendMode = makeProp("Blend Mode", 1);
      const target = makeClip("tgt", "Target", 0, 10, [
        makeComponent("Opacity", "AE.ADBE Opacity", [makeProp("Opacity", 100), blendMode]),
        makeComponent("Lumetri Color", "AE.ADBE Lumetri", [makeProp("Exposure", 0, { ignoreWrites: true }), makeProp("RGB Curves", {}), makeProp("Hidden", 0)]),
      ]);
      return { source, target };
    });

    const { result } = await run(host, { source_node_id: "src", target_node_id: "tgt" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("only partially applied");
    expect(result.error).toContain("Masks are never copied");
    expect(result.data.status).toBe("partial");
    expect(result.data.summary).toMatchObject({ verified: 1, failed: 1, notCopied: 3 });
    expect(result.data.notCopied).toEqual(expect.arrayContaining([
      expect.objectContaining({ property: "Blend Mode", reason: expect.stringContaining("issue #243") }),
      expect.objectContaining({ property: "RGB Curves", reason: expect.stringContaining("masks, curves") }),
      expect.objectContaining({ property: "Hidden" }),
    ]));
    expect(result.data.properties).toEqual(expect.arrayContaining([
      expect.objectContaining({ property: "Exposure", status: "failed" }),
    ]));
    // Blend Mode is never written through the generic enum setter.
    expect(host.target.components[0].properties[1].setValue).not.toHaveBeenCalled();
  });

  it("copies colour parameters through setColorValue instead of the lossy packed number", async () => {
    const host = makeHost(() => {
      const source = makeClip("src", "Source", 0, 0, [
        makeComponent("Lumetri Color", "AE.ADBE Lumetri", [
          makeProp("White Balance", 18374897589125431000, { color: [255, 192, 192, 192] }),
          makeProp("Exposure", 0.5),
        ]),
      ]);
      const target = makeClip("tgt", "Target", 0, 10, [
        makeComponent("Lumetri Color", "AE.ADBE Lumetri", [
          makeProp("White Balance", 18374945405898452000, { color: [255, 200, 180, 160] }),
          makeProp("Exposure", 0),
        ]),
      ]);
      return { source, target };
    });

    const { result } = await run(host, { source_node_id: "src", target_node_id: "tgt", components: ["Lumetri Color"] });

    expect(result.success).toBe(true);
    expect(result.data.summary).toMatchObject({ verified: 2, failed: 0, written: 2 });
    const whiteBalance = host.target.components[0].properties[0];
    expect(whiteBalance.setValue).not.toHaveBeenCalled();
    expect(whiteBalance.setColorValue).toHaveBeenCalledWith(255, 192, 192, 192, true);
    expect(whiteBalance.getColorValue()).toEqual([255, 192, 192, 192]);
    expect(result.data.properties).toEqual(expect.arrayContaining([
      expect.objectContaining({ property: "White Balance", kind: "color", action: "written", status: "verified" }),
    ]));
  });

  it("leaves a matching colour unchanged and refuses keyframed colours without writing", async () => {
    const host = makeHost(() => {
      const source = makeClip("src", "Source", 0, 0, [
        makeComponent("Lumetri Color", "AE.ADBE Lumetri", [
          makeProp("White Balance", 1, { color: [255, 192, 192, 192] }),
          makeProp("Fill", 1, { color: [255, 10, 20, 30], keys: [[0, 1], [TICKS_PER_SECOND, 2]] }),
        ]),
      ]);
      const target = makeClip("tgt", "Target", 0, 10, [
        makeComponent("Lumetri Color", "AE.ADBE Lumetri", [
          makeProp("White Balance", 1, { color: [255, 192, 192, 192] }),
          makeProp("Fill", 1, { color: [255, 0, 0, 0] }),
        ]),
      ]);
      return { source, target };
    });

    const { result } = await run(host, { source_node_id: "src", target_node_id: "tgt", components: ["Lumetri Color"] });

    expect(result.success).toBe(false);
    expect(result.data.summary).toMatchObject({ verified: 1, unchanged: 1, notCopied: 1 });
    expect(result.data.notCopied).toEqual([
      expect.objectContaining({ property: "Fill", reason: expect.stringContaining("colour parameter is keyframed") }),
    ]);
    const [whiteBalance, fill] = host.target.components[0].properties;
    expect(whiteBalance.setColorValue).not.toHaveBeenCalled();
    expect(fill.setColorValue).not.toHaveBeenCalled();
    expect(fill.setValue).not.toHaveBeenCalled();
    expect(fill.getColorValue()).toEqual([255, 0, 0, 0]);
  });

  it("copy_effect_values writes colour parameters through setColorValue", async () => {
    const host = makeHost(() => {
      const source = makeClip("src", "Source", 0, 0, [
        makeComponent("Lumetri Color", "AE.ADBE Lumetri", [makeProp("White Balance", 1, { color: [255, 192, 192, 192] }), makeProp("Exposure", 0.5)]),
      ]);
      const target = makeClip("tgt", "Target", 0, 10, [
        makeComponent("Lumetri Color", "AE.ADBE Lumetri", [makeProp("White Balance", 2, { color: [255, 200, 180, 160] }), makeProp("Exposure", 0)]),
      ]);
      return { source, target };
    });
    mockedSendCommand.mockImplementationOnce(async (script: string) =>
      JSON.parse(runInContext(getHelpersSource() + "\n" + script, host.context) as string) as never);

    const result = await getClipboardTools(bridgeOptions).copy_effect_values.handler({
      source_node_id: "src", target_node_id: "tgt", effect_name: "Lumetri Color",
    }) as any;

    expect(result).toMatchObject({ success: true, data: { copiedProperties: 2, verified: true } });
    const whiteBalance = host.target.components[0].properties[0];
    expect(whiteBalance.setValue).not.toHaveBeenCalled();
    expect(whiteBalance.getColorValue()).toEqual([255, 192, 192, 192]);
  });

  it("copy_effect_values matches repeated display names by position and skips section headers", async () => {
    const host = makeHost(() => {
      const source = makeClip("src", "Source", 0, 0, [
        makeComponent("Lumetri Color", "AE.ADBE Lumetri", [
          makeProp("Basic Correction", undefined),
          makeProp("Saturation", 120),
          makeProp("Creative", undefined),
          makeProp("Intensity", 50),
          makeProp("Saturation", 100),
          makeProp("Vignette", undefined),
          makeProp("Intensity", 100),
        ]),
      ]);
      const target = makeClip("tgt", "Target", 0, 10, [
        makeComponent("Lumetri Color", "AE.ADBE Lumetri", [
          makeProp("Basic Correction", undefined),
          makeProp("Saturation", 100),
          makeProp("Creative", undefined),
          makeProp("Intensity", 100),
          makeProp("Saturation", 100),
          makeProp("Vignette", undefined),
          makeProp("Intensity", 100),
        ]),
      ]);
      return { source, target };
    });
    mockedSendCommand.mockImplementationOnce(async (script: string) =>
      JSON.parse(runInContext(getHelpersSource() + "\n" + script, host.context) as string) as never);

    const result = await getClipboardTools(bridgeOptions).copy_effect_values.handler({
      source_node_id: "src", target_node_id: "tgt", effect_name: "Lumetri Color",
    }) as any;

    expect(result).toMatchObject({ success: true, data: { copiedProperties: 4, verified: true } });
    const props = host.target.components[0].properties;
    expect(props.map((prop) => prop.getValue())).toEqual([undefined, 120, undefined, 50, 100, undefined, 100]);
    // Already-equal values and section headers are never written.
    expect(props[0].setValue).not.toHaveBeenCalled();
    expect(props[4].setValue).not.toHaveBeenCalled();
    expect(props[6].setValue).not.toHaveBeenCalled();
  });

  it("honors components, copy_keyframes=false, and apply_missing_effects=false without applying effects", async () => {
    const host = makeHost(() => {
      const source = makeClip("src", "Source", 0, 0, [
        makeComponent("Motion", "AE.ADBE Motion", [makeProp("Scale", 100, { keys: [[0, 100], [TICKS_PER_SECOND, 120]] })]),
        makeComponent("Time Remapping", "AE.ADBE Time Remapping", [makeProp("Speed", 50)]),
        makeComponent("Gaussian Blur", "AE.ADBE Gaussian Blur 2", [makeProp("Blurriness", 20)]),
      ]);
      const target = makeClip("tgt", "Target", 0, 10, [
        makeComponent("Motion", "AE.ADBE Motion", [makeProp("Scale", 100)]),
        makeComponent("Time Remapping", "AE.ADBE Time Remapping", [makeProp("Speed", 100)]),
      ]);
      return { source, target, effectCatalog: { "Gaussian Blur": () => makeComponent("Gaussian Blur", "AE.ADBE Gaussian Blur 2", []) } };
    });

    const { result } = await run(host, {
      source_node_id: "src", target_node_id: "tgt", copy_keyframes: false, apply_missing_effects: false,
    });

    expect(result.success).toBe(false);
    expect(result.data.status).toBe("failed");
    expect(host.qeClip.addVideoEffect).not.toHaveBeenCalled();
    expect(result.data.skippedComponents).toEqual([
      expect.objectContaining({ component: "Time Remapping", reason: expect.stringContaining("changes clip timing") }),
    ]);
    expect(result.data.notCopied).toEqual(expect.arrayContaining([
      expect.objectContaining({ property: "Scale", reason: expect.stringContaining("copy_keyframes is false") }),
      expect.objectContaining({ component: "Gaussian Blur", reason: expect.stringContaining("apply_missing_effects is false") }),
    ]));
    expect(host.target.components[1].properties[0].getValue()).toBe(100);

    const filtered = makeHost(() => ({
      source: makeClip("src", "Source", 0, 0, [
        makeComponent("Opacity", "AE.ADBE Opacity", [makeProp("Opacity", 40)]),
        makeComponent("Time Remapping", "AE.ADBE Time Remapping", [makeProp("Speed", 50)]),
      ]),
      target: makeClip("tgt", "Target", 0, 10, [
        makeComponent("Opacity", "AE.ADBE Opacity", [makeProp("Opacity", 100)]),
        makeComponent("Time Remapping", "AE.ADBE Time Remapping", [makeProp("Speed", 100)]),
      ]),
    }));
    const onlyTimeRemap = await run(filtered, { source_node_id: "src", target_node_id: "tgt", components: ["Time Remapping"] });
    expect(onlyTimeRemap.result).toMatchObject({ success: true, data: { status: "verified" } });
    expect(filtered.target.components[0].properties[0].getValue()).toBe(100);
    expect(filtered.target.components[1].properties[0].getValue()).toBe(50);
  });

  it("refuses clips on different track types without changing anything", async () => {
    const host = makeHost(() => ({
      source: makeClip("src", "Source", 0, 0, [makeComponent("Opacity", "AE.ADBE Opacity", [makeProp("Opacity", 40)])]),
      target: makeClip("tgt", "Target", 0, 0, [makeComponent("Volume", "AE.ADBE Volume", [makeProp("Level", 0)])]),
      targetTrack: "audio",
    }));
    const { result } = await run(host, { source_node_id: "src", target_node_id: "tgt" });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("same track type") });
  });

  it("validates arguments before contacting Premiere", async () => {
    const tool = getClipboardTools(bridgeOptions).paste_clip_attributes;
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ source_node_id: "", target_node_id: "b" }, "source_node_id"],
      [{ source_node_id: "a", target_node_id: "a" }, "different clips"],
      [{ source_node_id: "a", target_node_id: "b", components: [] }, "components"],
      [{ source_node_id: "a", target_node_id: "b", components: ["Motion", "Motion"] }, "duplicate"],
      [{ source_node_id: "a", target_node_id: "b", components: [""] }, "components entry"],
      [{ source_node_id: "a", target_node_id: "b", copy_keyframes: "yes" }, "copy_keyframes"],
      [{ source_node_id: "a", target_node_id: "b", apply_missing_effects: 1 }, "apply_missing_effects"],
      [{ source_node_id: "a".repeat(513), target_node_id: "b" }, "512"],
    ];
    for (const [args, message] of cases) {
      await expect(tool.handler(args as never)).resolves.toMatchObject({ success: false, error: expect.stringContaining(message) });
    }
    expect(mockedSendCommand).not.toHaveBeenCalled();
  });

  it("escapes every user-controlled string embedded in the generated ExtendScript", async () => {
    const hostile = 'x"); app.quit(); ("\n';
    const script = await scriptFor({ source_node_id: hostile, target_node_id: "t'2", components: ['Blur"\\'] });
    expect(script).toContain('var SOURCE_ID = "x\\"); app.quit(); (\\"\\n";');
    expect(script).toContain('var TARGET_ID = "t\\\'2";');
    expect(script).toContain('var componentFilter = ["Blur\\"\\\\"];');
    expect(script).not.toContain("=>");
    expect(script).not.toMatch(/\b(let|const)\s/);

    const host = makeHost(() => ({
      source: makeClip("src", "Source", 0, 0, []),
      target: makeClip("tgt", "Target", 0, 0, []),
    }));
    const { result } = await run(host, { source_node_id: hostile, target_node_id: "tgt" });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("Source clip not found") });
  });

  it("documents the mask limitation in the tool description", () => {
    const tool = getClipboardTools(bridgeOptions).paste_clip_attributes;
    expect(tool.description).toContain("MASKS ARE NOT COPIED");
    expect(tool.description).toContain("experimental legacy QE DOM");
    expect(tool.parameters.required).toEqual(["source_node_id", "target_node_id"]);
  });

  it("requires edit authority", async () => {
    expect(capabilityForTool("paste_clip_attributes")).toBe("edit");
    const inspectOnly = resolveCapabilities("inspect");
    expect(isToolPermitted("paste_clip_attributes", inspectOnly)).toBe(false);
    const guarded = guardToolHandler(
      "paste_clip_attributes",
      getClipboardTools(bridgeOptions).paste_clip_attributes.handler as (args: unknown) => Promise<unknown>,
      inspectOnly,
      () => "op-1",
    );
    await expect(guarded({ source_node_id: "a", target_node_id: "b" })).rejects.toThrow("requires the 'edit' capability");
    expect(mockedSendCommand).not.toHaveBeenCalled();
  });
});
