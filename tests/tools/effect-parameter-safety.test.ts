import { beforeEach, describe, expect, it, vi } from "vitest";
import { createContext, runInContext } from "node:vm";
import { getHelpersSource } from "../../src/bridge/script-builder.js";

vi.mock("../../src/bridge/file-bridge.js", () => ({ sendCommand: vi.fn() }));

import { sendCommand } from "../../src/bridge/file-bridge.js";
import { getKeyframeTools } from "../../src/tools/keyframes.js";
import { getAdvancedTools } from "../../src/tools/advanced.js";
import { getEffectsTools } from "../../src/tools/effects.js";
import { getScriptingTools } from "../../src/tools/scripting.js";
import { getInspectionTools } from "../../src/tools/inspection.js";

const mockedSendCommand = vi.mocked(sendCommand);
const bridge = { tempDir: "/tmp/effect-parameter-safety", timeoutMs: 5_000 };
const TICKS = 254016000000;

class MockTime { ticks = "0"; }

function collection<T>(items: T[]) {
  Object.defineProperty(items, "numItems", { get: () => items.length });
  return items as T[] & { numItems: number };
}

function parameter(displayName: string, options: { value?: unknown; color?: [number, number, number, number]; animated?: boolean; duplicateColor?: boolean } = {}) {
  let value = options.value ?? 10;
  let color = options.color ? [...options.color] : null;
  let animated = options.animated ?? false;
  const getValue = vi.fn(() => color ? 9007199254740992 : value);
  const getValueAtTime = vi.fn(() => color ? 9007199254740992 : value);
  const setValue = vi.fn((next: unknown) => {
    value = next;
    if (color) color = [0, 0, 255, 255];
  });
  const getColorValue = vi.fn(() => {
    if (!color) throw new Error("Unknown error exception");
    return [...color];
  });
  const setColorValue = vi.fn((alpha: number, red: number, green: number, blue: number) => {
    if (!color) throw new Error("Unknown error exception");
    color = [alpha, red, green, blue];
  });
  const keys = [Object.assign(new MockTime(), { ticks: String(TICKS) })];
  return {
    displayName, getValue, getValueAtTime, setValue, getColorValue, setColorValue,
    isTimeVarying: vi.fn(() => animated),
    setTimeVarying: vi.fn((next: boolean) => { animated = next; }),
    areKeyframesSupported: vi.fn(() => true),
    getKeys: vi.fn(() => animated ? keys : []),
    getValueAtKey: vi.fn(() => value),
    addKey: vi.fn(), setValueAtKey: vi.fn(), removeKey: vi.fn(), setInterpolationTypeAtKey: vi.fn(),
    setColor: (next: [number, number, number, number]) => { color = [...next]; },
  };
}

function host(properties: ReturnType<typeof parameter>[]) {
  const comp = { displayName: "Lumetri Color", matchName: "AE.ADBE Lumetri", properties: collection(properties) };
  const clip = {
    nodeId: "clip", name: "Clip", start: { ticks: "0" }, end: { ticks: String(10 * TICKS) }, duration: { ticks: String(10 * TICKS) },
    inPoint: { ticks: "0" }, outPoint: { ticks: String(10 * TICKS) }, mediaType: 1, getSpeed: () => 1, isSpeedReversed: () => false,
    components: collection([comp]),
  };
  const videoTracks = collection([{ clips: collection([clip]) }]) as unknown as { numTracks: number };
  videoTracks.numTracks = 1;
  const audioTracks = collection([]) as unknown as { numTracks: number };
  audioTracks.numTracks = 0;
  const context = createContext({
    Time: MockTime,
    app: { project: { activeSequence: { timebase: String(TICKS / 25), videoTracks, audioTracks } } },
  });
  mockedSendCommand.mockImplementation(async (script: string) =>
    JSON.parse(runInContext(getHelpersSource() + "\n" + script, context) as string) as never);
  return { clip, comp, context };
}

const keyframes = getKeyframeTools(bridge);
const advanced = getAdvancedTools(bridge);

beforeEach(() => vi.resetAllMocks());

