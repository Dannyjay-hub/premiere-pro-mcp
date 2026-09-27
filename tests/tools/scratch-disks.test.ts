import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { getProjectTools } from "../../src/tools/project.js";
import { getUtilityTools } from "../../src/tools/utility.js";

const mockedSendCommand = vi.mocked(sendCommand);
const bridgeOptions: BridgeOptions = { tempDir: "/tmp/scratch-disks", timeoutMs: 5000 };
const project = getProjectTools(bridgeOptions);
const utility = getUtilityTools(bridgeOptions);
let dir = "";

beforeEach(() => { vi.clearAllMocks(); dir = mkdtempSync(join(tmpdir(), "scratch-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ELEMENTS: Record<string, string> = {
  FirstVideoCaptureFolder: "CapturedVideoLocation0",
  FirstAudioCaptureFolder: "CapturedAudioLocation0",
  FirstVideoPreviewFolder: "VideoPreviewLocation0",
  FirstAudioPreviewFolder: "AudioPreviewLocation0",
  FirstAutoSaveFolder: "AutoSaveLocation0",
};

/**
 * Live 25.2: app.setScratchDiskPath only honors ScratchDiskType constants (a
 * plain "videoPreview" string is ignored), there is no getter, and the value
 * reaches the .prproj on save.
 */
function host(options: { ignoreWrites?: boolean } = {}) {
  const projectPath = join(dir, "Test.prproj");
  const settings: Record<string, string> = Object.fromEntries(Object.values(ELEMENTS).map((el) => [el, "SameAsProject"]));
  const calls: Array<[string, unknown]> = [];
  const ScratchDiskType = Object.fromEntries(Object.keys(ELEMENTS).map((name) => [name, `BE::${name}`]));
  const save = () => {
    const body = Object.entries(settings).map(([el, v]) => `<${el}>${v}</${el}>`).join("");
    writeFileSync(projectPath, `<Project><ScratchDiskSettings>${body}</ScratchDiskSettings></Project>`);
  };
  save();
  const app = {
    project: { path: projectPath, save },
    setScratchDiskPath: (path: string, type: unknown) => {
      calls.push([path, type]);
      const name = Object.keys(ScratchDiskType).find((k) => ScratchDiskType[k] === type);
      if (name && !options.ignoreWrites) settings[ELEMENTS[name]] = path;
      return true;
    },
  };
  // Like ExtendScript, Folder(path) also works without new.
  function Folder(this: { exists: boolean } | undefined, path: string): unknown {
    if (!(this instanceof Folder)) return new (Folder as unknown as new (p: string) => unknown)(path);
    this.exists = path === dir || path.startsWith(`${dir}/`);
    return this;
  }
  mockedSendCommand.mockImplementation(async (script: string) =>
    JSON.parse(String(runInNewContext(`${getHelpersSource()}\n${script}`, { app, ScratchDiskType, Folder }))));
  return { calls, settings };
}

describe("scratch disk setters", () => {
  it("passes Premiere's ScratchDiskType constant, not the tool's type name", async () => {
    const { calls } = host();
    await expect(project.set_scratch_disk_path.handler({ scratch_disk_type: "videoPreview", path: dir }))
      .resolves.toMatchObject({ success: true, data: { set: { videoPreviews: dir }, verified: false } });
    expect(calls).toEqual([[dir, "BE::FirstVideoPreviewFolder"]]);
  });

  it("saves and verifies against the project file when asked", async () => {
    host();
    await expect(utility.set_project_scratch_disk.handler({ video_previews: dir, audio_previews: "SameAsProject", save_and_verify: true }))
      .resolves.toMatchObject({ success: true, data: { verified: true, projectSaved: true, disks: { videoPreviews: { setting: dir } } } });
  });

  it("fails verification when the saved project did not change", async () => {
    host({ ignoreWrites: true });
    await expect(project.set_scratch_disk_path.handler({ scratch_disk_type: "autoSave", path: dir, save_and_verify: true }))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining("did not save the requested scratch disks") });
  });

  it("refuses a missing folder and a relative path", async () => {
    const { calls } = host();
    await expect(project.set_scratch_disk_path.handler({ scratch_disk_type: "autoSave", path: `${dir}-missing` }))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining("does not exist") });
    await expect(utility.set_project_scratch_disk.handler({ captured_video: "relative/folder" }))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining("absolute") });
    await expect(utility.set_project_scratch_disk.handler({})).resolves.toMatchObject({ success: false });
    expect(calls).toEqual([]);
  });
});
