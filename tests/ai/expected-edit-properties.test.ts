import { describe, expect, it } from "vitest";
import seeds from "../fixtures/filmcraft-edit-seeds.json";
import { frameToTicks, ticks } from "../../src/ai/exact-time.js";
import { predictEdits, snapshotRevision, verifyContinuity, type TimelineSnapshot, type TimelineClip, type ExpectedEdit } from "../../src/ai/timeline-contract.js";

const r = { numerator: 24, denominator: 1 }, ft = (n: number) => frameToTicks(String(n), r);
function generator(seed: number) { let state = seed >>> 0; return () => { state = (state * 1664525 + 1013904223) >>> 0; return state; }; }
function fixture(): TimelineSnapshot {
  const clips = Array.from({ length: 8 }, (_, index): TimelineClip => ({ id: `clip${index}`, source_id: `source${index}`, track_id: index % 2 ? "audio:0" : "video:0", start_ticks: ft(index * 20), end_ticks: ft(index * 20 + 10), in_ticks: ft(10), out_ticks: ft(20), source_duration_ticks: ft(1000), speed: { numerator: 1, denominator: 1 }, reversed: false, enabled: true, linked_ids: [], identity: "host", effects: [], nested: false }));
  const snapshot: TimelineSnapshot = { schema_version: 1, backend: "cep", project_id: "p", sequence_id: "s", session_id: "session", revision: "", frame_rate: r, display_start_ticks: "0", tracks: [{ id: "video:0", type: "video", index: 0, locked: false, sync_locked: true, targeted: true, muted: false }, { id: "audio:0", type: "audio", index: 0, locked: false, sync_locked: true, targeted: false, muted: true }], clips, completeness: { clips: true, links: true, locks: true, effects: true, transitions: true, markers: true }, transitions: [], markers: [], pagination: { offset: 0, total: clips.length, next_offset: null } };
  snapshot.revision = snapshotRevision(snapshot); return snapshot;
}
function noOverlap(snapshot: TimelineSnapshot) { for (const track of snapshot.tracks) { const clips = snapshot.clips.filter(c => c.track_id === track.id).sort((a, b) => ticks(a.start_ticks) < ticks(b.start_ticks) ? -1 : 1); for (let i = 1; i < clips.length; i++) expect(ticks(clips[i].start_ticks), `track ${track.id} clip ${clips[i].id}`).toBeGreaterThanOrEqual(ticks(clips[i - 1].end_ticks)); } }

