import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const matrix = JSON.parse(readFileSync(join(root, "docs/temporal-render-fixtures.matrix.json"), "utf8"));
const [reportPath, evidenceDirectory] = process.argv.slice(2);
if (!reportPath || process.argv.length > 4) throw new Error("Usage: node scripts/validate-temporal-host-report.mjs <report.json> [approved evidence directory]");
function load(path) {
  const size = statSync(path).size;
  if (size > 1024 * 1024) throw new Error("Evidence/report exceeds 1 MiB");
  const bytes = readFileSync(path);
  return { bytes, data: JSON.parse(bytes.toString("utf8")) };
}
function onlyKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label} has unknown fields or wrong type`);
}
const report = load(reportPath).data;
onlyKeys(report, ["schemaVersion", "matrixId", "provenance", "cases", "compatibilityEligible"], "report");
if (report.schemaVersion !== "premiere-mcp.temporal-host-report.v1" || report.matrixId !== matrix.id || !Array.isArray(report.cases) || report.cases.length !== matrix.fixtures.length) throw new Error("Unsupported report schema/matrix or incomplete cases");
const requiredProvenance = ["premiereBuild", "os", "locale", "backend", "panelSha256", "serverCommit", "clientVersion", "fixtureSha256", "capabilityIds"];
onlyKeys(report.provenance, requiredProvenance, "provenance");
if (requiredProvenance.some(key => !(key in report.provenance))) throw new Error("Missing provenance field");
const provenance = report.provenance;
const provenanceBinding = createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(provenance).sort(([left], [right]) => left.localeCompare(right))))).digest("hex");
for (const key of ["premiereBuild", "locale", "clientVersion"]) if (typeof provenance[key] !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(provenance[key])) throw new Error(`Invalid ${key}`);
if (!["Windows", "macOS"].includes(provenance.os) || !["cep", "uxp"].includes(provenance.backend)) throw new Error("Invalid OS/backend");
for (const key of ["panelSha256", "fixtureSha256", "serverCommit"]) if (typeof provenance[key] !== "string" || !new RegExp(`^[a-f0-9]{${key === "serverCommit" ? 40 : 64}}$`).test(provenance[key])) throw new Error(`Invalid ${key}`);
if (!Array.isArray(provenance.capabilityIds) || provenance.capabilityIds.length > 256 || new Set(provenance.capabilityIds).size !== provenance.capabilityIds.length || provenance.capabilityIds.some(value => typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value))) throw new Error("Invalid capabilityIds");
const cases = new Map(matrix.fixtures.map(value => [value.id, value]));
const seen = new Set();
const counts = { passed: 0, failed: 0, unsupported: 0, not_run: 0 };
const approved = evidenceDirectory ? realpathSync(evidenceDirectory) : null;
for (const cell of report.cases) {
  onlyKeys(cell, ["id", "status", "evidence", "requiredEvidence"], "case");
  const fixture = cases.get(cell.id);
  if (!fixture || seen.has(cell.id) || !Object.hasOwn(counts, cell.status) || !Array.isArray(cell.evidence) || cell.evidence.length > 32 || JSON.stringify(cell.requiredEvidence) !== JSON.stringify(fixture.evidence)) throw new Error("Invalid/duplicate case, status or required evidence");
  seen.add(cell.id); counts[cell.status]++;
  const measured = new Set();
  for (const evidence of cell.evidence) {
    onlyKeys(evidence, ["kind", "ref", "sha256"], "evidence");
    if (!fixture.evidence.includes(evidence.kind) || typeof evidence.ref !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(evidence.ref) || typeof evidence.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(evidence.sha256)) throw new Error("Evidence must have an allowed kind, opaque ref and SHA-256");
    if (!approved) throw new Error("Measured evidence requires an explicitly approved evidence directory");
    const candidate = realpathSync(join(approved, `${evidence.ref}.json`)), fromRoot = relative(approved, candidate);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error("Evidence escapes approved root");
    const loaded = load(candidate);
    if (createHash("sha256").update(loaded.bytes).digest("hex") !== evidence.sha256) throw new Error("Evidence hash mismatch");
    const data = loaded.data;
    if (evidence.kind === "temporal_video" || evidence.kind === "decoded_audio") {
      if (data.schemaVersion !== "premiere-mcp.temporal-render-evidence.v1" || typeof data.passed !== "boolean" || data.fixture?.sha256 !== provenance.fixtureSha256 || !/^[a-f0-9]{64}$/.test(data.artifact?.sha256) || data.artifact?.decodedVideoFrames < 2 || !Array.isArray(data.videoEvidence) || data.videoEvidence.length < 2 || data.videoEvidence.some(value => value.captureMethod !== "actual_artifact_ffmpeg_decode" || typeof value.passed !== "boolean") || (evidence.kind === "decoded_audio" && (!Array.isArray(data.audioEvidence) || !data.audioEvidence.length))) throw new Error("Temporal evidence must identify actual decoded video/audio for the pinned fixture");
      if (cell.status === "passed") {
        const host = data.host;
        if (data.passed !== true || !host || host.premiere_build !== provenance.premiereBuild || host.os !== provenance.os || host.locale !== provenance.locale || host.backend !== provenance.backend || host.panel_sha256 !== provenance.panelSha256 || host.server_commit !== provenance.serverCommit || host.client_version !== provenance.clientVersion || JSON.stringify(host.capability_ids) !== JSON.stringify(provenance.capabilityIds) || data.videoEvidence.some(value => value.passed !== true) || (evidence.kind === "decoded_audio" && data.audioEvidence.some(value => value.passed !== true))) throw new Error("Passed temporal evidence must match pinned host provenance and passing measurements");
      }
      if (data.passed) measured.add(evidence.kind);
    } else {
      if (data.kind !== evidence.kind || data.fixtureSha256 !== provenance.fixtureSha256 || data.provenanceBinding !== provenanceBinding || typeof data.checked !== "boolean") throw new Error("Manual/native evidence must explicitly identify its measured check and pinned fixture/host binding");
      if (data.checked) measured.add(evidence.kind);
    }
  }
  if (cell.status === "passed" && fixture.evidence.some(kind => !measured.has(kind))) throw new Error(`Passed ${cell.id} lacks required measured evidence`);
  if (cell.status === "not_run" && cell.evidence.length) throw new Error("not_run cell cannot contain measured evidence");
}
const eligible = report.cases.length > 0 && report.cases.every(cell => cell.status === "passed");
if (report.compatibilityEligible !== eligible) throw new Error("compatibilityEligible does not match measured case statuses");
console.log(JSON.stringify({ schemaVersion: report.schemaVersion, counts, compatibilityEligible: eligible, proofBoundary: "artifact_hash_and_measured_evidence_links; host_provenance_remains_operator_attested" }, null, 2));
