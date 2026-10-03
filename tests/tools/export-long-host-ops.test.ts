import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BridgeOptions } from "../../src/bridge/file-bridge.js";

vi.mock("../../src/bridge/file-bridge.js", () => ({
  sendCommand: vi.fn().mockResolvedValue({ success: true, data: {} }),
}));

import { sendCommand } from "../../src/bridge/file-bridge.js";
import { getExportTools, parseFcpTranslationReport } from "../../src/tools/export.js";
import { getEditorRequestTools } from "../../src/tools/editor-requests.js";

const bridgeOptions: BridgeOptions = { timeoutMs: 5_000 };
const mockedSendCommand = vi.mocked(sendCommand);
let root: string;

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), "premiere-long-export-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("long host export receipts", () => {
  it("returns a committed_unverified receipt when Premiere writes XML and a translation report but remains modal-blocked", async () => {
    const outputPath = join(root, "podcast.xml");
    const reportPath = join(root, "FCP Translation Results 2026-10-03-18-30.txt");
    mockedSendCommand.mockImplementationOnce(async () => {
      writeFileSync(outputPath, "<xmeml>large project</xmeml>");
      writeFileSync(reportPath, "Sequence: Podcast\nVideo Track: 2\nClip: Interview\nEffect: Ultra Key\nAudio Track: 1\nEffect: {audio-guid}\n");
      return await new Promise<never>(() => {});
    });

    const result = await getExportTools(bridgeOptions).export_as_fcp_xml.handler({ output_path: outputPath });

    expect(result).toMatchObject({ success: true, data: {
      outcome: "committed_unverified",
      xmlWritten: true,
      xmlSizeBytes: 28,
      translationReportPath: reportPath,
      untranslatedEffects: [
        { sequence: "Podcast", track: "Video Track: 2", effect: "Ultra Key", clip: "Interview" },
        { sequence: "Podcast", track: "Audio Track: 1", effect: "{audio-guid}", clip: null },
      ],
      hostBlockedByModal: true,
    } });
    expect((result as any).data.message).toContain("Dismiss the dialog in Premiere");
    expect(mockedSendCommand).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ timeoutMs: 60 * 60_000 }));
  });

  it("parses only the first bounded report lines", () => {
    const report = parseFcpTranslationReport("Sequence: S\nTrack: V1\nEffect: One\nEffect: Two\nEffect: Three", 4);
    expect(report.lines).toHaveLength(4);
    expect(report.issues.map((issue) => issue.effect)).toEqual(["One", "Two"]);
  });

  it("reports a newly written XML as committed_unverified when the bridge later times out", async () => {
    const outputPath = join(root, "written-before-timeout.xml");
    mockedSendCommand.mockImplementationOnce(async () => {
      writeFileSync(outputPath, "<xmeml />");
      return { success: false, error: "host timeout" };
    });
    const result = await getExportTools(bridgeOptions).export_as_fcp_xml.handler({ output_path: outputPath, timeout_minutes: 1 });
    expect(result).toMatchObject({ success: true, data: { outcome: "committed_unverified", xmlWritten: true, xmlSizeBytes: 9, hostBlockedByModal: false } });
  });

  it("preserves explicit Premiere export failures even when a partial output file changed", async () => {
    const xmlPath = join(root, "rejected.xml");
    writeFileSync(xmlPath, "old");
    mockedSendCommand.mockImplementationOnce(async () => {
      writeFileSync(xmlPath, "partial xml");
      return { success: false, error: "Premiere rejected the XML export." };
    });
    const xmlFailure = await getExportTools(bridgeOptions).export_as_fcp_xml.handler({ output_path: xmlPath });
    expect(xmlFailure).toEqual({ success: false, error: "Premiere rejected the XML export." });

    const omfPath = join(root, "rejected.omf");
    mockedSendCommand.mockImplementationOnce(async () => {
      writeFileSync(omfPath, "partial omf");
      return { success: false, error: "Premiere rejected the OMF export." };
    });
    const omfFailure = await getExportTools(bridgeOptions).export_omf.handler({ output_path: omfPath });
    expect(omfFailure).toEqual({ success: false, error: "Premiere rejected the OMF export." });
  });

  it("uses the requested long timeout on OMF and EDL host readback tools", async () => {
    const tools = getExportTools(bridgeOptions);
    await tools.export_omf.handler({ output_path: join(root, "mix.omf"), timeout_minutes: 42 } as never);
    expect(mockedSendCommand).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ timeoutMs: 42 * 60_000 }));
    const edl = getEditorRequestTools(bridgeOptions).export_sequence_edl;
    expect(edl.parameters.properties).toHaveProperty("timeout_minutes");
  });
});
