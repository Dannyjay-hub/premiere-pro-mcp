import { describe, expect, it, vi } from "vitest";
import { getUxpSequencePreviewFrameWorkflowTools } from "../../src/tools/uxp-sequence-preview-frame-workflows.js";
import type { UxpWebSocketBridge } from "../../src/bridge/uxp-websocket-bridge.js";

const snapshot = {
  project_guid: "project-1", sequence_id: "sequence-1", preview_width: 640, preview_height: 360,
};

function expectMatchesSchema(value: unknown, schema: Record<string, any>) {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.includes("object")) {
    expect(value).not.toBeNull(); expect(typeof value).toBe("object"); expect(Array.isArray(value)).toBe(false);
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) expect(record).toHaveProperty(key);
    if (schema.additionalProperties === false) expect(Object.keys(record).every((key) => key in (schema.properties ?? {}))).toBe(true);
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (key in record) expectMatchesSchema(record[key], child as Record<string, any>);
  }
  if (types.includes("string")) expect(typeof value).toBe("string");
  if (types.includes("integer")) expect(Number.isSafeInteger(value)).toBe(true);
}

describe("public guarded sequence preview-frame MCP tool", () => {
  it("returns the inspect snapshot ready to pass unchanged to update", async () => {
    const request = vi.fn().mockResolvedValueOnce({
      projectGuid: "project-1", sequenceId: "sequence-1", previewWidth: 640, previewHeight: 360,
    }).mockResolvedValueOnce({ updated: true });
    const tool = getUxpSequencePreviewFrameWorkflowTools({ request } as unknown as UxpWebSocketBridge).manage_sequence_preview_frame_uxp;
    const inspected = await tool.handler({ action: "inspect", sequence_id: "sequence-1" });
    const expected = (inspected.data as Record<string, unknown>).expected_snapshot;
    expectMatchesSchema(expected, tool.parameters.properties.expected_snapshot);
    await tool.handler({
      action: "update", sequence_id: "sequence-1", preview_width: 1920, preview_height: 1080,
      expected_snapshot: expected as typeof snapshot, confirm_set_preview_frame: true, operation_id: "preview-roundtrip",
    });
    expect(request).toHaveBeenNthCalledWith(2, "sequence.previewFrame.update", expect.objectContaining({
      expectedSnapshot: { projectGuid: "project-1", sequenceId: "sequence-1", previewWidth: 640, previewHeight: 360 },
    }));
  });

  it("uses a closed complete snapshot and translates the update arguments", async () => {
    const request = vi.fn().mockResolvedValue({ outcome: "verified" });
    const tool = getUxpSequencePreviewFrameWorkflowTools({ request } as unknown as UxpWebSocketBridge).manage_sequence_preview_frame_uxp;
    expect(tool.parameters).toMatchObject({
      additionalProperties: false, required: ["action", "sequence_id"],
      properties: { action: { enum: ["inspect", "update"] }, expected_snapshot: { additionalProperties: false, required: Object.keys(snapshot) } },
    });
    await tool.handler({
      action: "update", sequence_id: "sequence-1", preview_width: 1920, preview_height: 1080,
      expected_snapshot: snapshot, confirm_set_preview_frame: true, operation_id: "preview-frame-tool-1",
    });
    expect(request).toHaveBeenCalledWith("sequence.previewFrame.update", {
      sequenceId: "sequence-1", previewWidth: 1920, previewHeight: 1080, confirmSetPreviewFrame: true, operationId: "preview-frame-tool-1",
      expectedSnapshot: { projectGuid: "project-1", sequenceId: "sequence-1", previewWidth: 640, previewHeight: 360 },
    });
  });

  it("does not silently drop unknown reviewed fields", async () => {
    const request = vi.fn();
    const tool = getUxpSequencePreviewFrameWorkflowTools({ request } as unknown as UxpWebSocketBridge).manage_sequence_preview_frame_uxp;
    await expect(tool.handler({
      action: "update", sequence_id: "sequence-1", preview_width: 1920, preview_height: 1080,
      expected_snapshot: { ...snapshot, unexpected: true }, confirm_set_preview_frame: true, operation_id: "preview-frame-invalid",
    })).rejects.toThrow("expected_snapshot has an unknown field: unexpected");
    expect(request).not.toHaveBeenCalled();
  });
});
