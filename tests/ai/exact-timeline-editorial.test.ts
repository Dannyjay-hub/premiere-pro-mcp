import { describe, expect, it } from "vitest";
import { ticks, divide, secondsToTicks, frameToTicks, ticksToFrame, sampleToTicks, frameToTimecode, timecodeToFrame, rate } from "../../src/ai/exact-time.js";
import { snapshotRevision, validateSnapshot, predictEdits, verifyContinuity, mapTimeDomain, affectedTracks, sourceHandlePreflight, type TimelineSnapshot, type TimelineClip } from "../../src/ai/timeline-contract.js";
import { planAudioSynchronization, planAnchorSynchronization, mapWordsToPlacements, planMusicRemix, planSceneSegmentation, verifyCaptionRenderEvidence, bindProxyProvenance, planStackedCameraEdit, validateWorkflowCheckpoint } from "../../src/ai/editorial-workflows.js";

const second = (n: number) => secondsToTicks(n);
export function fixtureSnapshot(): TimelineSnapshot {
  const clip: TimelineClip = { id: "clip1", source_id: "source1", track_id: "video:0", start_ticks: second(0), end_ticks: second(2), in_ticks: second(1), out_ticks: second(3), source_duration_ticks: second(60), speed: { numerator: 1, denominator: 1 }, reversed: false, enabled: true, linked_ids: [], identity: "host", effects: [], nested: false };
  const snapshot: TimelineSnapshot = { schema_version: 1, backend: "cep", project_id: "project", sequence_id: "sequence", session_id: "session", revision: "", frame_rate: { numerator: 24000, denominator: 1001 }, display_start_ticks: second(-3600), tracks: [{ id: "video:0", type: "video", index: 0, locked: false, sync_locked: true, targeted: true, muted: false }, { id: "audio:0", type: "audio", index: 0, locked: false, sync_locked: true, targeted: false, muted: false }], clips: [clip], completeness: { clips: true, links: true, locks: true, effects: true, transitions: true, markers: true }, transitions: [], markers: [], pagination: { offset: 0, total: 1, next_offset: null } };
  snapshot.revision = snapshotRevision(snapshot); return snapshot;
}
const revise = (s: TimelineSnapshot) => { s.pagination.total = s.clips.length; s.revision = snapshotRevision(s); return s; };

