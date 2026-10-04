/**
 * Host-side timeline edits get 400 ms per planned mover plus 30 seconds for
 * startup/readback. Keep the override bounded at 15 minutes so unusually large
 * plans cannot make a caller wait forever. The bridge adds its own hard cap.
 */
export const MAX_RIPPLE_TIMEOUT_MS = 15 * 60 * 1000;
export const RIPPLE_TIMEOUT_HEADROOM_MS = 30_000;
export const RIPPLE_TIMEOUT_PER_MOVER_MS = 400;

export function rippleTimeoutMs(movers: number): number {
  const safeMovers = Number.isFinite(movers) ? Math.max(0, Math.ceil(movers)) : 0;
  return Math.min(
    MAX_RIPPLE_TIMEOUT_MS,
    RIPPLE_TIMEOUT_HEADROOM_MS + safeMovers * RIPPLE_TIMEOUT_PER_MOVER_MS,
  );
}
