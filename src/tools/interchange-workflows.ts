import type { BridgeOptions } from "../bridge/file-bridge.js";
import { RATE_PARAMETER } from "../ai/exact-time.js";
import { readBoundedInterchange, writeNewInterchange } from "../interchange/bounded-file.js";
import { buildAle, buildReviewMarkerExport, previewFacilityMetadataIntake } from "../interchange/facility.js";
import { inspectInterchangeArtifact, interchangeLossReport, planAudioPostTurnover, type InterchangeFormat } from "../interchange/evidence.js";
import { inspectOtio, snapshotToOtio, supportedSnapshotProjection, type InterchangeSnapshot } from "../interchange/otio.js";

const pathSchema = { type: "string", minLength: 1, maxLength: 4096, description: "Absolute caller-selected local file path. Referenced media is never opened automatically." };
const tickSchema = { type: "string", pattern: "^-?(0|[1-9][0-9]{0,39})$", description: "Exact decimal Premiere tick string; no floating-point time conversion." };
const text = (description: string, maximum = 512) => ({ type: "string", maxLength: maximum, description });
const object = (description: string, properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: "object", additionalProperties: false, description, properties, required });
const formatSchema = { type: "string", enum: ["otio", "fcp7xml", "fcpxml", "edl", "aaf", "omf"], description: "Requested format; XML root bytes distinguish FCP7 xmeml from FCPXML. AAF/OMF semantic parsing is unavailable." };
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
async function result(operation: () => unknown) {
  try { return { success: true, data: operation() }; }
  catch (error) { return { success: false, error: (error as Error).message }; }
}