describe("exact Premiere time", () => {
  it.each([{ numerator: 24000, denominator: 1001 }, { numerator: 30000, denominator: 1001 }, { numerator: 60000, denominator: 1001 }, { numerator: 24, denominator: 1 }])("round-trips long signed frame strings at %j", r => {
    for (const frame of ["0", "1", "-1", "12345678901234567890", "-12345678901234567890"]) expect(ticksToFrame(frameToTicks(frame, r), r)).toBe(frame);
  });
  it("preserves tick precision and audio sample endpoints", () => {
    expect(ticks("9007199254740993123").toString()).toBe("9007199254740993123");
    expect(secondsToTicks("0.000000001")).toBe("254");
    expect(secondsToTicks(1e-7)).toBe("25402");
    expect(sampleToTicks("48000", 48000)).toBe(second(1));
    expect(sampleToTicks("1", 48000)).toBe("5292000");
    expect(divide(-3n, 2n, "floor")).toBe(-2n); expect(divide(-3n, 2n, "ceil")).toBe(-1n); expect(divide(-3n, 2n)).toBe(-2n); expect(divide(3n, 2n)).toBe(2n); expect(divide(2n, 2n)).toBe(1n);
  });
  it("uses correct drop-frame minute and ten-minute boundaries", () => {
    const r = { numerator: 30000, denominator: 1001 };
    expect(frameToTimecode("1800", r, true)).toBe("00:01:00;02"); expect(timecodeToFrame("00:10:00;00", r, true)).toBe("17982");
    expect(frameToTimecode("17982", r, true)).toBe("00:10:00;00"); expect(frameToTimecode("-1800", r, true)).toBe("-00:01:00;02");
    const r60 = { numerator: 60000, denominator: 1001 }; expect(frameToTimecode("3600", r60, true)).toBe("00:01:00;04");
    for (let frame = 0; frame < 20000; frame += 37) expect(timecodeToFrame(frameToTimecode(String(frame), r, true), r, true)).toBe(String(frame));
    expect(frameToTimecode("8640000", { numerator: 24, denominator: 1 })).toBe("100:00:00:00");
  });
  it.each(["1.0", "+1", "01", "-0", "NaN", "9".repeat(41)])("rejects noncanonical tick %s", n => expect(() => ticks(n)).toThrow());
  it("rejects contradictory rates/timecodes/rounding", () => {
    expect(rate({ numerator: 60000, denominator: 2002 })).toEqual({ numerator: 30000, denominator: 1001 });
    expect(() => rate({ numerator: 0, denominator: 1 })).toThrow(); expect(() => divide(1n, 0n)).toThrow(); expect(() => divide(1n, 2n, "bad" as any)).toThrow();
    expect(() => secondsToTicks(NaN)).toThrow(); expect(() => sampleToTicks("1", 0)).toThrow(); expect(() => frameToTimecode("1", { numerator: 24, denominator: 1 }, true)).toThrow();
    expect(() => timecodeToFrame("00:01:00;00", { numerator: 30000, denominator: 1001 }, true)).toThrow(); expect(() => timecodeToFrame("00:00:00;00", { numerator: 24, denominator: 1 })).toThrow();
    expect(() => timecodeToFrame("00:00:00:24", { numerator: 24, denominator: 1 })).toThrow();
  });
  it("accepts Premiere's all-semicolon drop-frame timecode and keeps non-drop strict", () => {
    const r = { numerator: 30000, denominator: 1001 }, r60 = { numerator: 60000, denominator: 1001 };
    expect(timecodeToFrame("00;01;00;02", r, true)).toBe("1800"); expect(timecodeToFrame("00:01:00;02", r, true)).toBe("1800");
    expect(timecodeToFrame("00;10;00;00", r, true)).toBe(timecodeToFrame("00:10:00;00", r, true));
    expect(timecodeToFrame("-00;01;00;02", r, true)).toBe("-1800"); expect(timecodeToFrame("00;01;00;04", r60, true)).toBe("3600");
    for (let frame = 0; frame < 20000; frame += 37) expect(timecodeToFrame(frameToTimecode(String(frame), r, true).replace(/:/g, ";"), r, true)).toBe(String(frame));
    expect(() => timecodeToFrame("00;01;00;00", r, true)).toThrow("skipped");
    expect(() => timecodeToFrame("00;01;00:02", r, true)).toThrow("separator"); expect(() => timecodeToFrame("00:01:00:02", r, true)).toThrow("separator");
    expect(() => timecodeToFrame("00;00;01;00", { numerator: 24, denominator: 1 })).toThrow("separator"); expect(() => timecodeToFrame("00;00;01:00", { numerator: 24, denominator: 1 })).toThrow("separator");
    expect(() => timecodeToFrame("00:00:01;00", r, false)).toThrow("separator");
  });
});

