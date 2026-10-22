import { beforeEach, describe, expect, it } from "vitest";
import { OPERATION_LOG_LIMIT, beginOperation, finishOperation, recentOperations, resetOperationLog, runningOperations } from "../../src/workflows/operation-log.js";
import { getOperationRecoveryTools } from "../../src/tools/operation-recovery.js";

beforeEach(() => resetOperationLog());

describe("operation log", () => {
  it("shows a call that is still running, then how it ended, newest first", () => {
    const first = beginOperation("roll_edit", 1_000);
    const second = beginOperation("export_sequence", 2_000);
    expect(recentOperations()).toMatchObject([
      { sequence: 2, tool: "export_sequence", status: "running", outcome: null },
      { sequence: 1, tool: "roll_edit", status: "running" },
    ]);
    finishOperation(first, true, "verified", 4_000);
    finishOperation(second, false, "unknown", 5_000);
    // Only the first result for a call is kept.
    finishOperation(first, false, "not_applied", 6_000);
    const [exported, rolled] = recentOperations();
    expect(rolled).toMatchObject({ status: "succeeded", outcome: "verified", durationMs: 3_000 });
    expect(exported).toMatchObject({ status: "failed", outcome: "unknown" });
    expect(exported).not.toHaveProperty("error");
  });

  it("keeps a bounded window and returns copies", () => {
    for (let index = 0; index < OPERATION_LOG_LIMIT + 5; index++) beginOperation(`tool_${index}`);
    const all = recentOperations(OPERATION_LOG_LIMIT + 10);
    expect(all).toHaveLength(OPERATION_LOG_LIMIT);
    expect(all[0].tool).toBe(`tool_${OPERATION_LOG_LIMIT + 4}`);
    all[0].status = "failed";
    expect(recentOperations(1)[0].status).toBe("running");
  });

  it("get_last_operations validates limit and reports running calls", async () => {
    const tool = getOperationRecoveryTools(undefined).get_last_operations;
    beginOperation("ripple_delete");
    await expect(tool.handler({})).resolves.toMatchObject({ success: true, data: { running: 1, operations: [{ tool: "ripple_delete", status: "running" }] } });
    await expect(tool.handler({ limit: 0 })).resolves.toMatchObject({ success: false, error: expect.stringContaining("limit") });
    expect(tool.annotations.readOnlyHint).toBe(true);
  });
});


describe("active recovery outside recent history", () => {
  it("keeps an old export discoverable after newer calls evict it", async () => {
    const exported = beginOperation("export_sequence", 1000);
    for (let index = 0; index < OPERATION_LOG_LIMIT + 5; index++) {
      const edited = beginOperation("roll_edit", 2000 + index);
      finishOperation(edited, true, "verified", 3000 + index);
    }
    const tool = getOperationRecoveryTools(undefined).get_last_operations;
    expect(recentOperations()).not.toContainEqual(expect.objectContaining({ tool: "export_sequence" }));
    await expect(tool.handler({ limit: 1 })).resolves.toMatchObject({ data: {
      running: 1, runningOperations: [{ tool: "export_sequence", status: "running" }], runningOperationsTruncated: false,
      operations: [{ tool: "roll_edit", status: "succeeded" }],
    } });
    finishOperation(exported, false, "unknown", 5000);
    expect(runningOperations()).toEqual({ count: 0, operations: [], truncated: false });
  });

  it("bounds active detail output without understating running count and returns copies", () => {
    beginOperation("export_sequence");
    beginOperation("roll_edit");
    const snapshot = runningOperations(1);
    expect(snapshot).toMatchObject({ count: 2, operations: [{ tool: "roll_edit" }], truncated: true });
    snapshot.operations[0].status = "failed";
    expect(runningOperations(1).operations[0].status).toBe("running");
    resetOperationLog();
    expect(runningOperations().count).toBe(0);
  });
});
