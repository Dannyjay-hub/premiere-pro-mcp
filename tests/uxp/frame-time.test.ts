import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { snapSeconds, withinHalfFrame } = require("../../uxp-plugin/frame-time.cjs") as {
  snapSeconds: (seconds: number, ticksPerFrame: string) => { requestedSeconds: number; appliedSeconds: number; frameCount: number; ticks: string };
  withinHalfFrame: (actual: number, expected: number, ticksPerFrame: string) => boolean;
};

describe("UXP sequence frame-time snapping", () => {
  const rates = [
    ["29.97 drop-frame", "8475667200", 30000 / 1001],
    ["23.976", "10594584000", 24000 / 1001],
    ["25 fps", "10160640000", 25],
  ] as const;

  it.each(rates)("snaps fractional inputs to exact %s frame ticks", (_name, ticksPerFrame, fps) => {
    const snapped = snapSeconds(2.25 / fps, ticksPerFrame);
    expect(snapped.frameCount).toBe(2);
    expect(snapped.ticks).toBe((BigInt(ticksPerFrame) * 2n).toString());
    expect(snapped.appliedSeconds).toBeCloseTo(2 / fps, 10);
    expect(snapped.requestedSeconds).toBe(2.25 / fps);
  });

  it.each(rates)("preserves an exact %s frame input", (_name, ticksPerFrame, fps) => {
    const exact = 17 / fps;
    expect(snapSeconds(exact, ticksPerFrame).appliedSeconds).toBeCloseTo(exact, 10);
  });

  it("limits readback acceptance to half a sequence frame", () => {
    expect(withinHalfFrame(1 + 0.49 / 25, 1, "10160640000")).toBe(true);
    expect(withinHalfFrame(1 + 0.51 / 25, 1, "10160640000")).toBe(false);
  });
});
