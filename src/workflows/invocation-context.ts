import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

export type OperationStage = "queue_wait" | "host_wait" | "dispatch" | "readback" | "analysis" | "artifact_validation";
export interface InvocationContext {
  signal?: AbortSignal;
  progressToken?: string | number;
  notify?: (notification: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; total?: number; message?: string } }) => Promise<void>;
  dispatched: boolean;
  progress: number;
  notifications: number;
  lastNotificationAt: number;
  stages: Partial<Record<OperationStage, number>>;
}
const storage = new AsyncLocalStorage<InvocationContext>();

export function withInvocationContext<T>(options: Pick<InvocationContext, "signal" | "progressToken" | "notify">, work: () => T): T {
  return storage.run({ ...options, dispatched: false, progress: -1, notifications: 0, lastNotificationAt: -Infinity, stages: {} }, work);
}
export function currentInvocation(): InvocationContext | undefined { return storage.getStore(); }
/** Call immediately before sending a command, never while merely previewing. */
export function markHostDispatch(): void { const context = storage.getStore(); if (context) context.dispatched = true; }
export function assertInvocationNotCancelled(): void {
  if (storage.getStore()?.signal?.aborted) throw new Error("REQUEST_CANCELLED_BEFORE_DISPATCH: no further command was sent; an already accepted host job is not cancelled.");
}
/** Progress measures workflow steps unless explicitly supplied by the native job. */
export async function reportProgress(progress: number, total?: number, message?: string): Promise<void> {
  const context = storage.getStore();
  if (!context || context.progressToken === undefined || !context.notify || !Number.isFinite(progress) || progress < 0 || progress <= context.progress) return;
  if (total !== undefined && (!Number.isFinite(total) || total < progress)) return;
  const now = performance.now();
  if (context.notifications >= 100 || (now - context.lastNotificationAt < 250 && progress !== total)) return;
  context.progress = progress; context.notifications++; context.lastNotificationAt = now;
  // A failed client notification must never replay or change a host operation.
  try { await context.notify({ method: "notifications/progress", params: { progressToken: context.progressToken, progress, ...(total === undefined ? {} : { total }), ...(message ? { message: message.slice(0, 160) } : {}) } }); } catch { /* disconnected observer */ }
}
export async function measureStage<T>(stage: OperationStage, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try { return await work(); } finally {
    const context = storage.getStore();
    if (context) context.stages[stage] = (context.stages[stage] ?? 0) + performance.now() - started;
  }
}

/** Capture the invoking context before asynchronous host callbacks leave it. */
export function startStage(stage: OperationStage, context = currentInvocation()): () => void {
  const started = performance.now();
  let recorded = false;
  return () => {
    if (!recorded && context) context.stages[stage] = (context.stages[stage] ?? 0) + performance.now() - started;
    recorded = true;
  };
}
export function measureStageSync<T>(stage: OperationStage, work: () => T, context = currentInvocation()): T {
  const finish = startStage(stage, context);
  try { return work(); } finally { finish(); }
}