describe("seeded expected-edit properties", () => {
  it.each(seeds.seeds)("preserves duration, neighbors, no-overlap and refusal invariants at retained seed%d", seed => {
    const random = generator(seed);
    for (let trial = 0; trial < 80; trial++) {
      const input = fixture(), before = JSON.stringify(input), target = input.clips[random() % input.clips.length], kind = random() % 6;
      let operation: ExpectedEdit;
      if (kind === 0) operation = { type: "enable", clip_id: target.id, enabled: (random() & 1) === 0 };
      else if (kind === 1) operation = { type: "move", clip_id: target.id, start_ticks: ft(200 + random() % 100) };
      else if (kind === 2) operation = { type: "trim", clip_id: target.id, out_ticks: ft(12 + random() % 8) };
      else if (kind === 3) operation = { type: "remove", clip_id: target.id, ripple: true, scope: (random() & 1) ? "track" : "sync_locked" };
      else if (kind === 4) operation = { type: "split", clip_id: target.id, at_ticks: (ticks(target.start_ticks) + ticks(ft(1 + random() % 9))).toString(), right_id: `right${seed}-${trial}` };
      else { const track = input.tracks.find(t => t.id === target.track_id)!; track.locked = true; input.revision = snapshotRevision(input); operation = { type: "move", clip_id: target.id, start_ticks: ft(300) }; }
      const original = JSON.stringify(input);
      if (kind === 5) { expect(() => predictEdits(input, [operation])).toThrow("TRACK_LOCKED"); expect(JSON.stringify(input)).toBe(original); continue; }
      const modeled = predictEdits(input, [operation]); expect(JSON.stringify(input)).toBe(before); noOverlap(modeled.snapshot);
      const participants = new Set(modeled.participants), afterById = new Map(modeled.snapshot.clips.map(c => [c.id, c]));
      for (const clip of input.clips) if (!participants.has(clip.id)) expect(afterById.get(clip.id)).toEqual(clip);
      if (operation.type === "move" || operation.type === "enable") { const actual = afterById.get(target.id)!; expect(ticks(actual.end_ticks) - ticks(actual.start_ticks)).toBe(ticks(target.end_ticks) - ticks(target.start_ticks)); expect(actual.in_ticks).toBe(target.in_ticks); expect(actual.out_ticks).toBe(target.out_ticks); }
      if (operation.type === "trim") { const actual = afterById.get(target.id)!; expect(ticks(actual.end_ticks) - ticks(actual.start_ticks)).toBe(ticks(actual.out_ticks) - ticks(actual.in_ticks)); expect(actual.out_ticks).toBe(operation.out_ticks); }
      if (operation.type === "split") { const left = afterById.get(target.id)!, right = afterById.get(operation.right_id)!; expect(left.end_ticks).toBe(right.start_ticks); expect(left.out_ticks).toBe(right.in_ticks); expect(ticks(left.end_ticks) - ticks(left.start_ticks) + ticks(right.end_ticks) - ticks(right.start_ticks)).toBe(ticks(target.end_ticks) - ticks(target.start_ticks)); expect(() => predictEdits(modeled.snapshot, [{ type: "enable", clip_id: right.id, enabled: false }])).toThrow("SYNTHETIC"); }
      expect(verifyContinuity(modeled.snapshot, modeled.snapshot).verified).toBe(true);
    }
  });
  it.each(seeds.seeds)("composes reviewed edit sequences without collateral differences at retained seed%d", seed => {
    const random = generator(seed);
    for (let trial = 0; trial < 40; trial++) {
      const original = fixture(), immutable = JSON.stringify(original), operations: ExpectedEdit[] = [];
      let sequential = original;
      for (let step = 0; step < 8; step++) {
        const target = sequential.clips[random() % sequential.clips.length], kind = random() % 3;
        const operation: ExpectedEdit = kind === 0 ? { type: "enable", clip_id: target.id, enabled: (random() & 1) === 0 } : kind === 1 ? { type: "move", clip_id: target.id, start_ticks: ft(200 + step * 20) } : { type: "trim", clip_id: target.id, out_ticks: ft(12 + random() % 8) };
        operations.push(operation); sequential = predictEdits(sequential, [operation]).snapshot; noOverlap(sequential);
      }
      const composed = predictEdits(original, operations), changed = new Set(composed.changes.map(c => c.id));
      expect(composed.snapshot).toEqual(sequential); expect(JSON.stringify(original)).toBe(immutable); expect(verifyContinuity(sequential, composed.snapshot).verified).toBe(true);
      for (const clip of original.clips) if (!changed.has(clip.id)) expect(composed.snapshot.clips.find(c => c.id === clip.id)).toEqual(clip);
      const collateral = structuredClone(composed.snapshot); collateral.clips[0].source_id = "unexpected-relink"; collateral.revision = snapshotRevision(collateral); expect(verifyContinuity(composed.snapshot, collateral)).toMatchObject({ verified: false, discrepancies: ["clip0:source_id"] });
    }
  });
  it("retains collateral-ripple and linked-group refusal regressions", () => {
    const input = fixture(); input.clips[1].start_ticks = ft(5); input.clips[1].end_ticks = ft(15); input.revision = snapshotRevision(input); const before = JSON.stringify(input);
    expect(() => predictEdits(input, [{ type: "remove", clip_id: "clip0", ripple: true, scope: "sync_locked" }])).toThrow("RIPPLE_OCCUPIED"); expect(JSON.stringify(input)).toBe(before);
    input.clips[0].linked_ids = ["clip1"]; input.clips[1].linked_ids = ["clip0"]; input.revision = snapshotRevision(input);
    expect(() => predictEdits(input, [{ type: "trim", clip_id: "clip0", out_ticks: ft(15) }])).toThrow("LINKED_EDIT_REQUIRES_GROUP");
  });
});
