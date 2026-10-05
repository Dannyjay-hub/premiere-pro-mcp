import { beforeEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";

vi.mock("../../src/bridge/file-bridge.js", () => ({
  sendCommand: vi.fn().mockResolvedValue({ success: true, data: {} }),
}));

import { sendCommand } from "../../src/bridge/file-bridge.js";
import { getMetadataTools } from "../../src/tools/metadata.js";
import { getHelpersSource } from "../../src/bridge/script-builder.js";

const mockedSendCommand = vi.mocked(sendCommand);
const bridgeOptions = { tempDir: "/tmp/test-bridge", timeoutMs: 5_000 };

async function scriptFor(tool: { handler: (args: any) => Promise<unknown> }, args: unknown) {
  mockedSendCommand.mockClear();
  await tool.handler(args);
  expect(mockedSendCommand).toHaveBeenCalledTimes(1);
  return String(mockedSendCommand.mock.calls[0][0]);
}

beforeEach(() => vi.clearAllMocks());

describe("CEP field-level metadata inspect and update", () => {
  const metadata = getMetadataTools(bridgeOptions);

  it("parses named fields without dumping raw XML by default", async () => {
    const script = await scriptFor(metadata.get_metadata, {
      item_id: "clip-1",
      parse_fields: true,
    });
    expect(script).toContain("parse_fields");
    expect(script).toContain("new XMPMeta");
    expect(script).toContain("iterator");
    expect(script).toContain("omitted: \"sensitive\"");
    expect(script).not.toContain("metadata.projectMetadata =");
    expect(script).not.toContain("metadata.xmpMetadata =");
  });

  it("keeps raw packets available when parse_fields callers opt back in", async () => {
    const script = await scriptFor(metadata.get_metadata, {
      item_id: "clip-1",
      parse_fields: true,
      include_project_metadata: true,
      include_xmp_metadata: true,
      include_sensitive: true,
    });
    expect(script).toContain("metadata.projectMetadata =");
    expect(script).toContain("metadata.xmpMetadata =");
    expect(script).toContain("new XMPMeta");
  });

  it("writes one XMP packet field with compare-and-set and field readback", async () => {
    const script = await scriptFor(metadata.set_metadata, {
      item_id: "clip-1",
      packet: "xmp",
      field_namespace: "dc",
      field_name: "description",
      value: "Updated clip",
      expected_value: "A clip",
    });
    expect(script).toContain("item.setXMPMetadata");
    expect(script).toContain("expectedValue");
    expect(script).toContain("field_value_readback");
    expect(script).not.toContain("item.setProjectMetadata");
  });

  it("rejects an unqualified project field before sending a write", async () => {
    const result = await metadata.set_metadata.handler({
      item_id: "clip-1",
      field_name: "Description",
      value: "Updated clip",
    });
    expect(result).toEqual(expect.objectContaining({
      success: false,
      error: expect.stringContaining("Column.PropertyText.Description"),
    }));
    expect(mockedSendCommand).not.toHaveBeenCalled();

    const script = await scriptFor(metadata.set_metadata, {
      item_id: "clip-1",
      field_name: "Column.PropertyText.Description",
      value: "Updated clip",
    });
    expect(script).toContain("item.setProjectMetadata");
  });
});

describe("CEP metadata disclosure boundary", () => {
  const tools = getMetadataTools(bridgeOptions);
  const sensitiveValue = "SYNTHETIC_PRIVATE_VALUE";
  const packet = JSON.stringify([
    { namespace: "exif", path: "GPSLatitude", value: sensitiveValue },
    { namespace: "exif", path: "CameraSerialNumber", value: sensitiveValue },
    { namespace: "dc", path: "creator[1]", value: sensitiveValue },
    { namespace: "iptc", path: "CreatorContactInfo/Email", value: sensitiveValue },
    { namespace: "premiere", path: "Column.PropertyText.LogNote", value: "Synthetic log note" },
  ]);
  function host(rawPacket = packet) {
    const item = {
      nodeId: "clip-1", name: "Synthetic clip", type: 1,
      getProjectMetadata: () => rawPacket, getXMPMetadata: () => rawPacket,
      getMediaPath: () => "/synthetic/private/source.mov",
    };
    mockedSendCommand.mockImplementation(async (script) => JSON.parse(String(runInNewContext(
      `${getHelpersSource()}\n${script}`,
      {
        app: { project: { rootItem: { children: { 0: item, numItems: 1 } } } },
        ExternalObject: { AdobeXMPScript: {} },
        XMPMeta: function (text: string) {
          const entries = JSON.parse(text);
          return { iterator: () => { let index = 0; return { next: () => entries[index++] }; } };
        },
      },
    ))));
  }

  it("omits private values, raw packets and media paths from both default reads", async () => {
    host();
    for (const tool of [tools.get_metadata, tools.get_xmp_metadata]) {
      const result = await tool.handler({ item_id: "clip-1" });
      expect(result.success).toBe(true);
      expect(JSON.stringify(result)).toContain("Synthetic log note");
      expect(JSON.stringify(result)).not.toContain(sensitiveValue);
      expect(JSON.stringify(result)).not.toContain("/synthetic/private");
      expect(result.data).not.toHaveProperty("xmpMetadata");
      expect(result.data).not.toHaveProperty("projectMetadata");
    }
  });

  it("rejects every raw-packet request lacking sensitive-data authorization before bridge access", async () => {
    for (const args of [{ include_project_metadata: true }, { include_xmp_metadata: true }, { parse_fields: true, include_xmp_metadata: true }]) {
      expect(await tools.get_metadata.handler({ item_id: "clip-1", ...args })).toMatchObject({ success: false });
    }
    expect(await tools.get_xmp_metadata.handler({ item_id: "clip-1", include_raw: true })).toMatchObject({ success: false });
    expect(mockedSendCommand).not.toHaveBeenCalled();
  });

  it("discloses only explicitly selected raw packets and paths", async () => {
    host();
    const result = await tools.get_metadata.handler({ item_id: "clip-1", parse_fields: false, include_xmp_metadata: true, include_sensitive: true, include_media_path: true });
    expect(result.data).toMatchObject({ xmpMetadata: packet, mediaPath: "/synthetic/private/source.mov" });
    expect(result.data).not.toHaveProperty("projectMetadata");
    const xmp = await tools.get_xmp_metadata.handler({ item_id: "clip-1", include_raw: true, include_sensitive: true });
    expect(xmp.data).toHaveProperty("xmpMetadata", packet);
    expect(xmp.data).not.toHaveProperty("mediaPath");
    const parsed = await tools.get_xmp_metadata.handler({ item_id: "clip-1", include_sensitive: true });
    expect(JSON.stringify(parsed)).toContain(sensitiveValue);
  });

  it("refuses oversized packets before parsing or returning raw content", async () => {
    host("x".repeat(262145));
    expect(await tools.get_metadata.handler({ item_id: "clip-1" })).toMatchObject({ success: false, error: expect.stringContaining("256 Ki") });
    expect(await tools.get_xmp_metadata.handler({ item_id: "clip-1", include_raw: true, include_sensitive: true })).toMatchObject({ success: false });
  });

  it("preserves identity-only access without loading Adobe XMP or reading packets", async () => {
    host();
    const result = await tools.get_metadata.handler({ item_id: "clip-1", parse_fields: false });
    expect(result).toMatchObject({ success: true, data: { nodeId: "clip-1", name: "Synthetic clip" } });
    expect(result.data).not.toHaveProperty("fields");
    expect(result.data).not.toHaveProperty("mediaPath");
  });
});
