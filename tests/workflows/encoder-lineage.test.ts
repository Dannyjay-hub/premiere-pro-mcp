import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { normalizeNativeJob } from "../../src/workflows/job-contract.js";

const require = createRequire(import.meta.url), Events = require("../../uxp-plugin/events.cjs");
const lineage = { schemaVersion: "premiere-mcp.encoder-lineage.v1", projectId: "project-1", sequenceId: "sequence-1", projectItemId: null, inputFile: null, outputFile: "D:/Approved/output.mp4", presetFile: "D:/Approved/h264.epr", exportType: "queueToAme", range: { mode: "sequence_marks", inTicks: "254016000000", outTicks: "508032000000", endPolicy: "native_range_unverified" }, removeUponCompletion: null, startQueueImmediately: null };

describe("exact native encode request lineage", () => {
  it("retains project/sequence/preset/output/range while documented Boolean acceptance has no native job ID", () => {
    const journal = Events.createEventJournal();
    const started = journal.beginEncodeJob({ kind: "sequence", operationId: "encode-1", lineage });
    expect(started).toMatchObject({ nativeJobId: null, correlationVerified: false, lineage });
    journal.markEncodeAccepted(started.jobId);
    const raw = journal.listEncodeJobs({ jobId: started.jobId });
    const normalized = normalizeNativeJob(raw, started.jobId);
    expect(normalized).not.toHaveProperty("nativeJobId");
    expect(normalized.lineageDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(normalized).toMatchObject({ state: "accepted", outputVerified: false, result: { correlationVerified: false, lineage } });
    started.lineage.outputFile = "mutated public copy";
    expect(journal.listEncodeJobs({ jobId: started.jobId }).jobs[0].lineage.outputFile).toBe(lineage.outputFile);
  });
  it("rejects reuse with another exact destination/range even when operation ID matches", () => {
    const journal = Events.createEventJournal();
    const first = journal.beginEncodeJob({ kind: "sequence", operationId: "encode-1", lineage });
    expect(journal.beginEncodeJob({ kind: "sequence", operationId: "encode-1", lineage })).toMatchObject({ jobId: first.jobId });
    expect(() => journal.beginEncodeJob({ kind: "sequence", operationId: "encode-1", lineage: { ...lineage, outputFile: "D:/other.mp4" } })).toThrow(/different encode lineage/);
    expect(() => journal.beginEncodeJob({ kind: "file", operationId: "encode-1", lineage })).toThrow(/different encode lineage/);
  });
  it("keeps generic completion explicitly heuristic and never places paths in event journal", () => {
    const journal = Events.createEventJournal();
    journal.beginEncodeJob({ kind: "sequence", operationId: "encode-1", lineage });
    const event = journal.recordHostEvent({ category: "encoder", name: "encoder.complete", detail: { outputFile: lineage.outputFile } });
    expect(event).toMatchObject({ detail: { jobId: "encode-1", correlationVerified: false } });
    expect(JSON.stringify(event)).not.toContain("Approved");
    expect(journal.listEncodeJobs({}).jobs[0]).toMatchObject({ state: "completed", terminal: true });
    expect(normalizeNativeJob(journal.listEncodeJobs({}), "encode-1")).toMatchObject({ state: "unknown", terminal: false, requiresReconciliation: true, outputVerified: false, result: { observedState: "completed", observedTerminal: true, correlationVerified: false, correlationBoundary: "native_job_id_or_verified_correlation_missing", attribution: "single_active_job_heuristic_native_boolean_has_no_job_id" } });
    journal.beginEncodeJob({ kind: "file", operationId: "encode-2", lineage });
    journal.beginEncodeJob({ kind: "file", operationId: "encode-3", lineage });
    const ambiguous = journal.recordHostEvent({ category: "encoder", name: "encoder.complete", detail: { jobId: "encode-2", correlationVerified: true } });
    expect(ambiguous.detail).toMatchObject({ attributed: false, correlationVerified: false });
    expect(ambiguous.detail).not.toHaveProperty("jobId");
  });
  it("canonical hashes ignore object property order but distinguish range/target changes", () => {
    const job = { jobId: "one", state: "accepted", lineage };
    const first = normalizeNativeJob({ job }, "one");
    const reordered = Object.fromEntries(Object.entries(lineage).reverse());
    expect(normalizeNativeJob({ job: { ...job, lineage: reordered } }, "one").lineageDigest).toBe(first.lineageDigest);
    expect(normalizeNativeJob({ job: { ...job, lineage: { ...lineage, sequenceId: "other" } } }, "one").lineageDigest).not.toBe(first.lineageDigest);
    expect(normalizeNativeJob({ job: { ...job, nativeJobId: "actual-native-123", correlationVerified: true } }, "one")).toMatchObject({ nativeJobId: "actual-native-123", result: { correlationVerified: true } });
    expect(normalizeNativeJob({ job: { ...job, nativeJobId: "invalid/path", correlationVerified: true } }, "one")).not.toHaveProperty("nativeJobId");
  });
  it.each(["completed", "failed", "cancelled"])("requires native identity and verified correlation for observed %s", state => {
    const base = { jobId: "one", state, terminal: true, lineage };
    for (const evidence of [{}, { nativeJobId: "native-1" }, { correlationVerified: true }, { nativeJobId: "native-1", correlationVerified: false }, { nativeJobId: "invalid/path", correlationVerified: true }]) {
      expect(normalizeNativeJob({ job: { ...base, ...evidence } }, "one")).toMatchObject({
        state: "unknown", terminal: false, requiresReconciliation: true, outputVerified: false,
        result: { observedState: state, observedTerminal: true, correlationVerified: false },
      });
    }
    expect(normalizeNativeJob({ job: { ...base, nativeJobId: "native-1", correlationVerified: true } }, "one")).toMatchObject({
      state, terminal: true, nativeJobId: "native-1", requiresReconciliation: false, outputVerified: false,
      result: { observedState: state, observedTerminal: true, correlationVerified: true, correlationBoundary: "actual_native_job_id_and_verified_host_correlation" },
    });
  });
  it("retains absent or inconsistent legacy terminal flags without promoting an uncorrelated state", () => {
    expect(normalizeNativeJob({ job: { jobId: "one", state: "completed" } }, "one")).toMatchObject({ state: "unknown", terminal: false, requiresReconciliation: true, result: { observedState: "completed", observedTerminal: null } });
    expect(normalizeNativeJob({ job: { jobId: "one", state: "accepted", terminal: true } }, "one")).toMatchObject({ state: "unknown", terminal: false, requiresReconciliation: true, result: { observedState: "accepted", observedTerminal: true } });
    expect(normalizeNativeJob({ job: { jobId: "one", state: "completed", terminal: false, nativeJobId: "native-1", correlationVerified: true } }, "one")).toMatchObject({ state: "completed", terminal: false, requiresReconciliation: false, result: { observedState: "completed", observedTerminal: false } });
  });
  it.each([
    [{ ...lineage, schemaVersion: "bad" }, /schema/], [{ ...lineage, extra: "raw host packet" }, /unknown/], [{ ...lineage, outputFile: "\0" }, /field/], [{ ...lineage, range: { ...lineage.range, inTicks: "1.2" } }, /ticks/], [{ ...lineage, range: { ...lineage.range, mode: "unsupported" } }, /policy/], [{ ...lineage, range: { ...lineage.range, workArea: 17 } }, /work area/], [{ ...lineage, range: { ...lineage.range, inSeconds: -1 } }, /seconds/], [{ ...lineage, removeUponCompletion: "yes" }, /flag/],
  ])("validates bounded lineage before reserving host encode", (bad, error) => {
    expect(() => Events.createEventJournal().beginEncodeJob({ kind: "sequence", lineage: bad })).toThrow(error);
    expect(() => normalizeNativeJob({ job: { jobId: "one", lineage: bad } }, "one")).toThrow(/LINEAGE_INVALID/);
  });
  it("Node normalization refuses malformed/unbounded lineage without fabricating correlation", () => {
    for (const bad of [[], { ...lineage, schemaVersion: "bad" }, { ...lineage, outputFile: "x".repeat(4097) }, { ...lineage, range: { invalid: Infinity } }]) expect(() => normalizeNativeJob({ job: { jobId: "one", lineage: bad } }, "one")).toThrow(/LINEAGE_INVALID/);
    expect(normalizeNativeJob({ job: { jobId: "one", state: "accepted" } }, "one")).toMatchObject({ lineageDigest: "not_recorded" });
  });
});