describe("lossless colour and duplicate effect parameters", () => {
  it("lists exact colour values without calling the lossy generic getter", async () => {
    const colour = parameter("Fill Color", { value: 9007199254740992, color: [255, 20, 40, 160] });
    const scalar = parameter("Exposure", { value: 0.5 });
    host([colour, scalar]);
    const effectResult = await keyframes.get_effect_properties.handler({ node_id: "clip", effect_name: "Lumetri Color" }) as any;
    const listResult = await getScriptingTools(bridge).list_clip_effects.handler({ node_id: "clip" }) as any;
    expect(effectResult.data.properties[0]).toMatchObject({ index: 0, value: [255, 20, 40, 160], valueType: "color_argb" });
    expect(listResult.data.components[0].properties[0]).toMatchObject({ index: 0, value: [255, 20, 40, 160], valueType: "color_argb" });
    expect(colour.getValue).not.toHaveBeenCalled();
    expect(scalar.getValue).toHaveBeenCalled();
  });

  it("includes exact colour values in exhaustive clip inspection", async () => {
    const colour = parameter("Fill Color", { color: [255, 20, 40, 160] });
    host([colour]);
    const result = await getInspectionTools(bridge).get_full_clip_info.handler({ node_id: "clip" }) as any;
    expect(result.data.components[0].properties[0]).toMatchObject({ index: 0, value: [255, 20, 40, 160], valueType: "color_argb" });
    expect(colour.getValue).not.toHaveBeenCalled();
  });

  it("requires property_index for duplicate names and writes the chosen colour losslessly", async () => {
    const first = parameter("Saturation", { value: 100 });
    const second = parameter("Saturation", { value: 100, color: [255, 10, 20, 30] });
    host([first, second]);
    const ambiguous = await keyframes.set_effect_property.handler({ node_id: "clip", effect_name: "Lumetri Color", property_name: "Saturation", value: 120 }) as any;
    expect(ambiguous).toMatchObject({ success: false, error: expect.stringContaining("property indices [0, 1]") });
    expect(first.setValue).not.toHaveBeenCalled();
    expect(second.setColorValue).not.toHaveBeenCalled();

    const changed = await keyframes.set_effect_property.handler({ node_id: "clip", effect_name: "Lumetri Color", property_name: "Saturation", property_index: 1, value: [255, 70, 80, 90] }) as any;
    expect(changed).toMatchObject({ success: true, data: { value: [255, 70, 80, 90], valueType: "color_argb", propertyIndex: 1, readbackVerified: true } });
    expect(second.setColorValue).toHaveBeenCalledWith(255, 70, 80, 90, true);
    expect(second.setValue).not.toHaveBeenCalled();
    expect(first.setValue).not.toHaveBeenCalled();
  });

  it("reports exact static colour samples and refuses lossy keyframed colour reads and writes", async () => {
    const color = parameter("White Balance", { color: [255, 192, 192, 192] });
    host([color]);
    const sample = await keyframes.get_value_at_time.handler({ node_id: "clip", effect_name: "Lumetri Color", property_name: "White Balance", time_seconds: 1 }) as any;
    expect(sample.data).toMatchObject({ value: [255, 192, 192, 192], valueType: "color_argb" });
    expect(color.getValueAtTime).not.toHaveBeenCalled();

    const animatedColor = parameter("Fill", { color: [255, 10, 20, 30], animated: true });
    host([animatedColor]);
    await expect(keyframes.get_keyframes.handler({ node_id: "clip", effect_name: "Lumetri Color", property_name: "Fill", property_index: 0 })).resolves.toMatchObject({ success: false, error: expect.stringContaining("cannot be read losslessly") });
    await expect(keyframes.get_value_at_time.handler({ node_id: "clip", effect_name: "Lumetri Color", property_name: "Fill", property_index: 0, time_seconds: 1 })).resolves.toMatchObject({ success: false, error: expect.stringContaining("cannot be sampled losslessly") });
    await expect(keyframes.add_keyframe.handler({ node_id: "clip", effect_name: "Lumetri Color", property_name: "Fill", property_index: 0, time_seconds: 1, value: 0.5 })).resolves.toMatchObject({ success: false, error: expect.stringContaining("no lossless time-specific colour setter") });
    expect(animatedColor.addKey).not.toHaveBeenCalled();
    expect(animatedColor.setValueAtKey).not.toHaveBeenCalled();
  });

  it("uses setColorValue in set_color_value and refuses ambiguous color names", async () => {
    const first = parameter("Fill", { color: [255, 1, 2, 3] });
    const second = parameter("Fill", { color: [255, 4, 5, 6] });
    host([first, second]);
    const setter = advanced.set_color_value;
    await expect(setter.handler({ node_id: "clip", component_name: "Lumetri Color", property_name: "Fill", alpha: 255, red: 10, green: 20, blue: 30 })).resolves.toMatchObject({ success: false, error: expect.stringContaining("property indices [0, 1]") });
    expect(first.setColorValue).not.toHaveBeenCalled();
    await expect(setter.handler({ node_id: "clip", component_name: "Lumetri Color", property_name: "Fill", property_index: 1, alpha: 255, red: 10, green: 20, blue: 30 })).resolves.toMatchObject({ success: true, data: { verified: true, propertyIndex: 1, color: { alpha: 255, red: 10, green: 20, blue: 30 } } });
    expect(second.setColorValue).toHaveBeenCalledWith(255, 10, 20, 30, true);
  });
});
