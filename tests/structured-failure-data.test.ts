import { describe, expect, it } from "vitest";
import { structuredToolResult } from "../src/workflows/tool-metadata.js";

describe("structuredToolResult", () => {
  it("keeps diagnostic data on failure (paste_clip_attributes pointed at data.notCopied that was dropped)", () => {
    const data = { status: "partial", notCopied: [{ component: "Opacity", property: "Blend Mode", reason: "differs" }] };
    expect(structuredToolResult("paste_clip_attributes", false, data, "only partially applied")).toEqual({
      ok: false, tool: "paste_clip_attributes", error: "only partially applied", data,
    });
  });

  it("omits data on failure when the tool provided none", () => {
    expect(structuredToolResult("x", false, undefined, "boom")).toEqual({ ok: false, tool: "x", error: "boom" });
  });
});
