import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";
import { getHelpersSource } from "../../src/bridge/script-builder.js";
import type { BridgeOptions } from "../../src/bridge/file-bridge.js";

vi.mock("../../src/bridge/file-bridge.js", () => ({
  sendCommand: vi.fn().mockResolvedValue({ success: true, data: {} }),
  sendRawCommand: vi.fn().mockResolvedValue({ success: true, data: {} }),
  getTempDir: vi.fn().mockReturnValue("/tmp/test"),
  cleanupTempDir: vi.fn(),
}));

import { sendCommand } from "../../src/bridge/file-bridge.js";
import { readScratchDisks } from "../../src/tools/project-file.js";
import { getUtilityTools } from "../../src/tools/utility.js";
import { getInspectionTools } from "../../src/tools/inspection.js";

const mockedSendCommand = vi.mocked(sendCommand);
const bridgeOptions: BridgeOptions = { tempDir: "/tmp/project-file", timeoutMs: 5000 };
const workspace = mkdtempSync(join(tmpdir(), "project-file-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));
beforeEach(() => vi.clearAllMocks());

// Shape of a Premiere 25.2 project's ScratchDiskSettings block.
function writeProject(name: string, locations: Record<string, string>): string {
  const body = Object.entries(locations).map(([k, v]) => `\t\t<${k}>${v}</${k}>`).join("\n");
  const xml = `<?xml version="1.0"?><PremiereData Version="3"><ScratchDiskSettings ObjectID="9" ClassID="4c6e" Version="4">\n${body}\n\t</ScratchDiskSettings></PremiereData>`;
  const path = join(workspace, name);
  writeFileSync(path, gzipSync(Buffer.from(xml)));
  return path;
}

describe("readScratchDisks", () => {
  it("reads saved locations and resolves SameAsProject to the project folder", () => {
    const path = writeProject("A.prproj", {
      VideoPreviewLocation0: "SameAsProject",
      AutoSaveLocation0: "/Volumes/Fast &amp; Big/AutoSave",
      CapsuleMediaLocation0: "SameAsProject",
    });
    expect(readScratchDisks(path)).toEqual({
      videoPreviews: { setting: "SameAsProject", path: workspace },
      autoSave: { setting: "/Volumes/Fast & Big/AutoSave", path: "/Volumes/Fast & Big/AutoSave" },
      motionGraphicsTemplateMedia: { setting: "SameAsProject", path: workspace },
    });
  });

  it("fails clearly when the project has no scratch disk block", () => {
    const path = join(workspace, "empty.prproj");
    writeFileSync(path, gzipSync(Buffer.from("<PremiereData/>")));
    expect(() => readScratchDisks(path)).toThrow(/no ScratchDiskSettings/);
  });
});

describe("get_project_scratch_disks", () => {
  const tools = getUtilityTools(bridgeOptions);
  it("reads the saved project file named by Premiere instead of calling a nonexistent getter", async () => {
    const path = writeProject("B.prproj", { AudioPreviewLocation0: "SameAsProject" });
    mockedSendCommand.mockResolvedValue({ success: true, data: { projectPath: path } });
    const result = await tools.get_project_scratch_disks.handler();
    expect(result).toMatchObject({ success: true, data: { source: "saved_project_file", disks: { audioPreviews: { path: workspace } } } });
    expect(mockedSendCommand.mock.calls[0][0]).not.toContain("getScratchDiskPath");
  });

  it("reports a read failure instead of an empty success", async () => {
    mockedSendCommand.mockResolvedValue({ success: true, data: { projectPath: join(workspace, "missing.prproj") } });
    await expect(tools.get_project_scratch_disks.handler()).resolves.toMatchObject({ success: false });
  });
});

describe("get_bin_contents on the project root", () => {
  const tools = getInspectionTools(bridgeOptions);
  it.each(["/", "root", "000f4240"])("accepts %s", async (binId) => {
    const clip = { nodeId: "c1", name: "Interview A.mp4", type: 1, treePath: "\\\\P\\\\Interview A.mp4", getMediaPath: () => "/m.mp4", isOffline: () => false };
    const root = { nodeId: "000f4240", name: "P", type: 3, children: { numItems: 1, 0: clip } };
    mockedSendCommand.mockImplementation(async (script: string) =>
      JSON.parse(String(runInNewContext(`${getHelpersSource()}\n${script}`, { app: { project: { rootItem: root } } }))));
    const result = await tools.get_bin_contents.handler({ bin_id: binId }) as { success: boolean; data: unknown; error?: string };
    expect(result.success).toBe(true);
    expect(JSON.stringify(result.data)).toContain("Interview A.mp4");
  });
});
