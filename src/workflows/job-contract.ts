import { createHash, randomUUID } from "node:crypto";
import { withInvocationContext } from "./invocation-context.js";

export type JobState = "queued" | "running" | "accepted" | "completed" | "failed" | "cancelled" | "unknown";
export interface WorkflowJob {
  version: 1; id: string; origin: "local" | "uxp" | "cep"; state: JobState; terminal: boolean;
  progress: number | null; nativeJobId?: string; lineageDigest: string;
  outputVerified: boolean; cancellation: "local_process" | "queued_only" | "unsupported_native";
  requiresReconciliation?: boolean;
  result?: unknown; error?: string;
}
const jobs = new Map<string, { job: WorkflowJob; controller?: AbortController }>();
export function resetWorkflowJobs(): void { jobs.clear(); }
function reserve(job: WorkflowJob, controller?: AbortController): void {
  if (jobs.size >= 64) {
    const finished = [...jobs].find(([, entry]) => entry.job.terminal);
    if (!finished) throw new Error("JOB_CAPACITY: 64 jobs still active; inspect existing jobs");
    jobs.delete(finished[0]);
  }
  jobs.set(job.id, { job, controller });
}
export function getWorkflowJob(id: string): WorkflowJob {
  const job = jobs.get(id)?.job;
  if (!job) throw new Error("JOB_UNKNOWN: receipt absent or expired; missing evidence does not mean success");
  return structuredClone(job);
}
export function startLocalJob(lineage: unknown, work: () => Promise<{ success: boolean; data?: unknown; error?: string }>): WorkflowJob {
  const controller = new AbortController();
  const job: WorkflowJob = { version: 1, id: randomUUID(), origin: "local", state: "queued", terminal: false, progress: null, lineageDigest: createHash("sha256").update(JSON.stringify(lineage)).digest("hex"), outputVerified: false, cancellation: "local_process" };
  reserve(job, controller);
  setImmediate(() => {
    if (job.state === "cancelled") return;
    job.state = "running";
    void withInvocationContext({ signal: controller.signal }, async () => {
      try {
        const result = await work();
        job.state = controller.signal.aborted ? "cancelled" : result.success ? "completed" : "failed";
        const serialized = JSON.stringify(result.data ?? null);
        job.result = Buffer.byteLength(serialized) <= 128 * 1024 ? result.data : {
          omitted: true, reason: "JOB_RESULT_LIMIT", maximumBytes: 128 * 1024,
          note: "Run the read-only analysis directly for its bounded result; the job receipt preserves completion only.",
        };
        job.error = result.error?.slice(0, 2048);
      } catch (error) { job.state = controller.signal.aborted ? "cancelled" : "failed"; job.error = (error instanceof Error ? error.message : String(error)).slice(0, 2048); }
      finally { job.terminal = true; }
    });
  });
  return structuredClone(job);
}
export function cancelWorkflowJob(id: string): WorkflowJob & { cancelRequested: boolean; nativeCancelled: false } {
  const entry = jobs.get(id);
  if (!entry) throw new Error("JOB_UNKNOWN: no tracked operation; nothing cancelled");
  if (entry.job.origin !== "local" || !entry.controller) return { ...getWorkflowJob(id), cancelRequested: false, nativeCancelled: false };
  const active = !entry.job.terminal;
  if (active) {
    entry.controller.abort();
    if (entry.job.state === "queued") { entry.job.state = "cancelled"; entry.job.terminal = true; }
  }
  return { ...getWorkflowJob(id), cancelRequested: active, nativeCancelled: false };
}
function canonicalNativeLineage(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("JOB_LINEAGE_INVALID: expected a bounded lineage object");
  const top = value as Record<string, unknown>, allowed = ["schemaVersion", "projectId", "sequenceId", "projectItemId", "inputFile", "outputFile", "presetFile", "exportType", "range", "removeUponCompletion", "startQueueImmediately"];
  if (top.schemaVersion !== "premiere-mcp.encoder-lineage.v1" || Object.keys(top).some(key => !allowed.includes(key))) throw new Error("JOB_LINEAGE_INVALID: unsupported schema or fields");
  const range = top.range;
  if (!range || typeof range !== "object" || Array.isArray(range) || Object.keys(range).some(key => !["mode", "inTicks", "outTicks", "inSeconds", "outSeconds", "workArea", "endPolicy"].includes(key))) throw new Error("JOB_LINEAGE_INVALID: unsupported range fields");
  const bounds = range as Record<string, unknown>;
  if (!["full_sequence", "sequence_marks", "project_item_work_area", "file_range"].includes(bounds.mode as string) || !["exclusive", "native_range_unverified"].includes(bounds.endPolicy as string)) throw new Error("JOB_LINEAGE_INVALID: unsupported range policy");
  for (const key of ["inTicks", "outTicks"]) if (bounds[key] != null && (typeof bounds[key] !== "string" || !/^-?(0|[1-9][0-9]{0,39})$/.test(bounds[key] as string))) throw new Error("JOB_LINEAGE_INVALID: invalid tick string");
  for (const key of ["inSeconds", "outSeconds"]) if (bounds[key] != null && (typeof bounds[key] !== "number" || !Number.isFinite(bounds[key]) || Number(bounds[key]) < 0 || Number(bounds[key]) > 86400)) throw new Error("JOB_LINEAGE_INVALID: invalid range seconds");
  if (bounds.workArea != null && (!Number.isInteger(bounds.workArea) || Number(bounds.workArea) < 0 || Number(bounds.workArea) > 16)) throw new Error("JOB_LINEAGE_INVALID: invalid work area");
  for (const key of ["removeUponCompletion", "startQueueImmediately"]) if (top[key] != null && typeof top[key] !== "boolean") throw new Error("JOB_LINEAGE_INVALID: invalid queue flag");
  let nodes = 0;
  const visit = (entry: unknown, depth: number): unknown => {
    if (++nodes > 256 || depth > 4) throw new Error("JOB_LINEAGE_INVALID: lineage exceeds node/depth limits");
    if (entry === null || typeof entry === "boolean") return entry;
    if (typeof entry === "string" && entry.length <= 4096 && !entry.includes("\0")) return entry;
    if (typeof entry === "number" && Number.isFinite(entry)) return entry;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("JOB_LINEAGE_INVALID: unsupported lineage value");
    const entries = Object.entries(entry).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    if (entries.some(([key]) => ["__proto__", "constructor", "prototype"].includes(key))) throw new Error("JOB_LINEAGE_INVALID: unsafe property");
    return Object.fromEntries(entries.map(([key, child]) => [key, visit(child, depth + 1)]));
  };
  const canonical = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(canonical)) > 16 * 1024) throw new Error("JOB_LINEAGE_INVALID: lineage exceeds byte limit");
  return canonical;
}
export function normalizeNativeJob(value: unknown, expectedId: string): WorkflowJob {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const raw = data.job ?? (Array.isArray(data.jobs) ? data.jobs.find(item => item?.jobId === expectedId) : null);
  if (!raw || typeof raw !== "object" || (raw as Record<string, unknown>).jobId !== expectedId) throw new Error("JOB_IDENTITY_UNKNOWN: response cannot be attributed to the requested job");
  const job = raw as Record<string, unknown>;
  const lineage = canonicalNativeLineage(job.lineage);
  const nativeJobId = typeof job.nativeJobId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(job.nativeJobId) ? job.nativeJobId : undefined;
  const correlationVerified = job.correlationVerified === true && nativeJobId !== undefined;
  const observedState = typeof job.state === "string" ? job.state.slice(0, 128) : null;
  const observedTerminal = typeof job.terminal === "boolean" ? job.terminal : null;
  const receiptState: JobState = job.state === "rendering" ? "running" : job.state === "completed" || job.state === "failed" || job.state === "cancelled" || job.state === "accepted" || job.state === "running" || job.state === "queued" ? job.state : "unknown";
  const terminalState = ["completed", "failed", "cancelled"].includes(receiptState);
  // The operation receipt can retain a generic encoder event without attributing
  // that event to the exact accepted native job.
  const requiresReconciliation = !correlationVerified && (terminalState || observedTerminal === true);
  const state: JobState = requiresReconciliation ? "unknown" : receiptState;
  return {
    version: 1, id: expectedId, ...(nativeJobId ? { nativeJobId } : {}), origin: "uxp", state,
    terminal: correlationVerified && observedTerminal === true && terminalState,
    progress: typeof job.progress === "number" && Number.isFinite(job.progress) && job.progress >= 0 && job.progress <= 1 ? job.progress * 100 : null,
    lineageDigest: lineage == null ? "not_recorded" : createHash("sha256").update(JSON.stringify(lineage)).digest("hex"),
    outputVerified: false, cancellation: "unsupported_native", requiresReconciliation,
    result: {
      lineage, correlationVerified, observedState, observedTerminal,
      correlationBoundary: correlationVerified ? "actual_native_job_id_and_verified_host_correlation" : "native_job_id_or_verified_correlation_missing",
      verificationBoundary: job.verificationBoundary ?? "encoder_event_only",
      attribution: job.correlationBoundary ?? data.correlation ?? "native_tracker",
    },
  };
}
