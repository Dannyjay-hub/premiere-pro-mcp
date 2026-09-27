import { describe, expect, it } from "vitest";
import { capabilitiesForToolInvocation } from "../../src/security/capabilities.js";

// Premiere writes XMP changes into the source media file on disk. Live testing
// rewrote a user's MP4 metadata block through set_xmp_metadata, so these calls
// need the filesystem capability, not just edit.
describe("source-file metadata writes need the filesystem capability", () => {
  it("set_xmp_metadata", () => {
    expect(capabilitiesForToolInvocation("set_xmp_metadata", { item_id: "x", xmp_xml: "<x/>" })).toEqual(["edit", "filesystem"]);
  });

  it("set_metadata writing the XMP packet", () => {
    expect(capabilitiesForToolInvocation("set_metadata", { item_id: "x", field_name: "dc:title", value: "v", packet: "xmp" })).toEqual(["edit", "filesystem"]);
  });

  it("set_metadata writing the project packet stays an edit", () => {
    expect(capabilitiesForToolInvocation("set_metadata", { item_id: "x", field_name: "Column.Intrinsic.LogNote", value: "v" })).toEqual(["edit"]);
  });
});
