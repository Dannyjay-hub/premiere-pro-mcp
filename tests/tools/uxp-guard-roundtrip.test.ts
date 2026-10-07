import { fromJsonSchema, type JsonSchemaType } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { getUxpTools } from "../../src/tools/uxp.js";
import type { UxpWebSocketBridge } from "../../src/bridge/uxp-websocket-bridge.js";

type RoundTrip = {
  tool: string; inspect?: Record<string, unknown>; panel: Record<string, unknown>;
  apply: Record<string, unknown>; keys: string[]; applyTool?: string;
};
const target = { media_type: "video", track_index: 0, clip_index: 0 };
const owner = { projectGuid: "project-1", sequenceId: "sequence-1", mediaType: "video", trackIndex: 0, clipIndex: 0 };
const item = { startSeconds: 10, endSeconds: 20, inSeconds: 2, outSeconds: 12, durationSeconds: 10, speed: 1, reversed: false };
const parameter = { projectId: "project-1", sequenceId: "sequence-1", mediaType: "video", trackIndex: 0, clipIndex: 0, componentIndex: 1, componentId: "ADBE Motion", paramIndex: 0, paramName: "Position", timeVarying: false };
const parameterTarget = { ...target, component_index: 1, param_index: 0 };
const panelXml = { projectGuid: "project-1", projectPanelMetadata: "<Columns/>" };

