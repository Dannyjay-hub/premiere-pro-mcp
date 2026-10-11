import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "./helpers/temp-dir.js";

afterAll(cleanupTempDirs);
const create = join(process.cwd(), "scripts/create-temporal-host-report.mjs"), validate = join(process.cwd(), "scripts/validate-temporal-host-report.mjs");
const provenance = { premiereBuild: "26.3.0", os: "macOS", locale: "en_US", backend: "uxp", panelSha256: "a".repeat(64), serverCommit: "b".repeat(40), clientVersion: "1.0", fixtureSha256: "c".repeat(64), capabilityIds: ["interchange.export"] };
function skeleton() {
  const dir = makeTempDir("temporal-host-report-");
  const source = join(dir, "provenance.json"), output = join(dir, "report.json");
  writeFileSync(source, JSON.stringify(provenance));
  execFileSync(process.execPath, [create, source, output], { stdio: "pipe" });
  return { dir, output, report: JSON.parse(readFileSync(output, "utf8")) };
}
function run(output: string, report: unknown, dir?: string) {
  writeFileSync(output, JSON.stringify(report));
  return execFileSync(process.execPath, [validate, output, ...(dir ? [dir] : [])], { encoding: "utf8", stdio: "pipe" });
}

describe("licensed temporal fixture matrix", () => {
  it("pins host/build/backend/locale/capabilities and keeps every generated cell not_run", () => {
    const { output, report } = skeleton();
    expect(report.provenance).toEqual(provenance);
    expect(report.cases).toHaveLength(8);
    expect(run(output, report)).toContain('"not_run": 8');
    expect(report.compatibilityEligible).toBe(false);
  });
  it("rejects unsupported provenance and create-overwrite before claims", () => {
    const { dir, output } = skeleton();
    const source = join(dir, "invalid.json");
    writeFileSync(source, JSON.stringify({ ...provenance, extra: "private" }));
    expect(() => execFileSync(process.execPath, [create, source, output], { stdio: "pipe" })).toThrow();
    writeFileSync(source, JSON.stringify(provenance));
    expect(() => execFileSync(process.execPath, [create, source, output], { stdio: "pipe" })).toThrow(/EEXIST/);
  });
  it("rejects passed cells without measured Undo/reopen/playback/artifact evidence", () => {
    const { output, report } = skeleton(); report.cases[0].status = "passed";
    expect(() => run(output, report)).toThrow(/required measured evidence/);
    report.cases[0].status = "not_run"; report.compatibilityEligible = true;
    expect(() => run(output, report)).toThrow(/compatibilityEligible/);
  });
  it("requires bounded approved files and matching hashes for temporal evidence", () => {
    const { output, report, dir } = skeleton();
    const cell = report.cases[0]; cell.status = "failed";
    cell.evidence = [{ kind: "temporal_video", ref: "video-evidence", sha256: "0".repeat(64) }];
    expect(() => run(output, report)).toThrow(/approved evidence directory/);
    const evidence = { schemaVersion: "premiere-mcp.temporal-render-evidence.v1", passed: true, fixture: { sha256: provenance.fixtureSha256 }, artifact: { sha256: "a".repeat(64), decodedVideoFrames: 72 }, videoEvidence: [{ passed: true, captureMethod: "actual_artifact_ffmpeg_decode" }, { passed: true, captureMethod: "actual_artifact_ffmpeg_decode" }], audioEvidence: [] };
    const bytes = JSON.stringify(evidence); writeFileSync(join(dir, "video-evidence.json"), bytes);
    expect(() => run(output, report, dir)).toThrow(/hash mismatch/);
    cell.evidence[0].sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(run(output, report, dir)).toContain('"failed": 1');
    cell.evidence[0].ref = "../private";
    expect(() => run(output, report, dir)).toThrow(/opaque ref/);
  });
});
