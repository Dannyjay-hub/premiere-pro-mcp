import { describe, it, expect } from "vitest";
import { frameToTicks, ticksToFrame, frameToTimecode, timecodeToFrame, sampleToTicks, ticks, secondsToTicks } from "../../src/ai/exact-time.js";

describe("seeded exact-time laws (failing seed retained in assertion)", () => {
  it("round-trips rational frames and signed display offsets without float loss", () => {
    for (const seed of [0x12345678,0xc0ffee,0x5eed,0xffffffff]) {
      let state=seed>>>0;
      const random=()=>{ state=(Math.imul(state,1664525)+1013904223)>>>0; return state; };
      for (let index=0;index<500;index++) {
        const frame=(BigInt(random())*10000n+BigInt(random()))*(random()%2 ? 1n:-1n);
        for (const rate of [{numerator:24000,denominator:1001},{numerator:30000,denominator:1001},{numerator:60000,denominator:1001},{numerator:25,denominator:1}]) {
          expect(ticksToFrame(frameToTicks(frame.toString(),rate),rate),`seed=${seed};case=${index}`).toBe(frame.toString());
          const drop=rate.denominator===1001 && rate.numerator!==24000;
          expect(timecodeToFrame(frameToTimecode(frame.toString(),rate,drop),rate,drop),`seed=${seed};tc-case=${index}`).toBe(frame.toString());
        }
      }
    }
  });
  it("drop-frame minute and ten-minute boundaries preserve skipped labels", () => {
    const rate={numerator:30000,denominator:1001};
    expect(frameToTimecode("1799",rate,true)).toBe("00:00:59;29"); expect(frameToTimecode("1800",rate,true)).toBe("00:01:00;02"); expect(frameToTimecode("17982",rate,true)).toBe("00:10:00;00");
    expect(()=>timecodeToFrame("00:01:00;00",rate,true)).toThrow();
    expect(frameToTimecode("3600",{numerator:60000,denominator:1001},true)).toBe("00:01:00;04");
  });
  it("audio sample endpoints and long durations stay integer exact", () => {
    const count="987654321000";
    expect(ticks(sampleToTicks(count,48000))).toBe(BigInt(count)*5292000n);
    expect(secondsToTicks("1000000000.123456789")).toBe("254016000031359999715");
  });
});