const cases: RoundTrip[] = [
  { tool: "manage_sequence_playhead_uxp", panel: { sequenceGuid: "sequence-1", positionSeconds: 3 }, apply: { action: "set", position_seconds: 8 }, keys: ["expected_sequence_guid", "expected_position_seconds"] },
  { tool: "manage_work_area_uxp", panel: { sequenceGuid: "sequence-1", workArea: { inSeconds: 1, outSeconds: 10 } }, apply: { action: "set", in_seconds: 2, out_seconds: 9 }, keys: ["expected_sequence_guid", "expected_work_area"] },
  { tool: "manage_sequence_range_uxp", panel: { sequenceGuid: "sequence-1", range: { inSeconds: null, outSeconds: null, inSet: false, outSet: false, zeroPointSeconds: 0, endSeconds: 20 } }, apply: { action: "update", updates: { in_seconds: 2 } }, keys: ["expected_sequence_guid", "expected_range"] },
  { tool: "manage_sequence_display_format_uxp", panel: { sequence: { id: "sequence-1", name: "Timeline" }, displayFormats: { audioDisplayFormat: 1, videoDisplayFormat: 20 } }, apply: { action: "update", updates: { audio_display_format: 2 } }, keys: ["expected_sequence_guid", "expected_display_formats"] },
  { tool: "manage_timeline_selection_uxp", inspect: { action: "inspect_targets", selection_targets: [target] }, panel: { sequenceGuid: "sequence-1", items: [{ ...owner, ...item, projectItem: { id: "source-1" } }] }, apply: { action: "replace" }, keys: ["expected_sequence_guid", "selection_items"] },
  { tool: "manage_sequence_preview_frame_uxp", inspect: { action: "inspect", sequence_id: "sequence-1" }, panel: { projectGuid: "project-1", sequenceId: "sequence-1", previewWidth: 640, previewHeight: 360 }, apply: { action: "update", sequence_id: "sequence-1", preview_width: 1920, preview_height: 1080, confirm_set_preview_frame: true }, keys: ["expected_snapshot"] },
  { tool: "manage_timeline_source_label_uxp", inspect: { action: "inspect", ...target }, panel: { ...owner, trackItemCount: 1, sourceProjectItemId: "source-1", sourceColorLabelIndex: 3, startSeconds: 10, endSeconds: 20 }, apply: { action: "update", ...target, color_index: 4, confirm_set_label: true }, keys: ["expected_snapshot"] },
  { tool: "manage_project_panel_metadata_uxp", panel: panelXml, apply: { action: "update", project_panel_metadata: "<NewColumns/>", confirm_update: true }, keys: ["expected_project_guid", "expected_project_panel_metadata"] },
  { tool: "create_project_metadata_field_uxp", panel: panelXml, apply: { action: "create", field_name: "Review", field_label: "Review", schema_field_type: "text", confirm_create: true }, keys: ["expected_project_guid", "expected_project_panel_metadata"] },
  { tool: "manage_app_preferences_uxp", inspect: { action: "inspect", preference: "import_workspace" }, panel: { preferences: [{ preference: "import_workspace", value: "0" }] }, apply: { action: "set", preference: "import_workspace", value: "1", persistence: "persistent", confirm_preference_change: true }, keys: ["expected_value"] },
  { tool: "transform_track_item_uxp", inspect: { action: "inspect", ...target }, panel: { ...item, ...owner }, apply: { action: "update", ...target, move_by_seconds: 1 }, keys: ["expected_start_seconds", "expected_end_seconds"] },
  { tool: "manage_track_state_uxp", inspect: { action: "inspect", media_type: "video", track_indices: [0] }, panel: { sequenceId: "sequence-1", tracks: [{ mediaType: "video", trackIndex: 0, muted: false }] }, apply: { action: "set_mute", media_type: "video", track_indices: [0], muted: true }, keys: ["expected_sequence_id", "expected_muted"] },
  { tool: "manage_workflow_checkpoints_uxp", inspect: { action: "get", owner: "project", name: "review" }, panel: { owner: "project", ownerId: "project-1", name: "review", exists: false, value: null }, apply: { action: "set", owner: "project", name: "review", value_type: "string", value: "ready" }, keys: ["expected_owner_id"] },
  { tool: "maintain_media_health_uxp", inspect: { action: "inspect", project_item_id: "source-1" }, panel: { items: [{ projectItemId: "source-1", offline: false }] }, apply: { action: "set_offline", project_item_id: "source-1", confirm_set_offline: true }, keys: ["expected_offline"] },
  { tool: "manage_source_media_timing_uxp", inspect: { action: "inspect", project_item_id: "source-1" }, panel: { startSeconds: 0, durationSeconds: 60 }, apply: { action: "set_start", project_item_id: "source-1", start_seconds: 10, confirm_set_start: true }, keys: ["expected_timing"] },
  { tool: "manage_source_media_overrides_uxp", inspect: { action: "inspect", project_item_id: "source-1" }, panel: { projectGuid: "project-1", frameRate: 25, pixelAspectRatio: 1 }, apply: { action: "update", project_item_id: "source-1", frame_rate: 24, confirm_media_interpretation: true }, keys: ["expected_overrides"] },
  { tool: "automate_effect_parameters_uxp", inspect: { action: "inspect_time_varying", ...parameterTarget }, panel: { ...parameter, keyframeTimesSeconds: [], keyframesLimited: false }, apply: { action: "set_time_varying", ...parameterTarget, time_varying: true }, keys: ["expected_sequence_id", "expected_component_id", "expected_param_name", "expected_time_varying", "expected_keyframe_times_seconds"] },
  { tool: "automate_effect_parameters_uxp", inspect: { action: "inspect_point_value", ...parameterTarget }, panel: { ...parameter, point: { x: 1, y: 2 } }, apply: { action: "set_point_value", ...parameterTarget, point: { x: 2, y: 3 }, confirm_set_point: true }, keys: ["expected_point_snapshot"] },
  { tool: "automate_effect_parameters_uxp", inspect: { action: "inspect_color_value", ...parameterTarget }, panel: { ...parameter, color: { red: 1, green: 0, blue: 0, alpha: 1 } }, apply: { action: "set_color_value", ...parameterTarget, color: { red: 0, green: 1, blue: 0, alpha: 1 }, confirm_set_color: true }, keys: ["expected_color_snapshot"] },
  { tool: "manage_markers_uxp", panel: { markers: [{ guid: "marker-1", name: "Intro", startSeconds: 1, durationSeconds: 0 }] }, apply: { action: "remove_many", confirm_destructive: true }, keys: ["marker_snapshots"] },
  { tool: "manage_markers_uxp", inspect: { action: "inspect", marker_guid: "marker-1" }, panel: { markers: [{ guid: "marker-1", name: "Intro", startSeconds: 1, durationSeconds: 0 }] }, apply: { action: "update", marker_guid: "marker-1", name: "Opening" }, keys: ["expected_name"] },
  { tool: "slip_track_item_uxp", inspect: { action: "inspect", ...target }, panel: { ...owner, ...item }, apply: { action: "apply", ...target, slip_by_seconds: 1, confirm_slip: true }, keys: ["expected_snapshot"] },
  { tool: "slide_track_item_uxp", inspect: { action: "inspect", ...target }, panel: { ...owner, previous: item, target: item, following: item }, apply: { action: "apply", ...target, slide_by_seconds: 1, confirm_slide: true }, keys: ["expected_snapshot"] },
  { tool: "ripple_delete_track_item_uxp", inspect: { action: "inspect", ...target }, panel: { ...owner, trackItemCount: 2, target: { ...item, projectItemId: "source-1" }, following: { ...item, projectItemId: "source-2" } }, apply: { action: "apply", ...target, confirm_ripple_delete: true }, keys: ["expected_snapshot"] },
  { tool: "duplicate_track_item_uxp", inspect: { action: "inspect", ...target }, panel: { ...owner, trackItemCount: 1, source: { ...item, projectItemId: "source-1" } }, apply: { action: "apply", ...target, confirm_duplicate: true }, keys: ["expected_snapshot"] },
  { tool: "inspect_video_transition_uxp", inspect: { video_track_index: 0, clip_index: 0, position: "end" }, panel: { sequenceGuid: "sequence-1", videoTrackIndex: 0, clipIndex: 0, projectItemId: "source-1", startSeconds: 10, endSeconds: 20, position: "end", transitionPresent: false }, applyTool: "add_video_transition_uxp", apply: { video_track_index: 0, clip_index: 0, position: "end", match_name: "CrossDissolve" }, keys: ["expected_target"] },
  { tool: "manage_source_clip_uxp", inspect: { action: "inspect", items: [{ project_item_id: "source-1", media_type: "video" }] }, panel: { items: [{ projectItemId: "source-1", mediaType: "video", inSeconds: 0, outSeconds: 20 }] }, apply: { action: "update" }, keys: ["items"] },
  { tool: "manage_clip_effects_uxp", inspect: { action: "inspect", ...target, component_index: 1 }, panel: { components: [{ index: 1, matchName: "ADBE Motion", displayName: "Motion" }] }, apply: { action: "remove", ...target, component_index: 1 }, keys: ["expected_effect_id"] },
  { tool: "organize_project_items_uxp", inspect: { action: "inspect_bin", bin_id: "bin-1" }, panel: { bin: { id: "bin-1", name: "Footage", parentId: "root-1" } }, apply: { action: "rename", project_item_id: "bin-1", name: "Selects" }, keys: ["expected_name", "expected_parent_id"] },
  { tool: "inspect_project_uxp", inspect: {}, panel: { revision: "r1", project: { guid: "project-1" }, activeSequenceGuid: "sequence-1", sequences: [{ guid: "sequence-1", name: "Timeline" }] }, applyTool: "lift_selection_uxp", apply: {}, keys: ["expected_sequence_guid"] },
];