describe("bounded snapshot and expected edits", () => {
  it("binds canonical content and refuses drift, unknown fields and missing pages", () => {
    const s = fixtureSnapshot(); expect(validateSnapshot(s)).toEqual(s); const changed = structuredClone(s); changed.clips[0].enabled = false; expect(() => validateSnapshot(changed)).toThrow("revision");
    expect(() => validateSnapshot({ ...s, accidental: true })).toThrow("unknown field");
    const incomplete = revise({ ...s, completeness: { ...s.completeness, clips: false }, pagination: { offset: 0, total: 2, next_offset: 1 } }); // revise resets total; set below
    incomplete.pagination.total = 2; incomplete.revision = snapshotRevision(incomplete); expect(validateSnapshot(incomplete).pagination.next_offset).toBe(1); expect(() => predictEdits(incomplete, [{ type: "enable", clip_id: "clip1", enabled: false }])).toThrow("INCOMPLETE");
  });
  it("models trim/move/split/enable without changing input", () => {
    const s = fixtureSnapshot(), original = JSON.stringify(s);
    const enabled = predictEdits(s, [{ type: "enable", clip_id: "clip1", enabled: false }]); expect(enabled.changes).toHaveLength(1); expect(enabled.snapshot.clips[0].enabled).toBe(false);
    const trim = predictEdits(s, [{ type: "trim", clip_id: "clip1", out_ticks: second(2) }]); expect(trim.snapshot.clips[0].end_ticks).toBe(second(1));
    const move = predictEdits(s, [{ type: "move", clip_id: "clip1", start_ticks: second(5) }]); expect(move.snapshot.clips[0].end_ticks).toBe(second(7));
    const split = predictEdits(s, [{ type: "split", clip_id: "clip1", at_ticks: second(1), right_id: "right" }]); expect(split.snapshot.clips[1]).toMatchObject({ identity: "synthetic", in_ticks: second(2), start_ticks: second(1) }); expect(split.snapshot.clips[0].out_ticks).toBe(second(2));
    expect(JSON.stringify(s)).toBe(original);
  });
  it("models insertion, full overwrite and sync-locked ripple participants", () => {
    const s = fixtureSnapshot(); s.clips.push({ ...s.clips[0], id: "clip2", source_id: "source2", start_ticks: second(3), end_ticks: second(5) }); revise(s);
    const inserted = { ...s.clips[0], id: "inserted", source_id: "source3", start_ticks: second(2), end_ticks: second(3), in_ticks: "0", out_ticks: second(1) };
    const insert = predictEdits(s, [{ type: "insert", clip: inserted, scope: "sync_locked" }]); expect(insert.snapshot.clips.find(c => c.id === "clip2")?.start_ticks).toBe(second(4));
    const overwrite = predictEdits(s, [{ type: "overwrite", clip: { ...inserted, start_ticks: "0", end_ticks: second(2), out_ticks: second(2) }, scope: "track" }]); expect(overwrite.snapshot.clips.some(c => c.id === "clip1")).toBe(false);
    const ripple = predictEdits(s, [{ type: "remove", clip_id: "clip1", ripple: true, scope: "sync_locked" }]); expect(ripple.snapshot.clips[0].start_ticks).toBe(second(1)); expect(ripple.participants).toEqual(["clip1", "clip2"]);
    expect(predictEdits(s, [{ type: "remove", clip_id: "clip1", ripple: false, scope: "track" }]).snapshot.clips[0].start_ticks).toBe(second(3));
  });
  it("predicts moves and shortening trims without a source duration, refusing extensions and inserts", () => {
    const s = fixtureSnapshot(); s.clips[0].source_duration_ticks = null; revise(s);
    const move = predictEdits(s, [{ type: "move", clip_id: "clip1", start_ticks: second(5) }]);
    expect(move.snapshot.clips[0]).toMatchObject({ start_ticks: second(5), end_ticks: second(7), in_ticks: second(1), out_ticks: second(3) });
    const shortenOut = predictEdits(s, [{ type: "trim", clip_id: "clip1", out_ticks: second(2) }]); expect(shortenOut.snapshot.clips[0]).toMatchObject({ end_ticks: second(1), out_ticks: second(2) });
    const shortenIn = predictEdits(s, [{ type: "trim", clip_id: "clip1", in_ticks: second(2) }]); expect(shortenIn.snapshot.clips[0]).toMatchObject({ start_ticks: second(1), in_ticks: second(2) });
    expect(() => predictEdits(s, [{ type: "trim", clip_id: "clip1", out_ticks: second(4) }])).toThrow("SOURCE_DURATION_UNKNOWN: a source duration is needed only to extend beyond");
    const moved = structuredClone(s); moved.clips[0].start_ticks = second(2); moved.clips[0].end_ticks = second(4); revise(moved);
    expect(() => predictEdits(moved, [{ type: "trim", clip_id: "clip1", in_ticks: second(0) }])).toThrow("SOURCE_DURATION_UNKNOWN");
    expect(() => predictEdits(s, [{ type: "trim", clip_id: "clip1", out_ticks: second(1) }])).toThrow("SOURCE_HANDLE_BOUNDARY");
    const candidate = { ...s.clips[0], id: "inserted", source_id: "source3", start_ticks: second(2), end_ticks: second(3), in_ticks: "0", out_ticks: second(1), source_duration_ticks: null };
    expect(() => predictEdits(s, [{ type: "insert", clip: candidate, scope: "track" }])).toThrow("SOURCE_DURATION_UNKNOWN: inserted or overwritten");
    expect(() => predictEdits(s, [{ type: "overwrite", clip: candidate, scope: "track" }])).toThrow("SOURCE_DURATION_UNKNOWN: inserted or overwritten");
    const neighbor = structuredClone(s); neighbor.clips.push({ ...s.clips[0], id: "neighbor", start_ticks: second(3), end_ticks: second(5) }); revise(neighbor);
    expect(() => predictEdits(neighbor, [{ type: "move", clip_id: "clip1", start_ticks: second(2) }])).toThrow("NEIGHBOR");
  });
  it("refuses locks, unknown handles, collisions, unsupported semantics and slivers", () => {
    const s = fixtureSnapshot(), c = s.clips[0];
    expect(() => sourceHandlePreflight(s, { ...c, source_duration_ticks: null }, c.in_ticks, c.out_ticks, c.start_ticks, c.end_ticks, true)).toThrow("SOURCE_DURATION");
    expect(() => sourceHandlePreflight(s, { ...c, source_duration_ticks: null }, second(0), c.out_ticks, second(-1), c.end_ticks)).toThrow("SOURCE_DURATION");
    expect(() => sourceHandlePreflight(s, { ...c, reversed: true }, c.in_ticks, c.out_ticks, c.start_ticks, c.end_ticks)).toThrow("UNSUPPORTED");
    expect(() => sourceHandlePreflight(s, c, "0", "1", "0", "1")).toThrow("sliver");
    const locked = structuredClone(s); locked.tracks[0].locked = true; revise(locked); expect(() => predictEdits(locked, [{ type: "enable", clip_id: c.id, enabled: false }])).toThrow("LOCKED");
    const synthetic = structuredClone(s); synthetic.clips[0].identity = "synthetic"; revise(synthetic); expect(() => predictEdits(synthetic, [{ type: "enable", clip_id: c.id, enabled: false }])).toThrow("SYNTHETIC");
    const unknownSync = structuredClone(s); unknownSync.tracks[1].sync_locked = null; revise(unknownSync); expect(() => affectedTracks(unknownSync, "video:0", "sync_locked")).toThrow("SYNC_SCOPE_UNKNOWN");
    expect(() => predictEdits(s, [{ type: "trim", clip_id: c.id }])).toThrow("exactly one"); expect(() => predictEdits(s, [{ type: "split", clip_id: c.id, at_ticks: "0", right_id: "right" }])).toThrow("boundary");
    expect(() => predictEdits(s, [{ type: "enable", clip_id: "missing", enabled: false }])).toThrow("CLIP_NOT_FOUND"); expect(() => predictEdits(s, [])).toThrow();
    const collision = structuredClone(s); collision.clips.push({ ...c, id: "neighbor", start_ticks: second(3), end_ticks: second(5) }); revise(collision); expect(() => predictEdits(collision, [{ type: "move", clip_id: c.id, start_ticks: second(2) }])).toThrow("NEIGHBOR");
    expect(() => predictEdits(s, [{ type: "insert", clip: { ...c, id: "new", start_ticks: second(1), end_ticks: second(3) }, scope: "track" }])).toThrow("STRADDLING");
    expect(() => predictEdits(s, [{ type: "overwrite", clip: { ...c, id: "new", start_ticks: second(1), end_ticks: second(3) }, scope: "track" }])).toThrow("OVERWRITE");
  });
  it("checks linked identities and preserved source/range/time domains", () => {
    const s = fixtureSnapshot(), c = s.clips[0], partner = { ...c, id: "audio", track_id: "audio:0", linked_ids: [c.id] }; c.linked_ids = [partner.id]; s.clips.push(partner); revise(s);
    expect(validateSnapshot(s).clips).toHaveLength(2); expect(() => predictEdits(s, [{ type: "move", clip_id: c.id, start_ticks: second(5) }])).toThrow("LINKED");
    const broken = structuredClone(s); broken.clips[1].linked_ids = []; revise(broken); expect(() => validateSnapshot(broken)).toThrow("reciprocal");
    expect(verifyContinuity(s, s).verified).toBe(true); const changed = structuredClone(s); changed.clips[1].in_ticks = second(2); revise(changed); expect(verifyContinuity(s, changed).discrepancies).toContain("audio:in_ticks");
    const wrong = { ...s, project_id: "another" }; wrong.revision = snapshotRevision(wrong); expect(() => verifyContinuity(s, wrong)).toThrow("IDENTITY");
    expect(mapTimeDomain(c, second(2), "source")).toMatchObject({ clip_relative_ticks: second(1), sequence_ticks: second(1), outside_visible_range: false });
    expect(mapTimeDomain(c, second(2), "clip_relative").outside_visible_range).toBe(true); expect(mapTimeDomain(c, second(1), "sequence").source_ticks).toBe(second(2)); expect(() => mapTimeDomain({ ...c, nested: true }, "0", "source")).toThrow("UNSUPPORTED");
  });
  it.each([
    (s: TimelineSnapshot) => { s.schema_version = 2 as any; }, (s: TimelineSnapshot) => { s.tracks.push(s.tracks[0]); }, (s: TimelineSnapshot) => { s.clips[0].track_id = "missing"; }, (s: TimelineSnapshot) => { s.clips[0].end_ticks = "0"; }, (s: TimelineSnapshot) => { s.clips[0].source_duration_ticks = "1"; }, (s: TimelineSnapshot) => { s.tracks[0].locked = null; }, (s: TimelineSnapshot) => { s.clips.push(s.clips[0]); }, (s: TimelineSnapshot) => { s.pagination.offset = 1; },
  ])("rejects malformed complete snapshots", mutate => { const s = fixtureSnapshot(); mutate(s); s.revision = snapshotRevision(s); expect(() => validateSnapshot(s)).toThrow(); });
});

