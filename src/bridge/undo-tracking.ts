import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Whether scripts built during the current tool call record Premiere's undo
 * stack position (EXPERIMENTAL: qe.project.undoStackIndex, undocumented QE DOM).
 * The server turns it on only for calls that need the edit capability, so
 * inspection and analysis tools never touch QE for undo tracking.
 */
const undoTracking = new AsyncLocalStorage<boolean>();

export function runWithUndoTracking<T>(enabled: boolean, fn: () => T): T {
  return undoTracking.run(enabled, fn);
}

export function undoTrackingEnabled(): boolean {
  return undoTracking.getStore() === true;
}