describe("UXP complete inspect/apply guards", () => {
  it.each(cases)("$tool: $inspect.action returns schema-valid apply guards", async ({ tool, inspect, panel, apply, keys, applyTool }) => {
    const request = vi.fn().mockResolvedValueOnce(panel).mockResolvedValueOnce({ outcome: "verified" });
    const tools = getUxpTools({ request, getState: vi.fn() } as unknown as UxpWebSocketBridge) as Record<string, any>;
    const result = await tools[tool].handler(inspect ?? { action: "inspect" });
    const guards = Object.fromEntries(Object.entries(result.data).filter(([key]) => key.startsWith("expected_") || keys.includes(key)));
    for (const key of keys) expect(guards).toHaveProperty(key);
    const args = { ...apply, ...guards, operation_id: "roundtrip-1" };
    const selected = tools[applyTool ?? tool];
    const validation = await fromJsonSchema(selected.parameters as JsonSchemaType)["~standard"].validate(args);
    expect(validation).not.toHaveProperty("issues");
    await expect(selected.handler(args)).resolves.toMatchObject({ success: true });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("does not invent common guards for mixed lists, empty selection, or truncated animation", async () => {
    const entries = [
      { tool: "manage_track_state_uxp", args: { action: "inspect", media_type: "video" }, panel: { sequenceId: "sequence-1", tracks: [{ muted: false }, { muted: true }] }, absent: "expected_muted", present: "expected_sequence_id" },
      { tool: "maintain_media_health_uxp", args: { action: "inspect", project_item_ids: ["a", "b"] }, panel: { items: [{ offline: false }, { offline: true }] }, absent: "expected_offline" },
      { tool: "manage_timeline_selection_uxp", args: { action: "inspect" }, panel: { sequenceGuid: "sequence-1", items: [] }, absent: "selection_items", present: "expected_sequence_guid" },
      { tool: "automate_effect_parameters_uxp", args: { action: "inspect_time_varying", ...parameterTarget }, panel: { ...parameter, keyframeTimesSeconds: [1], keyframesLimited: true }, absent: "expected_keyframe_times_seconds", present: "expected_sequence_id" },
    ];
    for (const entry of entries) {
      const request = vi.fn().mockResolvedValue(entry.panel);
      const tools = getUxpTools({ request, getState: vi.fn() } as unknown as UxpWebSocketBridge) as Record<string, any>;
      const result = await tools[entry.tool].handler(entry.args);
      expect(result.data).not.toHaveProperty(entry.absent);
      if (entry.present) expect(result.data).toHaveProperty(entry.present);
    }
  });

});
