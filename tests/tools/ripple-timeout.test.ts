import { describe, expect, it } from "vitest";
import { MAX_RIPPLE_TIMEOUT_MS, rippleTimeoutMs } from "../../src/tools/ripple-timeout.js";

describe("bounded mover-scaled timeline edit timeout", () => {
  it("keeps startup headroom and adds 400 ms for each mover", () => {
    expect(rippleTimeoutMs(0)).toBe(30_000);
    expect(rippleTimeoutMs(1200)).toBe(510_000);
  });

  it("caps large estimates at fifteen minutes and treats invalid counts as zero", () => {
    expect(rippleTimeoutMs(100_000)).toBe(MAX_RIPPLE_TIMEOUT_MS);
    expect(rippleTimeoutMs(Number.NaN)).toBe(30_000);
  });
});
