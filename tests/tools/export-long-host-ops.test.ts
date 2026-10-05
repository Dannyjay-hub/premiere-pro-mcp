import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
        { sequence: "Podcast", track: "Video Track: 2", effect: "Ultra Key", effectIsGuid: false, clip: "Interview" },
        { sequence: "Podcast", track: "Audio Track: 1", effect: "{audio-guid}", effectIsGuid: false, clip: null },
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

  it("parses Premiere Translation Report issue lines including a UTF-8 BOM and GUID effects", () => {
    const report = parseFcpTranslationReport("\uFEFFTranslation issue:\n\tSequence <Nested Sequence 01> at , video track 3: Effect <Transform> on Clip <mark-1l4raqpva> not translated.\nTranslation issue:\n\tSequence <Podcast Base Copy> at 00:12:34:05, audio track 1: Effect <4f327230-f04c-4c34-9ea5-a998b4459221> on Clip <riverside_mark_raw-audio.wav> not translated.\n");
    expect(report.issues).toEqual([
      { sequence: "Nested Sequence 01", timecode: "", trackType: "video", trackNumber: 3, track: "video track 3", effect: "Transform", effectIsGuid: false, clip: "mark-1l4raqpva" },
      { sequence: "Podcast Base Copy", timecode: "00:12:34:05", trackType: "audio", trackNumber: 1, track: "audio track 1", effect: "4f327230-f04c-4c34-9ea5-a998b4459221", effectIsGuid: true, clip: "riverside_mark_raw-audio.wav" },
    ]);
    expect(report.totalIssueLines).toBe(2);
    expect(report.issuesTruncated).toBe(false);
    expect(report.lines[0]).toBe("Translation issue:");
  });

  it("bounds issue details and reports the total number of issue lines", () => {
    const contents = Array.from({ length: 105 }, (_, index) => `Effect: Plugin ${index}`).join("\n");
    const report = parseFcpTranslationReport(contents);
    expect(report.issues).toHaveLength(100);
    expect(report.totalIssueLines).toBe(105);
    expect(report.issuesTruncated).toBe(true);
  });

  it("waits for a growing XML output to stabilize before returning its size", async () => {
    const outputPath = join(root, "growing-output.xml");
    const reportPath = join(root, "FCP Translation Results growing.txt");
    mockedSendCommand.mockImplementationOnce(async () => {
      writeFileSync(outputPath, "one");
      writeFileSync(reportPath, "Effect: Example\n");
      setTimeout(() => writeFileSync(outputPath, "growing"), 350);
      setTimeout(() => writeFileSync(outputPath, "final-size"), 650);
      return await new Promise<never>(() => {});
    });
    const result = await getExportTools(bridgeOptions).export_as_fcp_xml.handler({ output_path: outputPath });
    expect(result).toMatchObject({ success: true, data: { outcome: "committed_unverified", xmlSizeBytes: 10, translationReportIssueLines: 1 } });
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
