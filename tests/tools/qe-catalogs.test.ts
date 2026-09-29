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
import { getEffectsTools } from "../../src/tools/effects.js";
import { getTransitionsTools } from "../../src/tools/transitions.js";

const mockedSendCommand = vi.mocked(sendCommand);
const bridgeOptions: BridgeOptions = { tempDir: "/tmp/qe-catalogs", timeoutMs: 5000 };
const effects = getEffectsTools(bridgeOptions);
const transitions = getTransitionsTools(bridgeOptions);
type Result = { success: boolean; error?: string; data?: unknown };

beforeEach(() => vi.clearAllMocks());

const VIDEO_EFFECTS = ["Color Replace", "Gaussian Blur", "Lumetri Color", "Crop", "Warp Stabilizer"];
const AUDIO_EFFECTS = ["Automatic Click Remover", "DeHummer", "Parametric Equalizer"];
const AUDIO_TRANSITIONS = ["Constant Power", "Constant Gain", "Exponential Fade"];
const VIDEO_TRANSITIONS = ["Additive Dissolve", "Cross Dissolve", "Cross Zoom"];

/** Legacy collection shape: { numItems, [i]: { name } }. */
function legacy(names: string[]) {
  const collection: Record<string | number, unknown> = { numItems: names.length };
  names.forEach((name, index) => { collection[index] = { name, legacy: true }; });
  return collection;
}

/**
 * `shape: "array"` mirrors Premiere Pro 25.2, where every QE catalog is a plain
 * array of name strings (verified live). By-name lookups return QE objects;
 * getVideoEffectByName is disabled so apply paths must go through the catalog.
 */
function host(shape: "array" | "legacy", applied: string[] = []) {
  const list = (names: string[]) => (shape === "array" ? names.slice() : legacy(names));
  const qeClip = {
    addAudioEffect: (effect: { name: string }) => applied.push(`audio:${effect.name}`),
    addVideoEffect: (effect: { name: string }) => applied.push(`video:${effect.name}`),
  };
  const context = {
    app: {
      enableQE: () => {},
      project: {
        activeSequence: {
          audioTracks: { 0: { clips: { numItems: 1, 0: { nodeId: "a1", name: "speech" } } }, numTracks: 1 },
          videoTracks: { numTracks: 0 },
        },
      },
    },
    qe: {
      project: {
        getActiveSequence: () => ({ getAudioTrackAt: () => ({ getItemAt: () => qeClip }), getVideoTrackAt: () => ({ getItemAt: () => qeClip }) }),
        getVideoEffectList: () => list(VIDEO_EFFECTS),
        getAudioEffectList: () => list(AUDIO_EFFECTS),
        getAudioTransitionList: () => list(AUDIO_TRANSITIONS),
        getVideoTransitionList: () => list(VIDEO_TRANSITIONS),
        getAudioEffectByName: (name: string) => (AUDIO_EFFECTS.includes(name) ? { name, resolvedByName: true } : null),
        getVideoTransitionByName: (name: string) => (VIDEO_TRANSITIONS.includes(name) ? { name } : null),
      },
    },
  };
  mockedSendCommand.mockImplementation(async (script: string) => JSON.parse(String(runInNewContext(`${getHelpersSource()}\n${script}`, context))));
  return applied;
}

describe.each(["array", "legacy"] as const)("QE catalogs (%s shape)", (shape) => {
  it("list_available_effects returns the full video catalog", async () => {
    host(shape);
    const result = await effects.list_available_effects.handler({} as never) as Result;
    expect(result.success).toBe(true);
    expect((result.data as Array<{ name: string; source: string }>).map((e) => e.name)).toEqual(VIDEO_EFFECTS);
    expect((result.data as Array<{ source: string }>)[0].source).toBe("qe.catalog");
  });

  it("list_available_audio_effects returns the audio catalog", async () => {
    host(shape);
    const result = await effects.list_available_audio_effects.handler({} as never) as Result;
    expect((result.data as Array<{ name: string }>).map((e) => e.name)).toEqual(AUDIO_EFFECTS);
  });

  it("list_available_audio_transitions returns the audio transitions", async () => {
    host(shape);
    const result = await transitions.list_available_audio_transitions.handler({} as never) as Result;
    expect(result.success).toBe(true);
    expect((result.data as { transitions: Array<{ name: string }> }).transitions.map((t) => t.name)).toEqual(AUDIO_TRANSITIONS);
  });

  it("list_available_transitions returns the video transition catalog", async () => {
    host(shape);
    const result = await transitions.list_available_transitions.handler({} as never) as Result;
    expect((result.data as Array<{ name: string }>).map((t) => t.name)).toEqual(VIDEO_TRANSITIONS);
  });
});

describe("QE catalog helpers", () => {
  const run = (expression: string, context: Record<string, unknown> = {}) =>
    runInNewContext(`${getHelpersSource()}\n${expression}`, context);

  it("normalizes string arrays and legacy collections to { numItems, [i].name }", () => {
    expect(run('var c = __qeCatalogFrom(["A", "B"]); c.numItems + ":" + c[0].name + ":" + c[1].__qeStub')).toBe("2:A:true");
    expect(run('var c = __qeCatalogFrom({ numItems: 1, 0: { name: "L" } }); c.numItems + ":" + c[0].name + ":" + !!c[0].__qeStub')).toBe("1:L:false");
    expect(run("__qeCatalogFrom(null).numItems")).toBe(0);
  });

  it("resolves stub entries to real QE objects by name", () => {
    const context = { qe: { project: { getVideoEffectByName: (name: string) => ({ name, real: true }) } } };
    expect(run('__qeEffectObject("video", { name: "Crop", __qeStub: true }).real', context)).toBe(true);
    expect(run('__qeEffectObject("video", { name: "Crop", legacy: 1 }).legacy', context)).toBe(1);
  });
});

describe("apply_lut", () => {
  it("fails before changing the clip, because Premiere cannot load a LUT file through scripting", async () => {
    const result = await effects.apply_lut.handler({ node_id: "c1", lut_path: "/Looks/Kodak 2383.cube" }) as Result;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cannot apply a LUT file.*Nothing was changed/);
    expect(mockedSendCommand).not.toHaveBeenCalled();
  });
});
