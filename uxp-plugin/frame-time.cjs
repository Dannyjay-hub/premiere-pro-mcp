(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PremiereMcpFrameTime = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const TICKS_PER_SECOND = 254016000000n;
  function snapSeconds(seconds, ticksPerFrame) {
    const requested = Number(seconds), frameTicks = BigInt(String(ticksPerFrame));
    if (!Number.isFinite(requested) || frameTicks <= 0n) throw new Error("A valid time and sequence ticksPerFrame are required");
    const requestedTicks = BigInt(Math.round(requested * Number(TICKS_PER_SECOND)));
    const magnitude = requestedTicks < 0n ? -requestedTicks : requestedTicks;
    const roundedMagnitude = (magnitude + frameTicks / 2n) / frameTicks;
    const frames = requestedTicks < 0n ? -roundedMagnitude : roundedMagnitude, appliedTicks = frames * frameTicks;
    return { requestedSeconds: requested, appliedSeconds: Number(appliedTicks) / Number(TICKS_PER_SECOND), frameCount: Number(frames), ticks: appliedTicks.toString() };
  }
  function withinHalfFrame(actualSeconds, expectedSeconds, ticksPerFrame) {
    const actual = Number(actualSeconds), expected = Number(expectedSeconds), frameTicks = BigInt(String(ticksPerFrame));
    if (!Number.isFinite(actual) || !Number.isFinite(expected) || frameTicks <= 0n) return false;
    const actualTicks = BigInt(Math.round(actual * Number(TICKS_PER_SECOND)));
    const expectedTicks = BigInt(Math.round(expected * Number(TICKS_PER_SECOND)));
    const delta = actualTicks >= expectedTicks ? actualTicks - expectedTicks : expectedTicks - actualTicks;
    return delta * 2n <= frameTicks;
  }
  return { TICKS_PER_SECOND: TICKS_PER_SECOND.toString(), snapSeconds, withinHalfFrame };
});