describe("editorial evidence planners", () => {
  it("recovers known sample offsets and refuses silence/noise ambiguity", () => {
    let seed = 17; const reference = Array.from({ length: 128 }, () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; });
    const candidate = [...Array(7).fill(0), ...reference].slice(0, 128), plan = planAudioSynchronization(reference, candidate, 1000, 16); expect(plan).toMatchObject({ status: "review_required", offset_seconds: -0.007 }); expect(plan.candidates[0].offset_samples).toBe(7);
    expect(planAudioSynchronization(Array(32).fill(0), Array(32).fill(0), 1000, 5).status).toBe("refused");
    const periodic = Array.from({ length: 100 }, (_, i) => Math.sin(i * Math.PI / 2)); expect(planAudioSynchronization(periodic, periodic, 1000, 10).status).toBe("ambiguous");
    expect(() => planAudioSynchronization(reference, candidate, 0, 16)).toThrow(); expect(() => planAudioSynchronization([NaN], [1], 1000, 0)).toThrow();
    expect(planAnchorSynchronization(["100", "200"], ["90", "190"])).toMatchObject({ offset_ticks: "10", status: "review_required" }); expect(planAnchorSynchronization(["100", "200"], ["90", "180"]).status).toBe("ambiguous"); expect(() => planAnchorSynchronization([], [])).toThrow();
  });
  it("maps repeated source words to distinct occurrences and refuses nonlinear mapping", () => {
    const s = fixtureSnapshot(); s.clips.push({ ...s.clips[0], id: "repeat", start_ticks: second(10), end_ticks: second(12) }); revise(s);
    const words = { source_project_item_id: "source1", transcript_revision: `sha256:${"a".repeat(64)}`, words: [{ text: "Hello", start_seconds: 1.5, end_seconds: 2 }] };
    const mapped = mapWordsToPlacements(words, s); expect(mapped.occurrences.map(w => w.occurrence_id)).toEqual(["clip1:0", "repeat:0"]); expect(mapped.occurrences[1].sequence_start_ticks).toBe(second(10.5));
    s.clips[1].reversed = true; revise(s); expect(() => mapWordsToPlacements(words, s)).toThrow("UNSUPPORTED_WORD_MAPPING");
  });
  it("proposes reproducible exact-duration protected music joins", () => {
    const input = { beats_ticks: Array.from({ length: 21 }, (_, i) => second(i)), source_duration_ticks: second(20), target_duration_ticks: second(12), protected_intro_ticks: second(2), protected_outro_ticks: second(2), crossfade_ticks: second(1), signal_classification: "music" as const };
    const plan = planMusicRemix(input); expect(plan).toEqual(planMusicRemix(input)); expect(plan.native_remix_supported).toBe(false);
    const total = plan.segments.reduce((sum, segment) => sum + ticks(segment.source_out_ticks) - ticks(segment.source_in_ticks), 0n) - ticks(plan.crossfade_ticks); expect(total.toString()).toBe(second(12));
    expect(() => planMusicRemix({ ...input, signal_classification: "noise" })).toThrow("MUSIC"); expect(() => planMusicRemix({ ...input, target_duration_ticks: second(30) })).toThrow("shortening");
    expect(planMusicRemix({ ...input, target_duration_ticks: second(20) }).review_required).toBe(false);
    expect(() => planMusicRemix({ ...input, beats_ticks: ["0", "1"] })).toThrow();
  });
  it("keeps false-positive scene candidates out of approved handle plans", () => {
    const plan = { source_id: "source", source_duration_ticks: second(10), candidates: [{ ticks: second(3), confidence: 0.9, classification: "cut" as const }, { ticks: second(4), confidence: 0.8, classification: "flash" as const }], approved_indices: [0], handle_ticks: second(1) };
    const segments = planSceneSegmentation(plan); expect(segments.segments).toHaveLength(2); expect(segments.segments[0].handle_out_ticks).toBe(second(4)); expect(segments.rejected_candidates[0].classification).toBe("flash"); expect(segments.preserve_audio).toBe(true);
    expect(() => planSceneSegmentation({ ...plan, approved_indices: [0, 0] })).toThrow(); expect(() => planSceneSegmentation({ ...plan, approved_indices: [5] })).toThrow(); expect(() => planSceneSegmentation({ ...plan, candidates: [{ ...plan.candidates[0], confidence: NaN }] })).toThrow();
  });
  it("separates rendered multilingual caption measurements from metadata", () => {
    const evidence = { artifact_sha256: "a".repeat(64), frame_width: 1080, frame_height: 1920, safe_margin: 0.1, cues: [{ text: "مرحبا שלום", bounds: { x: 200, y: 200, width: 500, height: 80 }, missing_glyphs: [], line_breaks_verified: true, bidi_verified: true, sampled_ticks: "0", evidence_method: "pixel_measurement" as const }] };
    expect(verifyCaptionRenderEvidence(evidence).passed).toBe(true); evidence.cues[0].bidi_verified = false; evidence.cues[0].bounds.x = 0; expect(verifyCaptionRenderEvidence(evidence).issues.map(i => i.reason)).toEqual(["outside_safe_zone_or_clipped", "bidi_unverified"]);
    expect(() => verifyCaptionRenderEvidence({ ...evidence, artifact_sha256: "wrong" })).toThrow();
  });
  it("requires actual provenance identities and full-resolution delivery evidence", () => {
    const p = { source_id: "source", source_sha256: "a".repeat(64), proxy_sha256: "b".repeat(64), original_offline: false, proxy_attached: true, analysis_provider: "proxy" as const, snapshot_revision: "revision", export_provider_verified: false };
    expect(bindProxyProvenance(p).delivery_ready).toBe(false); expect(bindProxyProvenance({ ...p, export_provider_verified: true }).delivery_ready).toBe(true); expect(() => bindProxyProvenance({ ...p, proxy_attached: false })).toThrow(); expect(() => bindProxyProvenance({ ...p, analysis_provider: "original", original_offline: true })).toThrow();
  });
  it("plans pre-razored ordinary camera ranges preserving master audio", () => {
    const s = fixtureSnapshot(); s.tracks.push({ ...s.tracks[0], id: "video:1", index: 1 }); s.clips.push({ ...s.clips[0], id: "camera2", source_id: "source2", track_id: "video:1" }, { ...s.clips[0], id: "master", track_id: "audio:0" }); revise(s);
    const plan = planStackedCameraEdit(s, [{ start_ticks: "0", end_ticks: second(2), camera_track_id: "video:1" }], ["video:0", "video:1"], ["audio:0"]); expect(plan.operations).toEqual([{ type: "enable", clip_id: "clip1", enabled: false }, { type: "enable", clip_id: "camera2", enabled: true }]); expect(plan.master_audio[0].id).toBe("master"); expect(plan.native_multicam).toBe(false);
    expect(() => planStackedCameraEdit(s, [{ start_ticks: "0", end_ticks: second(1), camera_track_id: "video:1" }], ["video:0", "video:1"], ["audio:0"])).toThrow("BOUNDARIES");
  });
  it("loads versioned checkpoint receipt states without replay", () => {
    const checkpoint = { schema_version: 1, project_id: "p", sequence_id: "s", snapshot_revision: "r", backup_reference: null, sequence_checkpoint_reference: "checkpoint", operations: [{ operation_id: "operation", tool: "trim_clip", state: "unknown", receipt_digest: `sha256:${"a".repeat(64)}` }] };
    expect(validateWorkflowCheckpoint(checkpoint)).toMatchObject({ automatic_replay: false, recovery_required: true }); expect(() => validateWorkflowCheckpoint({ ...checkpoint, schema_version: 2 })).toThrow(); expect(() => validateWorkflowCheckpoint({ ...checkpoint, operations: [...checkpoint.operations, checkpoint.operations[0]] })).toThrow("duplicate");
  });
});
