import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/bridge/file-bridge.js", () => ({
  sendCommand: vi.fn().mockResolvedValue({ success: true, data: {} }),
}));

import { sendCommand } from "../../src/bridge/file-bridge.js";
import { getHelpersSource } from "../../src/bridge/script-builder.js";
import { getAdvancedTools } from "../../src/tools/advanced.js";

const mockedSendCommand = vi.mocked(sendCommand);
const advanced = getAdvancedTools({ tempDir: "/tmp/set-zero-point", timeoutMs: 1000 });
const TICKS = 254016000000;
const FRAME_2997 = TICKS * 1001 / 30000;

type Result = { success: boolean; error?: string; data?: Record<string, unknown> };

beforeEach(() => vi.clearAllMocks());

function host(options: { ignore?: boolean } = {}) {
  const seq = {
    timebase: String(FRAME_2997),
    zeroPoint: "0",
    setZeroPoint(ticks: string) { if (!options.ignore) this.zeroPoint = String(ticks); },
  };
  mockedSendCommand.mockImplementation(async (script: string) => {
    expect(script).not.toMatch(/\b(let|const)\s|=>/);
    return JSON.parse(String(runInNewContext(`${getHelpersSource()}\n${script}`, { app: { project: { activeSequence: seq } } })));
  });
  return seq;
}

describe("set_zero_point", () => {
  it("writes the frame-snapped zero point and verifies it (live 26.5.2: 3600 s reads 3599.9964 s at 29.97)", async () => {
    const seq = host();
    const result = await advanced.set_zero_point.handler({ start_seconds: 3600 }) as Result;
    expect(result).toMatchObject({ success: true, data: { set: true, verified: true, outcome: "verified", requestedSeconds: 3600, previousSeconds: 0 } });
    expect(result.data?.appliedSeconds).toBeCloseTo(3599.9964, 6);
    expect(parseFloat(seq.zeroPoint)).toBe(107892 * FRAME_2997);
  });

  it("fails when Premiere does not keep the zero point", async () => {
    host({ ignore: true });
    const result = await advanced.set_zero_point.handler({ start_seconds: 10 }) as Result;
    expect(result).toMatchObject({ success: false, data: { outcome: "failed", verified: false, startSeconds: 0 } });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("refuses start_seconds %s before contacting Premiere", async (start_seconds) => {
    await expect(advanced.set_zero_point.handler({ start_seconds })).resolves.toMatchObject({ success: false, error: expect.stringContaining("start_seconds") });
    expect(mockedSendCommand).not.toHaveBeenCalled();
  });
});