export function getInterchangeWorkflowTools(_bridgeOptions: BridgeOptions) {
  return {
    inspect_otio_interchange: {
      description: "Parse a bounded local OTIO Timeline.1 into exact-tick offline tracks/clips/gaps/transitions. Reports missing media, opaque nests/effects/metadata and unsupported timing. Synthetic IDs never authorize Premiere writes; this tool never imports a project.",
      parameters: object("OTIO inspection", { path: pathSchema }), annotations: readAnnotations,
      handler: async (args: { path: string }) => result(() => {
        const file = readBoundedInterchange(args.path);
        return { snapshot: inspectOtio(file.contents), artifact: { bytes: file.bytes, sha256: file.sha256 }, hostVerified: false };
      }),
    },
    preview_otio_snapshot_export: {
      description: "Serialize the declared bounded linear offline snapshot subset to OTIO, then parse it back and compare exact supported structure. Refuses unsupported nests/effect parameters/non-frame timing. Returns text for review; does not write files or establish Premiere/destination compatibility.",
      parameters: object("Offline OTIO snapshot preview", { snapshot: { type: "object", description: "premiere-mcp.interchange.snapshot.v1 returned by inspect_otio_interchange; offline IDs only. Maximum 2,000 entries, 32 levels and 20,000 JSON nodes." } }), annotations: readAnnotations,
      handler: async (args: { snapshot: unknown }) => result(() => {
        const contents = snapshotToOtio(args.snapshot), parsed = inspectOtio(contents);
        const twice = inspectOtio(snapshotToOtio(parsed));
        const inputMatches = JSON.stringify(supportedSnapshotProjection(args.snapshot as InterchangeSnapshot)) === JSON.stringify(supportedSnapshotProjection(parsed));
        if (!inputMatches) throw new Error("Supported offline snapshot fields changed during OTIO serialization");
        return { contents, snapshot: parsed, offlineRoundTrip: JSON.stringify(parsed) === JSON.stringify(twice), lossReport: [{ feature: "linear_timing", status: "preserved", scope: "exact_tick_timing_in_offline_supported_subset" }, { feature: "transitions", status: "preserved", scope: "stored_offsets_and_type_only_rendered_appearance_unknown" }, { feature: "host_effects_nests_metadata", status: "unknown", scope: "unsupported_inputs_refused_before_serialization" }], verificationBoundary: "offline_supported_subset_parse_serialize_parse", destinationAcceptance: "not_run", hostVerified: false };
      }),
    },
    inspect_interchange_artifact: {
      description: "Read caller-selected artifact bytes, hash them and identify actual OTIO/FCP7 xmeml/FCPXML/EDL structure. AAF/OMF are bounded opaque-byte evidence only. File existence, parsed structure, round-trip and licensed-host/destination evidence remain distinct.",
      parameters: object("Interchange artifact evidence", { path: pathSchema, format: formatSchema }, ["path"]), annotations: readAnnotations,
      handler: async (args: { path: string; format?: InterchangeFormat }) => result(() => inspectInterchangeArtifact(args.path, args.format)),
    },
    inspect_interchange_loss_report: {
      description: "Build per-feature inspected/approximated/dropped/unknown loss evidence for OTIO, FCP7 XML, FCPXML, CMX EDL, AAF or OMF. Optional artifact inspection identifies its actual root. Source inventory is caller evidence; this never infers destination acceptance from exporter success.",
      parameters: object("Interchange loss report", { format: formatSchema, path: pathSchema, source_features: object("Optional bounded source occurrence counts", Object.fromEntries(["linear_timing", "nests", "effects", "links", "retiming", "captions", "metadata", "transitions", "gain_automation", "channel_mapping"].map(name => [name, { type: "integer", minimum: 0, maximum: 2000, description: `Caller-inventoried ${name} occurrence count; omitted means unknown.` }])), []) }, ["format"]), annotations: readAnnotations,
      handler: async (args: { format: InterchangeFormat; path?: string; source_features?: unknown }) => result(() => {
        const artifact = args.path ? inspectInterchangeArtifact(args.path, args.format) : undefined;
        return interchangeLossReport(artifact?.format ?? args.format, args.source_features ?? {}, artifact);
      }),
    },
    export_review_markers: {
      description: "Create a new bounded review-marker CSV or JSON from caller-reviewed marker readback. Includes exact ticks, rational rate, source/sequence identity and display timecodes with explicit start offset/drop-frame policy. CSV text escapes spreadsheet formula prefixes, quotes and newlines. Existing files are never overwritten.",
      parameters: object("Marker export", {
        output_path: pathSchema, format: { type: "string", enum: ["csv", "json"], description: "Output serialization." },
        target: object("Exact reviewed marker owner", { kind: { type: "string", enum: ["sequence", "source"], description: "Distinguish sequence markers from source markers." }, id: text("Readback owner ID; this is provenance, not mutation authority."), display_start_ticks: tickSchema }),
        rate: RATE_PARAMETER, drop_frame: { type: "boolean", description: "Use drop-frame timecode only for 30000/1001 or 60000/1001; default false." },
        markers: { type: "array", maxItems: 2000, description: "Reviewed marker readback; empty sequences still emit CSV headers.", items: object("One review marker", { id: text("Stable marker ID, unique within export."), name: text("Marker label."), comment: text("Marker comment; multiline is preserved in CSV/JSON.", 4096), color: text("Readback color value or name.", 64), start_ticks: tickSchema, duration_ticks: tickSchema }) },
      }, ["output_path", "format", "target", "rate", "markers"]), annotations: writeAnnotations,
      handler: async (args: { output_path: string; format: "csv" | "json"; target: unknown; rate: unknown; drop_frame?: boolean; markers: unknown[] }) => result(() => {
        const { output_path, format, ...input } = args;
        const exported = buildReviewMarkerExport(input, format);
        return { ...writeNewInterchange(output_path, exported.contents), markerCount: exported.receipt.markers.length, target: exported.receipt.target, timecodePolicy: exported.receipt.timecodePolicy };
      }),
    },
    preview_facility_metadata_intake: {
      description: "Read a bounded ALE table and preview explicit column-to-named-field mappings against reviewed source IDs/filenames. Reports duplicate table keys, ambiguous filenames, missing sources and unsupported fields. Never writes Premiere metadata or requires an XMP packet dump.",
      parameters: object("Facility metadata intake", {
        path: pathSchema, match_column: text("ALE column matched exactly against caller-reviewed source filenames.", 64),
        column_mapping: { type: "object", maxProperties: 256, additionalProperties: { type: "string" }, description: "ALE column to supported facility field: Scene, Shot, Take, Tape, CameraRoll, SoundRoll, LogNote, Comment or Description. Other fields are reported unsupported." },
        sources: { type: "array", maxItems: 2000, description: "Caller-reviewed bounded source catalog; duplicate filenames remain ambiguous.", items: object("Source identity", { id: text("Exact host source ID for later inspection."), file_name: text("Exact filename, no path expansion.") }) },
      }), annotations: readAnnotations,
      handler: async (args: { path: string; match_column: string; column_mapping: Record<string, string>; sources: unknown[] }) => result(() => {
        const { path, ...options } = args;
        return previewFacilityMetadataIntake(readBoundedInterchange(path).contents, options);
      }),
    },
    export_facility_metadata_table: {
      description: "Create a new bounded ALE facility metadata table from reviewed named field rows. Rejects duplicate columns, unknown row fields and tabs/newlines that ALE cannot safely represent. No project metadata is read or changed; verify downstream facility import separately.",
      parameters: object("ALE table export", { output_path: pathSchema, fps: text("Declared decimal frame rate up to 240; keep source rate provenance separately.", 32), columns: { type: "array", minItems: 1, maxItems: 256, uniqueItems: true, description: "Explicit unique column names.", items: text("ALE column name.", 64) }, rows: { type: "array", maxItems: 2000, description: "Reviewed table rows containing only declared column names and bounded string values.", items: { type: "object", additionalProperties: { type: "string", maxLength: 4096 }, description: "A bounded facility row; missing cells serialize as empty." } } }), annotations: writeAnnotations,
      handler: async (args: { output_path: string; fps: string; columns: string[]; rows: unknown[] }) => result(() => {
        const { output_path, ...options } = args;
        const contents = buildAle(options);
        return { ...writeNewInterchange(output_path, contents), rowCount: args.rows.length, destinationAcceptance: "not_run" };
      }),
    },
    plan_audio_post_turnover: {
      description: "Preview a bounded AAF/OMF audio-post turnover contract: exact exclusive range, handles, rational rate, channels, requested gain automation, media hashes and reference picture. Routes to existing native exporters. Caller manifests and exporter settings are not DAW acceptance or audible-alignment proof.",
      parameters: object("Audio-post turnover review", {
        format: { type: "string", enum: ["aaf", "omf"], description: "Existing native Premiere interchange exporter to review." }, sequence_id: text("Exact reviewed sequence identity."),
        range: object("Requested exclusive timeline range", { start_ticks: tickSchema, end_ticks: tickSchema }), rate: RATE_PARAMETER,
        handle_frames: { type: "integer", minimum: 0, maximum: 100000, description: "Requested media handles in sequence frames; verify source availability separately." }, sample_rate: { type: "integer", enum: [44100, 48000, 88200, 96000, 192000], description: "Requested audio-post sample rate." },
        channel_mapping: { type: "array", maxItems: 256, description: "Reviewed per-track channel mapping, which may require rendering unsupported host layouts.", items: object("Channel request", { track_id: text("Reviewed track identity."), source_channel: { type: "integer", minimum: 1, maximum: 128, description: "One-based input channel." }, destination_channel: { type: "integer", minimum: 1, maximum: 128, description: "One-based requested output channel." } }) },
        gain_automation: { type: "string", enum: ["preserve_requested", "render_requested", "unsupported"], description: "Declare requested gain handling and retain unsupported state." },
        media: { type: "array", maxItems: 2000, description: "Reviewed media manifest; fields remain caller evidence until file readback.", items: object("Media manifest entry", { id: text("Stable media ID."), file_name: text("Media filename, not a raw packet or path."), bytes: { type: "integer", minimum: 0, description: "Caller-recorded file byte size." }, sha256: text("Caller-recorded lowercase SHA-256.", 64), status: { type: "string", enum: ["available", "missing", "unverified"], description: "Caller-recorded dependency state." } }) },
        reference_picture: text("Optional reviewed reference-picture artifact ID/filename; verify its conformance separately."),
      }, ["format", "sequence_id", "range", "rate", "handle_frames", "sample_rate", "channel_mapping", "gain_automation", "media"]), annotations: readAnnotations,
      handler: async (args: Record<string, unknown>) => result(() => planAudioPostTurnover(args)),
    },
  };
}
