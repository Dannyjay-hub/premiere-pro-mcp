import { describe, expect, it } from "vitest";
import { applySnapshotFrom, withApplyGuards, withApplySnapshot } from "../../src/tools/uxp-apply-snapshot.js";

describe("UXP inspect snapshots round-trip into apply schemas", () => {
  it("converts the camelCase work-area result into an unchanged schema-valid expected object", async () => {
    const schema = { properties: { in_seconds: { type: "number" }, out_seconds: { type: "number" } } };
    const inspect = Promise.resolve({ success: true, data: { backend: "uxp", result: { sequenceGuid: "sequence-1", workArea: { inSeconds: 1.2, outSeconds: 9.6 } } } });
    const result = await withApplySnapshot(inspect, schema, "expected_work_area", "workArea");
    expect(result).toMatchObject({ data: { expected_work_area: { in_seconds: 1.2, out_seconds: 9.6 } } });
    const passedUnchanged = (result.data as any).expected_work_area;
    expect(applySnapshotFrom(passedUnchanged, schema)).toEqual(passedUnchanged);
    expect(Object.keys(passedUnchanged)).toEqual(["in_seconds", "out_seconds"]);
  });

  it("does not add a partial expected snapshot when a required inspected value is missing", async () => {
    const schema = { properties: { sequence_id: { type: "string" }, preview_width: { type: "integer" } } };
    const result = await withApplySnapshot(Promise.resolve({ success: true, data: { result: { sequenceId: "s1" } } }), schema);
    expect(result.data).not.toHaveProperty("expected_snapshot");
  });

  it("maps nested host values and source aliases, and refuses values rejected by the apply schema", () => {
    const schema = { properties: {
      marker_guid: { type: "string", sourceKey: "guid" },
      expected_start_seconds: { type: "number", minimum: 0, sourceKey: "startSeconds" },
      pixel_aspect_ratio: { properties: { numerator: { type: "integer" }, denominator: { type: "integer" } } },
    } };
    expect(applySnapshotFrom({ guid: "m1", startSeconds: 3, pixelAspectRatio: { numerator: 4, denominator: 3 } }, schema)).toEqual({
      marker_guid: "m1", expected_start_seconds: 3, pixel_aspect_ratio: { numerator: 4, denominator: 3 },
    });
    expect(applySnapshotFrom({ guid: "m1", startSeconds: -1, pixelAspectRatio: { numerator: 4, denominator: 3 } }, schema)).toBeNull();
  });
  it("keeps valid guards without inventing guards for unreadable or invalid state", async () => {
    const schema = { type: "array", minItems: 1, maxItems: 2, uniqueItems: true, items: { type: "number", minimum: 0, maximum: 10 } };
    for (const times of [[], [1, 1], [1, 2, 3], [-1], [11], [NaN]]) {
      const result = await withApplyGuards(Promise.resolve({ success: true, data: { result: { sequenceId: "s1", times } } }), {
        expected_sequence_id: { schema: { type: "string", pattern: "^[a-z0-9]+$" }, sourceKey: "sequenceId" },
        expected_times: { schema, sourceKey: "times" },
      });
      expect(result.data).toHaveProperty("expected_sequence_id", "s1");
      expect(result.data).not.toHaveProperty("expected_times");
      expect(applySnapshotFrom(times, schema)).toBeNull();
    }
    const failed = { success: false, error: "Unavailable" };
    expect(await withApplyGuards(Promise.resolve(failed), {})).toBe(failed);
  });

});
