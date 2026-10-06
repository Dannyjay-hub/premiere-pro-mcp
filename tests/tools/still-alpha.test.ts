import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/bridge/file-bridge.js", () => ({ sendCommand: vi.fn() }));

import { sendCommand } from "../../src/bridge/file-bridge.js";
import { getExportTools, pngHasAlpha } from "../../src/tools/export.js";

const mockedSendCommand = vi.mocked(sendCommand);
const directory = mkdtempSync(join(tmpdir(), "premiere-still-alpha-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
beforeEach(() => mockedSendCommand.mockReset());

/** The first 26 bytes of a PNG: signature, IHDR length and type, size, bit depth, colour type. */
function pngHeader(colourType: number) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(1080, 16);
  bytes.writeUInt32BE(1920, 20);
  bytes[24] = 8;
  bytes[25] = colourType;
  return bytes;
}

function pngFile(name: string, colourType: number) {
  const path = join(directory, name);
  writeFileSync(path, pngHeader(colourType));
  return path;
}

describe("PNG alpha detection", () => {
  it("reads the IHDR colour type", () => {
    expect(pngHasAlpha(pngHeader(6))).toBe(true);
    expect(pngHasAlpha(pngHeader(4))).toBe(true);
    expect(pngHasAlpha(pngHeader(2))).toBe(false);
    expect(pngHasAlpha(pngHeader(0))).toBe(false);
  });

  it("returns null for bytes that are not a PNG header", () => {
    expect(pngHasAlpha(Buffer.from("png bytes"))).toBeNull();
    const notIhdr = pngHeader(6);
    notIhdr.write("IDAT", 12, "latin1");
    expect(pngHasAlpha(notIhdr)).toBeNull();
    expect(pngHasAlpha(pngHeader(6).subarray(0, 20))).toBeNull();
  });
});

describe("export_frame and capture_frame report straight alpha", () => {
  it("export_frame adds hasAlpha and a compositing note for an RGBA still", async () => {
    const path = pngFile("rgba.png", 6);
    mockedSendCommand.mockResolvedValueOnce({ success: true, data: { exported: true, outputPath: path, method: "qe" } });
    const result = await getExportTools({}).export_frame.handler({ output_path: path });
    expect(result).toMatchObject({
      success: true,
      data: { exported: true, outputPath: path, hasAlpha: true, alphaNote: expect.stringContaining("composited over black") },
    });
  });

  it("export_frame reports an opaque still without a note, and leaves unreadable files alone", async () => {
    const path = pngFile("rgb.png", 2);
    mockedSendCommand.mockResolvedValueOnce({ success: true, data: { exported: true, outputPath: path } });
    const opaque = await getExportTools({}).export_frame.handler({ output_path: path }) as { data: Record<string, unknown> };
    expect(opaque.data.hasAlpha).toBe(false);
    expect(opaque.data).not.toHaveProperty("alphaNote");

    const missing = join(directory, "missing.png");
    mockedSendCommand.mockResolvedValueOnce({ success: true, data: { exported: true, outputPath: missing } });
    const unread = await getExportTools({}).export_frame.handler({ output_path: missing }) as { data: Record<string, unknown> };
    expect(unread.data).not.toHaveProperty("hasAlpha");

    mockedSendCommand.mockResolvedValueOnce({ success: false, error: "QE export failed" });
    await expect(getExportTools({}).export_frame.handler({ output_path: path }))
      .resolves.toEqual({ success: false, error: "QE export failed" });
  });

  it("capture_frame reports alpha on the inline image", async () => {
    const path = pngFile("capture.png", 6);
    mockedSendCommand.mockResolvedValueOnce({ success: true, data: { outputPath: path } });
    await expect(getExportTools({}).capture_frame.handler({})).resolves.toMatchObject({
      success: true,
      data: { captured: true, hasAlpha: true, alphaNote: expect.stringContaining("straight alpha"), mimeType: "image/png" },
    });
  });
});
