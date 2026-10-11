import { describe, it, expect } from "vitest";

describe("dependency layer enforcement", () => {
  it("rejects host dispatch imports in pure planners and orchestration in security", async () => {
    const {violationsFor,checkDependencyBoundaries}=await import("../scripts/check-dependency-boundaries.mjs");
    expect(violationsFor("src/ai/proposed.ts",["src/bridge/file-bridge.ts","node:child_process"])).toHaveLength(2);
    expect(violationsFor("src/security/proposed.ts",["src/tools/timeline.ts"])).toHaveLength(1);
    expect(violationsFor("src/ai/exact-time.ts",["node:crypto","src/ai/timeline-contract.ts"])).toEqual([]);
    expect(checkDependencyBoundaries().checked).toBe(true);
  });
});
