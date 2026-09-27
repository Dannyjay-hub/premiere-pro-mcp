import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getInterchangeAnalysisTools } from "../../src/tools/interchange-analysis.js";
import type { BridgeOptions } from "../../src/bridge/file-bridge.js";

const tools = getInterchangeAnalysisTools({ tempDir: "/tmp/xmeml" } as BridgeOptions);
type Result = { success: boolean; error?: string; data?: Record<string, unknown> };

/** Shape of Premiere 25.2's export_as_fcp_xml output: FCP7 xmeml, first <file> declares, later ones reference. */
function premiereXmeml(mediaPath: string) {
  const url = `file://localhost${mediaPath.replace(/ /g, "%20")}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1"><name>Cut</name><media><video><track>
    <clipitem id="clipitem-1"><name>Interview.mp4</name><file id="file-1"><name>Interview.mp4</name><pathurl>${url}</pathurl><media/></file></clipitem>
    <clipitem id="clipitem-2"><name>Interview.mp4</name><file id="file-1"/></clipitem>
  </track></video></media></sequence>
</xmeml>`;
}

describe("FCP7 XML (xmeml) from Premiere's own export", () => {
  const dir = mkdtempSync(join(tmpdir(), "xmeml-"));
  const media = join(dir, "Interview.mp4");
  writeFileSync(media, "x");
  const xml = join(dir, "cut.xml");
  writeFileSync(xml, premiereXmeml(media));

  it("is identified as FCP7 XML with its media declaration (live: reported as FCPXML with 0 assets)", async () => {
    const result = await tools.inspect_fcpxml_interchange.handler({ path: xml }) as Result;
    expect(result.data).toMatchObject({
      format: "FCP7 XML (xmeml)", version: "4", sequenceCount: 1, clipElementCount: 2, assetCount: 1,
      assets: [{ id: "file-1", name: "Interview.mp4", source: expect.stringContaining("file://localhost") }],
    });
  });

  it("verifies the pathurl references (live: checked 0 references and still passed)", async () => {
    const result = await tools.verify_fcpxml_media_references.handler({ path: xml, allowed_roots: [dir] }) as Result;
    expect(result.data).toMatchObject({ checkedReferenceCount: 1, allAvailable: true, references: [{ status: "available", path: media }] });
  });

  it("warns instead of passing silently when a document has no references", async () => {
    const empty = join(dir, "empty.xml");
    writeFileSync(empty, "<xmeml version=\"4\"><sequence/></xmeml>");
    const result = await tools.verify_fcpxml_media_references.handler({ path: empty, allowed_roots: [dir] }) as Result;
    expect(result.data).toMatchObject({ checkedReferenceCount: 0, allAvailable: false, warning: expect.stringContaining("nothing was verified") });
  });
});
