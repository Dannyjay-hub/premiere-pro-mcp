import { fromJsonSchema, type JsonSchemaType } from "@modelcontextprotocol/server";
import type { BridgeOptions } from "../bridge/file-bridge.js";
import { sendCommand } from "../bridge/file-bridge.js";
import { runWithExpectedHostTarget, runWithExpectedProject } from "../bridge/project-guard.js";
import { buildToolScript, escapeForExtendScript } from "../bridge/script-builder.js";
import type { UxpWebSocketBridge } from "../bridge/uxp-websocket-bridge.js";
import { capabilitiesForToolInvocation, guardToolHandler, resolveCapabilities, type CapabilityConfig } from "../security/capabilities.js";
import { deriveToolOperationalCapability, type CatalogToolDefinition } from "../tool-capability-report.js";
import { strictDeclaredObjects, argumentDiagnostics } from "../workflows/strict-schema.js";
import { assertInvocationNotCancelled, measureStage, reportProgress } from "../workflows/invocation-context.js";
import { performanceDiagnostics } from "../workflows/performance-diagnostics.js";
import { analysisCacheDiagnostics } from "../workflows/analysis-cache.js";
import { createReviewClip, snapshotArtifact, assertArtifactUnchanged, hashStableArtifact, publishArtifactExclusive, removeOwnedStaging, type ArtifactSnapshot } from "../workflows/review-artifacts.js";
import { startLocalJob, getWorkflowJob, cancelWorkflowJob, normalizeNativeJob } from "../workflows/job-contract.js";
import { inspectExportPresetFile, validateDeliveryConformanceContract } from "./export.js";
import { statSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";

type Result = { success: boolean; data?: unknown; error?: string };
type Tool = CatalogToolDefinition & { parameters: Record<string, unknown>; handler: (args: any) => Promise<Result> };
const local = { backend: "local" as const, backends: ["local" as const], minimumPremiereVersion: null, verificationBoundary: "local_filesystem" as const, hostVerificationRequired: false };
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const token = { type: "string", minLength: 1, maxLength: 128, description: "Exact tracked job ID; missing receipts never imply completion." };
const failure = (error: unknown): Result => ({ success: false, error: error instanceof Error ? error.message : String(error) });
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const LOCAL_ANALYSIS = ["inspect_media_streams", "detect_audio_transients", "detect_motion_peaks", "read_video_scopes", "analyze_video_interlacing", "detect_active_picture_bounds"];

export function getExecutionWorkflowTools(bridgeOptions: BridgeOptions, options: { getToolCatalog: () => Record<string, Tool>; capabilities?: CapabilityConfig; uxpBridge?: UxpWebSocketBridge }) {
  const capabilities = options.capabilities ?? resolveCapabilities();
  async function validateInvocation(name: string, args: Record<string, unknown>): Promise<Tool> {
    const tool = options.getToolCatalog()[name];
    if (!tool) throw new Error(`TOOL_UNAVAILABLE: ${name} is not registered in this session`);
    const schema = strictDeclaredObjects(tool.parameters);
    const diagnostics = argumentDiagnostics(args, schema);
    if (diagnostics.length) throw new Error(diagnostics.join("; "));
    const validation = await fromJsonSchema(schema as JsonSchemaType)["~standard"].validate(args);
    if ("issues" in validation && validation.issues) throw new Error(`INVALID_ARGUMENT: ${validation.issues.map(issue => issue.message).join("; ")}`);
    for (const authority of capabilitiesForToolInvocation(name, args)) if (!capabilities.capabilities.has(authority)) throw new Error(`AUTHORITY_DENIED: ${name} requires ${authority}`);
    return tool;
  }
  async function invoke(name: string, args: Record<string, unknown>): Promise<Result> {
    const tool = await validateInvocation(name, args);
    assertInvocationNotCancelled();
    return guardToolHandler(name, tool.handler, capabilities)(args);
  }
  async function confirmArtifactChecksum(path: string, snapshot: ArtifactSnapshot, evidence: unknown): Promise<void> {
    const checksum = record(record(evidence).checksum);
    if (checksum.algorithm !== "sha256" || typeof checksum.value !== "string" || !/^[a-f0-9]{64}$/.test(checksum.value)) throw new Error("ARTIFACT_CHECKSUM_UNKNOWN: require an exact SHA-256 receipt");
    if (await hashStableArtifact(path, snapshot) !== checksum.value) throw new Error("ARTIFACT_CHECKSUM_CHANGED: composed evidence does not describe the same artifact");
  }
  return {
    can_execute: {
      description: "Validate an exact tool invocation, authority, live backend and bounded CEP targets without applying it. Returns named refusal/unknown reasons and evidence age; preflight is advisory and must be revalidated at dispatch.",
      annotations: read,
      parameters: { type: "object", additionalProperties: false, properties: {
        tool_name: { type: "string", minLength: 1, maxLength: 128, description: "Registered tool to preflight." },
        arguments: { type: "object", additionalProperties: true, description: "Exact proposed tool arguments; validated against that tool's schema." },
        expected_project_path: { type: "string", maxLength: 4096, description: "Saved CEP project path expected at inspection." },
        expected_sequence_id: { type: "string", maxLength: 128, description: "Expected CEP active sequence ID, never a synthetic snapshot ID." },
      }, required: ["tool_name", "arguments"] },
      handler: async (args: { tool_name: string; arguments: Record<string, unknown>; expected_project_path?: string; expected_sequence_id?: string }) => {
        const startedAt = Date.now();
        const reasons: Array<{ code: string; detail: string }> = [];
        const tool = options.getToolCatalog()[args.tool_name];
        if (!tool || args.tool_name === "can_execute") return { success: true, data: { enabled: false, reasons: [{ code: "TOOL_UNAVAILABLE", detail: "Choose a registered editing or inspection tool." }], inspectedAt: new Date().toISOString(), evidenceAgeMs: 0 } };
        const schema = strictDeclaredObjects(tool.parameters);
        const diagnostics = argumentDiagnostics(args.arguments, schema);
        const valid = await fromJsonSchema(schema as JsonSchemaType)["~standard"].validate(args.arguments);
        if ("issues" in valid && valid.issues) reasons.push({ code: "INVALID_ARGUMENT", detail: [...diagnostics, ...valid.issues.map(issue => issue.message)].join("; ").slice(0,2048) });
        for (const authority of capabilitiesForToolInvocation(args.tool_name, args.arguments)) if (!capabilities.capabilities.has(authority)) reasons.push({ code: "AUTHORITY_DENIED", detail: `Invocation requires ${authority}.` });
        const operational = deriveToolOperationalCapability(args.tool_name, tool, capabilities);
        if (operational.status === "unsupported") reasons.push({ code: "API_UNAVAILABLE", detail: "This tool is explicitly unsupported on the selected route." });
        const isLocal = operational.backends.length === 1 && operational.backends[0] === "local";
        for (const field of ["media_path", "input_path", "artifact_path"] as const) {
          if (!reasons.length && typeof args.arguments[field] === "string" && capabilities.capabilities.has("filesystem")) {
            try { if (!statSync(args.arguments[field]).isFile()) throw new Error("Input must be a file"); }
            catch (error) { reasons.push({ code: "INPUT_FILE_UNAVAILABLE", detail: `${field}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2048) }); }
          }
        }
        let state: unknown = null;
        if (!reasons.length && !isLocal) {
          if (operational.backends.includes("uxp")) {
            const bridge = options.uxpBridge;
            if (!bridge?.getState().connected) reasons.push({ code: "BACKEND_UNAVAILABLE", detail: "Connect the authenticated UXP panel." });
            else {
              try { await bridge.refreshCapabilities(); state = await bridge.request("state.get"); }
              catch (error) { reasons.push({ code: "HOST_STATE_UNKNOWN", detail: error instanceof Error ? error.message : String(error) }); }
              // Tool handlers own format/action-specific native API probes.
              reasons.push({ code: "ACTION_PREFLIGHT_REQUIRED", detail: "Runtime state is available; use this UXP tool's inspect/preflight action to bind native target/API prerequisites before mutation." });
            }
          } else {
            const input = args.arguments;
            const clip = typeof input.clip_id === "string" ? input.clip_id : typeof input.node_id === "string" ? input.node_id : "";
            const item = typeof input.item_id === "string" ? input.item_id : typeof input.project_item_id === "string" ? input.project_item_id : "";
            const sequence = args.expected_sequence_id ?? (typeof input.expected_sequence_id === "string" ? input.expected_sequence_id : "");
            const project = args.expected_project_path ?? "";
            const needsSelection = /selected|selection/.test(args.tool_name);
            const targetScript = buildToolScript(`
              var reasons = []; var project = app.project; var seq = project ? project.activeSequence : null;
              if (!project) reasons.push({code:"PROJECT_MISSING",detail:"Open a project."});
              if ("${escapeForExtendScript(project)}" && (!project || String(project.path) !== "${escapeForExtendScript(project)}")) reasons.push({code:"STALE_PROJECT",detail:"Active project differs from reviewed target."});
              if ("${escapeForExtendScript(sequence)}" && (!seq || String(seq.sequenceID) !== "${escapeForExtendScript(sequence)}")) reasons.push({code:"STALE_SEQUENCE",detail:"Active sequence differs from reviewed target."});
              if (${needsSelection ? "true" : "false"} && (!seq || !seq.getSelection || !seq.getSelection().length)) reasons.push({code:"SELECTION_MISSING",detail:"Select exact timeline targets first."});
              var found = "${escapeForExtendScript(clip)}" ? __findClip("${escapeForExtendScript(clip)}") : null;
              if ("${escapeForExtendScript(clip)}" && !found) reasons.push({code:"TARGET_MISSING",detail:"Reviewed clip is absent from active sequence."});
              if (found) { var tracks = found.trackType === "video" ? seq.videoTracks : seq.audioTracks; var track = tracks[found.trackIndex];
                if (typeof track.isLocked !== "function") reasons.push({code:"LOCK_STATE_UNKNOWN",detail:"Host cannot inspect this track lock."});
                else if (track.isLocked()) reasons.push({code:"TRACK_LOCKED",detail:"Target track is locked."});
              }
              var item = "${escapeForExtendScript(item)}" ? __findProjectItemByNodeId("${escapeForExtendScript(item)}", project.rootItem) : (found ? found.clip.projectItem : null);
              if ("${escapeForExtendScript(item)}" && !item) reasons.push({code:"SOURCE_MISSING",detail:"Reviewed project item is absent."});
              if (item && typeof item.isOffline === "function" && item.isOffline()) reasons.push({code:"SOURCE_OFFLINE",detail:"Relink source media before editing."});
              return __result({reasons:reasons, sequenceId:seq ? String(seq.sequenceID) : null, target:found ? {nodeId:String(found.clip.nodeId),trackIndex:found.trackIndex,trackType:found.trackType,startTicks:String(found.clip.start.ticks),endTicks:String(found.clip.end.ticks)} : null});
            `);
            const result = await sendCommand(targetScript, bridgeOptions);
            if (!result.success) reasons.push({ code: "BACKEND_UNAVAILABLE", detail: result.error ?? "CEP read failed" });
            else { state = result.data; const host = record(result.data); if (Array.isArray(host.reasons)) reasons.push(...host.reasons as typeof reasons); }
          }
        }
        if (!reasons.length && capabilities.capabilities.has("filesystem") && typeof args.arguments.preset_path === "string") { try { inspectExportPresetFile(args.arguments.preset_path); } catch (error) { reasons.push({ code: "EXPORT_PRESET_INVALID", detail: error instanceof Error ? error.message : String(error) }); } }
        return { success: true, data: { version: 1, enabled: reasons.length === 0, reasons, state, inspectedAt: new Date().toISOString(), evidenceAgeMs: Date.now() - startedAt, requiredAuthority: capabilitiesForToolInvocation(args.tool_name, args.arguments), requiredState: operational.notes, dispatchRevalidationRequired: true, verificationBoundary: isLocal ? "local_schema_authority" : "bounded_prerequisite_inspection; tool-specific constraints still apply" } };
      },
    },
    get_operation_performance: { description: "Read content-free local median/p95 stage timing, payload sizes, and bounded analysis cache occupancy. Missing measurements remain unknown.", annotations: read, operationalCapability: local,
      parameters: { type: "object", properties: {} }, handler: async () => ({ success: true, data: { ...performanceDiagnostics(), analysisCache: analysisCacheDiagnostics() } }) },
    start_local_analysis_job: { description: "Start one allowlisted read-only local media analysis as a bounded cancellable process job. Native Premiere jobs are never cancelled by this tool.", operationalCapability: local,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      parameters: { type: "object", properties: { tool_name: { type: "string", enum: LOCAL_ANALYSIS, description: "Supported local analysis worker." }, arguments: { type: "object", additionalProperties: true, description: "Exact analysis arguments, schema and authority checked before worker dispatch." } }, required: ["tool_name", "arguments"] },
      handler: async (args: { tool_name: string; arguments: Record<string, unknown> }) => { try { if (!LOCAL_ANALYSIS.includes(args.tool_name)) throw new Error("LOCAL_JOB_TOOL_REFUSED"); await validateInvocation(args.tool_name, args.arguments); return { success: true, data: { ...startLocalJob([args.tool_name, args.arguments], () => invoke(args.tool_name, args.arguments)), accepted: true, outcome: "committed", verificationBoundary: "local_job_reservation_only; worker_pending" } }; } catch (error) { return failure(error); } } },
    inspect_workflow_job: { description: "Inspect exact local or UXP job identity. Host terminal events do not verify an output artifact; an absent job is unknown, never completed.", annotations: read,
      parameters: { type: "object", properties: { job_id: token, origin: { type: "string", enum: ["local", "uxp"], description: "Receipt owner backend; never silently changes route." } }, required: ["job_id", "origin"] },
      handler: async (args: { job_id: string; origin: "local" | "uxp" }) => { try { if (args.origin === "local") return { success: true, data: getWorkflowJob(args.job_id) }; if (!options.uxpBridge) throw new Error("UXP_BACKEND_UNAVAILABLE"); return { success: true, data: normalizeNativeJob(await options.uxpBridge.request("encoder.jobs", { jobId: args.job_id, limit: 1 }), args.job_id) }; } catch (error) { return failure(error); } } },
    wait_workflow_job: { description: "Wait up to 60 seconds for an exact native or local job. An uncorrelated native terminal event stops observation with requiresReconciliation, never verified completion. Optional MCP progress reports observed receipt progress. Stopping the wait never cancels accepted native work.", annotations: read,
      parameters: { type: "object", properties: { job_id: token, origin: { type: "string", enum: ["local", "uxp"], description: "Receipt owner backend." }, timeout_ms: { type: "integer", minimum: 0, maximum: 60000, description: "Bounded observation wait, default 10000 ms." } }, required: ["job_id", "origin"] },
      handler: async (args: { job_id: string; origin: "local" | "uxp"; timeout_ms?: number }) => { try {
        const timeout = args.timeout_ms ?? 10000;
        if (!Number.isInteger(timeout) || timeout < 0 || timeout > 60000) throw new Error("WAIT_LIMIT: timeout_ms must be 0..60000");
        const end = Date.now() + timeout;
        let job;
        do {
          assertInvocationNotCancelled();
          if (args.origin === "local") job = getWorkflowJob(args.job_id);
          else { if (!options.uxpBridge) throw new Error("UXP_BACKEND_UNAVAILABLE"); job = normalizeNativeJob(await options.uxpBridge.request("encoder.wait", { jobId: args.job_id, timeoutMs: Math.min(1000, Math.max(0,end-Date.now())) }, { minimumTimeoutMs: 6000 }), args.job_id); }
          if (job.progress !== null) await reportProgress(job.progress, 100, "Observed job receipt progress; output verification remains separate.");
          if (job.terminal || job.requiresReconciliation || Date.now() >= end) break;
          if (args.origin === "local") await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(0,end-Date.now()))));
        } while (Date.now() < end);
        return { success: true, data: { job, timedOut: !job?.terminal && !job?.requiresReconciliation, requiresReconciliation: job?.requiresReconciliation === true, nativeCancelled: false } };
      } catch (error) { return failure(error); } } },
    cancel_workflow_job: { description: "Request cancellation of an owned local process or undispatched local job. Native Premiere/AME cancellation is unsupported; no queue is cleared and no output file is deleted.",
      parameters: { type: "object", properties: { job_id: token }, required: ["job_id"] }, handler: async (args: { job_id: string }) => { try { return { success: true, data: cancelWorkflowJob(args.job_id) }; } catch (error) { return failure(error); } } },
    export_and_verify: { description: "Preflight and directly render a guarded CEP sequence, then independently hash and probe the exact output against a delivery contract and optional decoded QC. Refuses existing destinations; never treats queue acceptance as completion.",
      parameters: { type: "object", additionalProperties: false, properties: {
        output_path: { type: "string", minLength: 1, maxLength: 4096, description: "New absolute delivery destination, with extension matching the preset." },
        preset_path: { type: "string", minLength: 1, maxLength: 4096, description: "Explicit validated AME .epr preset." },
        range: { type: "string", enum: ["entire", "in_to_out", "work_area"], description: "Reviewed existing sequence range; this workflow never changes marks." },
        timeout_minutes: { type: "number", minimum: 1, maximum: 240, description: "Native direct-export timeout, default 15 minutes." },
        contract: { type: "object", additionalProperties: true, description: "verify_delivery_conformance arguments except output_path; checked before export." },
        decoded_qc: { type: "boolean", description: "Run existing decoded black/freeze/silence QC after conformance (default false)." },
      }, required: ["output_path", "preset_path", "contract"] },
      handler: async (args: { output_path: string; preset_path: string; range?: string; timeout_minutes?: number; contract: Record<string, unknown>; decoded_qc?: boolean }) => {
        const steps: unknown[] = []; const operationId = randomUUID();
        try {
          for (const name of ["export_sequence", "verify_delivery_file", "verify_delivery_conformance", ...(args.decoded_qc ? ["analyze_video_qc"] : [])]) for (const authority of capabilitiesForToolInvocation(name, {})) if (!capabilities.capabilities.has(authority)) throw new Error(`AUTHORITY_DENIED: ${name} requires ${authority}`);
          if (!isAbsolute(args.output_path) || existsSync(args.output_path)) throw new Error("OUTPUT_NOT_NEW: choose a new absolute destination");
          inspectExportPresetFile(args.preset_path);
          const contract = record(args.contract);
          if ("output_path" in contract) throw new Error("CONTRACT_TARGET_CONFLICT: output_path is owned by the workflow");
          const conformanceTool = options.getToolCatalog().verify_delivery_conformance;
          if (!conformanceTool) throw new Error("CONFORMANCE_TOOL_UNAVAILABLE");
          const validation = await fromJsonSchema(strictDeclaredObjects(conformanceTool.parameters) as JsonSchemaType)["~standard"].validate({ ...contract, output_path: args.output_path });
          if ("issues" in validation && validation.issues) throw new Error(`INVALID_DELIVERY_CONTRACT: ${validation.issues.map(issue => issue.message).join("; ")}`);
          const semanticError = validateDeliveryConformanceContract(Object.fromEntries(Object.entries(contract).map(([key, value]) => [key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()), value])));
          if (semanticError) throw new Error(`INVALID_DELIVERY_CONTRACT: ${semanticError}`);
          const preflight = await invoke("validate_project_for_export", { output_path: args.output_path, preset_path: args.preset_path }); steps.push({ stage: "preflight", ...preflight });
          if (!preflight.success || record(preflight.data).readyForExport !== true) return { success: false, error: "EXPORT_PREFLIGHT_REFUSED", data: { outcome: "not_applied", dispatched: false, operationId, steps } };
          const identity = record(record(preflight.data).summary);
          if (typeof identity.sequenceId !== "string" || !identity.sequenceId || typeof identity.projectDocumentId !== "string" || !identity.projectDocumentId || typeof identity.projectPath !== "string" || !isAbsolute(identity.projectPath)) throw new Error("EXPORT_IDENTITY_UNKNOWN: save the project and inspect an exact project/sequence receipt first");
          await reportProgress(1, 4, "Export preflight passed; rendering next.");
          const rendered = await runWithExpectedProject(identity.projectPath, () => runWithExpectedHostTarget({ backend: "cep", sequence_id: identity.sequenceId, project_document_id: identity.projectDocumentId }, () => invoke("export_sequence", { output_path: args.output_path, preset_path: args.preset_path, ...(args.range ? { range: args.range } : {}), ...(args.timeout_minutes ? { timeout_minutes: args.timeout_minutes } : {}) }))); steps.push({ stage: "render", ...rendered });
          if (!rendered.success) return { success: false, error: rendered.error, data: { outcome: "unknown", operationId, steps, recoveryRequired: true } };
          const output = record(rendered.data); const outputPath = typeof output.outputPath === "string" ? output.outputPath : args.output_path;
          // No other file, queue job, or older output may complete this workflow.
          if (outputPath !== args.output_path) throw new Error("OUTPUT_IDENTITY_CHANGED: inspect native receipt before validation");
          const outputSnapshot = snapshotArtifact(outputPath);
          await reportProgress(2, 4, "Native render returned; validating exact artifact.");
          assertArtifactUnchanged(outputPath, outputSnapshot);
          const artifact = await measureStage("artifact_validation", () => invoke("verify_delivery_file", { output_path: outputPath })); steps.push({ stage: "artifact", ...artifact });
          assertArtifactUnchanged(outputPath, outputSnapshot);
          if (!artifact.success || record(artifact.data).valid !== true) throw new Error(artifact.error ?? "DELIVERY_ARTIFACT_INVALID");
          const conformance = await measureStage("artifact_validation", () => invoke("verify_delivery_conformance", { ...contract, output_path: outputPath })); steps.push({ stage: "conformance", ...conformance });
          assertArtifactUnchanged(outputPath, outputSnapshot);
          let qc: Result | undefined; if (args.decoded_qc) { qc = await invoke("analyze_video_qc", { media_path: outputPath }); steps.push({ stage: "decoded_qc", ...qc }); assertArtifactUnchanged(outputPath, outputSnapshot); }
          await confirmArtifactChecksum(outputPath, outputSnapshot, artifact.data);
          const valid = artifact.success && record(artifact.data).valid === true && conformance.success && record(conformance.data).conforms === true && (!qc || (qc.success && record(qc.data).passes === true));
          await reportProgress(4, 4, "Artifact checks returned; inspect per-check results.");
          assertArtifactUnchanged(outputPath, outputSnapshot);
          return { success: valid, ...(valid ? {} : { error: "DELIVERY_CHECK_FAILED: rendered artifact needs review" }), data: { version: 1, operationId, outcome: valid ? "verified" : "committed_unverified", steps, outputEvidence: artifact.data, lineage: { digest: createHash("sha256").update(JSON.stringify([identity.projectDocumentId,identity.projectPath,identity.sequenceId,args.output_path,args.preset_path,args.range ?? "entire",output.rangeStartSeconds,output.expectedDurationSeconds])).digest("hex"), projectDocumentId: identity.projectDocumentId, sequenceId: identity.sequenceId, range: output.range, durationSeconds: output.expectedDurationSeconds, nativeJobCorrelation: "synchronous_direct_export" }, renderVerified: false, verificationScope: "Fresh native direct-export receipt plus exact artifact hash/conformance; visual quality remains unverified." } };
        } catch (error) { return { ...failure(error), data: { operationId, steps, outcome: steps.some(step => record(step).stage === "render") ? "committed_unverified" : "not_applied" } }; }
      },
    },
    inspect_rendered_video_scopes: { description: "Sample a caller-owned exported video using existing decoded RGB scopes and declare range/transfer/primaries evidence. Refuses HDR legal-range claims from an 8-bit RGB proxy; does not prove Premiere render lineage.", annotations: read, operationalCapability: local,
      parameters: { type: "object", properties: { output_path: { type: "string", description: "Existing rendered video to sample." }, time_seconds: { type: "number", minimum: 0, maximum: 86400, description: "Output-relative sample time, default zero." }, color_range: { type: "string", enum: ["limited", "full", "unknown"], description: "Caller-declared encoded range; validated metadata is separate." }, color_transfer: { type: "string", maxLength: 128, description: "Caller-declared transfer function (PQ/HLG remain unsupported for legal-range conclusions)." }, color_primaries: { type: "string", maxLength: 128, description: "Caller-declared primaries." } }, required: ["output_path"] },
      handler: async (args: { output_path: string; time_seconds?: number; color_range?: string; color_transfer?: string; color_primaries?: string }) => { try { const before = snapshotArtifact(args.output_path, "OUTPUT"); const metadata = await invoke("inspect_media_streams", { media_path: args.output_path }); assertArtifactUnchanged(args.output_path, before, "OUTPUT"); const streams = record(metadata.data).streams; const video = Array.isArray(streams) ? streams.find(stream => record(stream).codec_type === "video") : null; const scopes = await invoke("read_video_scopes", { media_path: args.output_path, time_seconds: args.time_seconds ?? 0 }); assertArtifactUnchanged(args.output_path, before, "OUTPUT"); return { ...scopes, data: { scopes: scopes.data, domain: "decoded_output_rgb_proxy", color: { declared: { range: args.color_range ?? "unknown", transfer: args.color_transfer ?? "unknown", primaries: args.color_primaries ?? "unknown" }, encodedMetadata: { range: record(video).color_range ?? "unknown", transfer: record(video).color_transfer ?? "unknown", primaries: record(video).color_primaries ?? "unknown" }, evidence: "ffprobe_metadata_and_caller_declaration; RGB_conversion_is_not_HDR_measurement" }, legalRangeVerified: false, hdrVerified: false, renderLineageVerified: false } }; } catch (error) { return failure(error); } } },
    build_edit_review_evidence: { description: "Create new before/after contact sheets, optional bounded MP4 excerpts, and checksum receipts from two reviewed rendered videos. Supports visual review of cuts, transitions, titles and masks; still grids do not verify temporal behavior or authenticate host lineage.", operationalCapability: local,
      parameters: { type: "object", properties: {
        before_video: { type: "string", minLength: 1, maxLength: 4096, description: "Existing rendered video captured before the edit." },
        after_video: { type: "string", minLength: 1, maxLength: 4096, description: "Existing rendered video captured after the edit." },
        before_sheet: { type: "string", minLength: 1, maxLength: 4096, description: "New before .png contact-sheet destination." },
        after_sheet: { type: "string", minLength: 1, maxLength: 4096, description: "New after .png contact-sheet destination." },
        before_review_clip: { type: "string", maxLength: 4096, description: "Optional new absolute before .mp4 excerpt destination; requires after_review_clip." },
        after_review_clip: { type: "string", maxLength: 4096, description: "Optional distinct new absolute after .mp4 excerpt destination; requires before_review_clip." },
        review_start_seconds: { type: "number", minimum: 0, maximum: 86400, description: "Output-relative excerpt start, default zero." },
        review_duration_seconds: { type: "number", exclusiveMinimum: 0, maximum: 30, description: "Bounded review excerpt duration, default three seconds." },
        operation_revision: { type: "string", minLength: 1, maxLength: 128, description: "Reviewed operation/snapshot revision that this evidence accompanies; declared, not host-authenticated." },
      }, required: ["before_video", "after_video", "before_sheet", "after_sheet", "operation_revision"] },
      handler: async (args: { before_video: string; after_video: string; before_sheet: string; after_sheet: string; operation_revision: string; before_review_clip?: string; after_review_clip?: string; review_start_seconds?: number; review_duration_seconds?: number }) => {
        const steps: unknown[] = [];
        try {
          if (args.before_sheet === args.after_sheet || existsSync(args.before_sheet) || existsSync(args.after_sheet)) throw new Error("REVIEW_OUTPUT_EXISTS: choose distinct new PNG destinations");
          if (!!args.before_review_clip !== !!args.after_review_clip || (args.before_review_clip && (args.before_review_clip === args.after_review_clip || existsSync(args.before_review_clip) || existsSync(args.after_review_clip!)))) throw new Error("REVIEW_CLIP_TARGETS: provide distinct new before and after destinations together");
          const sources = [
            { phase: "before", video: args.before_video, sheet: args.before_sheet, snapshot: snapshotArtifact(args.before_video), evidence: undefined as unknown },
            { phase: "after", video: args.after_video, sheet: args.after_sheet, snapshot: snapshotArtifact(args.after_video), evidence: undefined as unknown },
          ];
          const publishedArtifacts: Array<{ path: string; snapshot: ArtifactSnapshot; sha256: string }> = [];
          for (const source of sources) {
            const { phase, video, sheet, snapshot } = source;
            assertArtifactUnchanged(video, snapshot);
            const evidence = await invoke("verify_delivery_file", { output_path: video }); if (!evidence.success || record(evidence.data).valid !== true) throw new Error(evidence.error ?? "REVIEW_ARTIFACT_INVALID");
            source.evidence = evidence.data;
            assertArtifactUnchanged(video, snapshot);
            const staging = join(dirname(sheet), `.mcp-review-${randomUUID()}.png`);
            let staged: ArtifactSnapshot | undefined;
            try {
              const contact = await invoke("generate_media_contact_sheet", { media_path: video, output_path: staging });
              steps.push({ phase, evidence: evidence.data, contact: contact.data, published: false });
              if (!contact.success) throw new Error(contact.error);
              staged = snapshotArtifact(staging, "REVIEW_CONTACT_SHEET", 128 * 1024 * 1024);
              assertArtifactUnchanged(video, snapshot);
              const sha256 = await hashStableArtifact(staging, staged, "REVIEW_CONTACT_SHEET");
              assertArtifactUnchanged(video, snapshot);
              await confirmArtifactChecksum(video, snapshot, evidence.data);
              const published = await publishArtifactExclusive(staging, sheet, staged, sha256);
              steps[steps.length - 1] = { phase, evidence: evidence.data, contact: { ...record(contact.data), outputPath: sheet, sha256, sizeBytes: staged.size }, published: true };
              removeOwnedStaging(staging, staged);
              // Removing our staging hardlink changes ctime again. Pin the
              // remaining output, while retaining the exact published inode.
              const remaining = snapshotArtifact(sheet, "REVIEW_PUBLICATION", staged.size);
              if (remaining.dev !== published.dev || remaining.ino !== published.ino || remaining.size !== published.size || remaining.mtimeMs !== published.mtimeMs) throw new Error("REVIEW_PUBLICATION_CHANGED: destination changed after publication");
              publishedArtifacts.push({ path: sheet, snapshot: remaining, sha256 });
              assertArtifactUnchanged(video, snapshot);
            } finally { removeOwnedStaging(staging, staged); }
            const excerptPath = phase === "before" ? args.before_review_clip : args.after_review_clip;
            if (excerptPath) { const excerpt = await createReviewClip(video, excerptPath, args.review_start_seconds ?? 0, args.review_duration_seconds ?? 3); steps.push({phase,excerpt}); publishedArtifacts.push({ path: excerpt.path, snapshot: snapshotArtifact(excerpt.path, "REVIEW_PUBLICATION", 128 * 1024 * 1024), sha256: excerpt.sha256 }); }
            assertArtifactUnchanged(video, snapshot);
          }
          for (const source of sources) await confirmArtifactChecksum(source.video, source.snapshot, source.evidence);
          for (const artifact of publishedArtifacts) if (await hashStableArtifact(artifact.path, artifact.snapshot, "REVIEW_PUBLICATION") !== artifact.sha256) throw new Error("REVIEW_PUBLICATION_CHANGED: review output checksum changed between stages");
          for (const source of sources) assertArtifactUnchanged(source.video, source.snapshot);
          for (const artifact of publishedArtifacts) assertArtifactUnchanged(artifact.path, artifact.snapshot, "REVIEW_PUBLICATION");
          return { success: true, data: { version: 1, outcome: "verified", reviewId: randomUUID(), operationRevision: args.operation_revision, steps, renderVerified: false, verificationScope: "Two exact rendered-artifact checksum receipts plus freshly generated still grids. Use verify_temporal_render_artifact for decoded motion samples." } };
        } catch (error) { return { ...failure(error), data: { steps, outcome: steps.length ? "committed_unverified" : "not_applied" } }; }
      } },
  };
}
