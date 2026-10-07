import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/bridge/file-bridge.js", () => ({
  sendCommand: vi.fn().mockResolvedValue({ success: true, data: {} }),
  sendRawCommand: vi.fn().mockResolvedValue({ success: true, data: {} }),
  getTempDir: vi.fn().mockReturnValue("/tmp/test"),
  cleanupTempDir: vi.fn(),
}));

import { sendCommand } from "../../src/bridge/file-bridge.js";
import { getMediaTools } from "../../src/tools/media.js";
import { getMetadataTools } from "../../src/tools/metadata.js";
import { getProjectTools } from "../../src/tools/project.js";
import { getTrackTargetingTools } from "../../src/tools/track-targeting.js";

const mockedSendCommand = vi.mocked(sendCommand);
const bridgeOptions = { tempDir: "/tmp/issues-805-811", timeoutMs: 5000 };
const media = getMediaTools(bridgeOptions);
const metadata = getMetadataTools(bridgeOptions);
const project = getProjectTools(bridgeOptions);
const trackTargeting = getTrackTargetingTools(bridgeOptions);

beforeEach(() => {
  mockedSendCommand.mockReset();
  mockedSendCommand.mockResolvedValue({ success: true, data: {} });
});

function lastScript(): string {
  return String(mockedSendCommand.mock.calls[0][0]);
}

describe("issue #805 — import_media with interchange files", () => {
  it("reports an XML import as committed_unverified instead of an error", async () => {
    await media.import_media.handler({ file_paths: [resolve("package.json")] });
    const script = lastScript();
    expect(script).toContain("[.](xml|aaf|edl|prproj)$");
    expect(script).toContain("interchange: true");
    expect(script).toContain('outcome: "committed_unverified"');
  });
});

describe("issue #806 — set_footage_interpretation field_type", () => {
  it("accepts field_type alone and reads it back", async () => {
    await metadata.set_footage_interpretation.handler({ item_id: "i1", field_type: 2 });
    const script = lastScript();
    expect(script).toContain("interp.fieldType = 2;");
    expect(script).toContain("observedField !== wantedField");
    expect(script).toContain("fieldType: observedField");
  });

  it("rejects an out-of-range field_type before contacting Premiere", async () => {
    const result = await metadata.set_footage_interpretation.handler({ item_id: "i1", field_type: 3 });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("field_type must be") });
    expect(mockedSendCommand).not.toHaveBeenCalled();
  });
});

describe("issue #807 — import_folder target_bin", () => {
  it("resolves target_bin, skips OS junk files, and imports into the bin", async () => {
    await media.import_folder.handler({ folder_path: process.cwd(), target_bin: 'clips"x' });
    const script = lastScript();
    expect(script).toContain('__findProjectItem("clips\\"x")');
    expect(script).toContain("thumbs[.]db|desktop[.]ini|[.]ds_store");
    expect(script).toContain("importFiles(filePaths, true, targetBin, false)");
    expect(script).toContain("targetBin: targetBin.name");
  });

  it("defaults to the project root", async () => {
    await media.import_folder.handler({ folder_path: process.cwd() });
    expect(lastScript()).toContain("var targetBin = app.project.rootItem;");
  });
});

describe("issue #808 — get_encoder_presets paging", () => {
  const presets = Array.from({ length: 10 }, (_, i) => ({ name: `P${i}`, path: `/p/${i}.epr`, format: "3F3F3F3F_4D6F6F56" }));

  it("pages after filtering and reports total and offset", async () => {
    mockedSendCommand.mockResolvedValueOnce({ success: true, data: { presets } });
    const result = await trackTargeting.get_encoder_presets.handler({ limit: 3, offset: 2 }) as { data: { count: number; total: number; offset: number; presets: Array<{ name: string }> } };
    expect(result.data).toMatchObject({ count: 3, total: 10, offset: 2 });
    expect(result.data.presets.map((p) => p.name)).toEqual(["P2", "P3", "P4"]);
  });

  it("returns everything when unpaged and rejects bad values", async () => {
    mockedSendCommand.mockResolvedValueOnce({ success: true, data: { presets } });
    const all = await trackTargeting.get_encoder_presets.handler({}) as { data: { count: number; total: number } };
    expect(all.data).toMatchObject({ count: 10, total: 10 });
    await expect(trackTargeting.get_encoder_presets.handler({ limit: 0 })).resolves.toMatchObject({ success: false });
  });
});

describe("issue #811 — import_fcp_xml into_open_project", () => {
  it("imports into the open project and verifies the sequence count grew", async () => {
    await project.import_fcp_xml.handler({ path: "/tmp/edit.xml", mode: "into_open_project", target_bin: "edits" });
    const script = lastScript();
    expect(script).toContain("app.project.importFiles([xmlFile.fsName], true, targetBin, false)");
    expect(script).toContain("sequencesAfter > sequencesBefore");
    expect(script).toContain('__findProjectItem("edits")');
    expect(script).not.toContain("openFCPXML");
  });

  it("rejects an unknown mode", async () => {
    const result = await project.import_fcp_xml.handler({ path: "/tmp/edit.xml", mode: "nope" as never });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("mode must be") });
    expect(mockedSendCommand).not.toHaveBeenCalled();
  });
});
