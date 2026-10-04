import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeZip } from "../../src/tools/mogrt-bake.js";
import { validateMogrtArchive } from "../../src/tools/mogrt-validation.js";
vi.mock("../../src/bridge/file-bridge.js", () => ({ sendCommand: vi.fn(), sendRawCommand: vi.fn() }));
import { sendCommand } from "../../src/bridge/file-bridge.js";
import { getTextTools } from "../../src/tools/text.js";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.clearAllMocks(); });
function file(data: Buffer) { const dir = mkdtempSync(join(tmpdir(), "mogrt-guard-")); dirs.push(dir); const path = join(dir, "title.mogrt"); writeFileSync(path, data); return path; }
describe("MOGRT archive preflight", () => {
  it.each(["definition.json", "manifest.json"])("accepts an archive with %s", name => {
    expect(validateMogrtArchive(file(writeZip([{ name, data: Buffer.from('{"name":"Title"}') }])))).toBeNull();
  });
  it.each([
    Buffer.from("not a ZIP"), writeZip([{ name: "other", data: Buffer.from("x") }]),
    writeZip([{ name: "definition.json", data: Buffer.from("invalid JSON") }]),
    writeZip([{ name: "definition.json", data: Buffer.from("[]") }]),
  ])("refuses malformed templates before bridge dispatch", async data => {
    const result = await getTextTools({ tempDir: "/tmp/guard", timeoutMs: 5000 }).import_mogrt.handler({ mogrt_path: file(data) });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("MOGRT") });
    expect(sendCommand).not.toHaveBeenCalled();
  });
  it("refuses missing templates", () => { expect(validateMogrtArchive("/nonexistent/title.mogrt")).toContain("unreadable"); });
});
