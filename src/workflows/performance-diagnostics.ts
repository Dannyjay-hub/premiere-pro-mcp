import type { OperationStage } from "./invocation-context.js";

interface Sample { durationMs: number; payloadBytes: number | null; stages: Partial<Record<OperationStage, number>>; cacheHit: boolean | null }
const samples: Sample[] = [];
const stages: OperationStage[] = ["queue_wait", "host_wait", "dispatch", "readback", "analysis", "artifact_validation"];
export function recordPerformance(sample: Sample): void {
  if (!Number.isFinite(sample.durationMs) || sample.durationMs < 0) return;
  samples.push({ durationMs: sample.durationMs, payloadBytes: Number.isSafeInteger(sample.payloadBytes) && sample.payloadBytes! >= 0 ? sample.payloadBytes : null, cacheHit: sample.cacheHit,
    stages: Object.fromEntries(stages.filter(stage => Number.isFinite(sample.stages[stage]) && sample.stages[stage]! >= 0).map(stage => [stage, sample.stages[stage]])) });
  if (samples.length > 256) samples.shift();
}
function distribution(values: number[]) {
  if (!values.length) return { count: 0, median: null, p95: null, maximum: null };
  const sorted = values.slice().sort((a,b) => a-b);
  return { count: values.length, median: sorted[Math.floor((sorted.length - 1) * .5)], p95: sorted[Math.ceil((sorted.length - 1) * .95)], maximum: sorted[sorted.length - 1] };
}
export function performanceDiagnostics() {
  return { version: 1, scope: "process_local_bounded_last_256_calls", durationMs: distribution(samples.map(sample => sample.durationMs)), payloadBytes: distribution(samples.flatMap(sample => sample.payloadBytes === null ? [] : [sample.payloadBytes])),
    stagesMs: Object.fromEntries(stages.map(stage => [stage, distribution(samples.flatMap(sample => sample.stages[stage] === undefined ? [] : [sample.stages[stage]!]))])),
    cache: { measured: samples.filter(sample => sample.cacheHit !== null).length, hits: samples.filter(sample => sample.cacheHit === true).length },
    privacy: "No tool names, arguments, results, prompts, tokens, paths, media names, or identities retained. Unmeasured stages remain null, never zero estimates." };
}
export function resetPerformanceDiagnostics(): void { samples.length = 0; }
