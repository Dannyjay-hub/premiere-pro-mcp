import type { MutationReceipt } from "./mutation-receipt.js";

// In-memory record of the most recent state-changing tool calls in this server
// process. A client can give up on a long call (its own request timeout) while
// the server keeps waiting for Premiere; retrying then queues the same edit a
// second time. get_last_operations lets the client see whether that call is
// still running or how it ended before it retries. Only the tool name, timing
// and outcome are kept: never arguments, results, paths or media names.
export interface OperationLogEntry {
  sequence: number;
  tool: string;
  status: "running" | "succeeded" | "failed";
  outcome: MutationReceipt["outcome"] | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export const OPERATION_LOG_LIMIT = 50;
const entries: OperationLogEntry[] = [];
let nextSequence = 1;

export function beginOperation(tool: string, now = Date.now()): OperationLogEntry {
  const entry: OperationLogEntry = {
    sequence: nextSequence++,
    tool,
    status: "running",
    outcome: null,
    startedAt: new Date(now).toISOString(),
    finishedAt: null,
    durationMs: null,
  };
  entries.push(entry);
  if (entries.length > OPERATION_LOG_LIMIT) entries.splice(0, entries.length - OPERATION_LOG_LIMIT);
  return entry;
}

export function finishOperation(entry: OperationLogEntry, success: boolean, outcome: MutationReceipt["outcome"], now = Date.now()): void {
  // The first result wins; later structured results for the same call are ignored.
  if (entry.status !== "running") return;
  entry.status = success ? "succeeded" : "failed";
  entry.outcome = outcome;
  entry.finishedAt = new Date(now).toISOString();
  entry.durationMs = Math.max(0, now - Date.parse(entry.startedAt));
}

/** Newest first. */
export function recentOperations(limit = 10): OperationLogEntry[] {
  return entries.slice(-Math.max(1, Math.min(OPERATION_LOG_LIMIT, limit))).reverse().map((entry) => ({ ...entry }));
}

export function resetOperationLog(): void {
  entries.length = 0;
  nextSequence = 1;
}
