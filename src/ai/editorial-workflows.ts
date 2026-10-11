import { createHash } from "node:crypto";
import { ticks, secondsToTicks } from "./exact-time.js";
import { boundedObject, identity, validateSnapshot, predictEdits, type ExpectedEdit, type TimelineSnapshot } from "./timeline-contract.js";
import { validateWordTimeline } from "./word-timeline.js";

export function planAudioSynchronization(reference: number[], candidate: number[], sampleRate: number, maxLag: number) {
  if (!Array.isArray(reference) || !Array.isArray(candidate) || reference.length < 16 || candidate.length < 16 || reference.length > 8192 || candidate.length > 8192 || [...reference, ...candidate].some(n => !Number.isFinite(n) || Math.abs(n) > 1)) throw new Error("audio must contain 16 to 8192 finite normalized mono samples per input");
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 1 || sampleRate > 768000 || !Number.isSafeInteger(maxLag) || maxLag < 0 || maxLag > 1024 || (2 * maxLag + 1) * Math.min(reference.length, candidate.length) > 2000000) throw new Error("sample rate/lag invalid or correlation work exceeds 2000000 comparisons");
  const centered = (samples: number[]) => { const mean = samples.reduce((a, b) => a + b, 0) / samples.length; return samples.map(n => n - mean); };
  const a = centered(reference), b = centered(candidate);
  const energy = (samples: number[]) => samples.reduce((sum, n) => sum + n * n, 0) / samples.length;
  if (energy(a) < 1e-8 || energy(b) < 1e-8) return { status: "refused", reason: "silent_or_constant_audio", candidates: [], host_applied: false };
  const candidates: Array<{ offset_samples: number; correlation: number; overlap_samples: number }> = [];
  for (let offset = -maxLag; offset <= maxLag; offset++) {
    let numerator = 0, ae = 0, be = 0, count = 0;
    for (let i = Math.max(0, -offset); i < a.length && i + offset < b.length; i++) { const x = a[i], y = b[i + offset]; numerator += x * y; ae += x * x; be += y * y; count++; }
    if (count >= Math.max(16, Math.ceil(Math.min(a.length, b.length) * 0.5))) candidates.push({ offset_samples: offset, correlation: ae && be ? numerator / Math.sqrt(ae * be) : 0, overlap_samples: count });
  }
  candidates.sort((x, y) => y.correlation - x.correlation || Math.abs(x.offset_samples) - Math.abs(y.offset_samples) || x.offset_samples - y.offset_samples);
  const best = candidates[0], second = candidates.find(c => Math.abs(c.offset_samples - (best?.offset_samples ?? 0)) > 2);
  const confidence = best ? Math.max(0, Math.min(1, best.correlation)) : 0, margin = confidence - (second?.correlation ?? 0);
  const status = confidence < 0.65 ? "refused" : margin < 0.08 ? "ambiguous" : "review_required";
  return { status, confidence, ambiguity_margin: margin, candidates: candidates.slice(0, 5), offset_convention: "candidate[i + offset] matches reference[i]; subtract offset from candidate placement", offset_seconds: best ? -best.offset_samples / sampleRate : null, host_applied: false, scope: "bounded sample correlation; not audible synchronization proof" };
}
export function planAnchorSynchronization(referenceTicks: string[], candidateTicks: string[]) {
  if (!Array.isArray(referenceTicks) || !Array.isArray(candidateTicks) || referenceTicks.length < 1 || referenceTicks.length !== candidateTicks.length || referenceTicks.length > 256) throw new Error("matched marker/timecode anchors require 1 to 256 pairs");
  const offsets = referenceTicks.map((value, index) => ticks(value) - ticks(candidateTicks[index])).sort((a, b) => a < b ? -1 : a > b ? 1 : 0), middle = offsets[Math.floor(offsets.length / 2)];
  const disagreement = offsets.some(n => n !== middle);
  return { status: disagreement ? "ambiguous" : "review_required", offset_ticks: middle.toString(), confidence: disagreement ? null : 1, evidence: "caller-matched anchors", disagreements: offsets.filter(n => n !== middle).map(String), host_applied: false };
}
export function mapWordsToPlacements(wordInput: unknown, snapshotInput: unknown) {
  const timeline = validateWordTimeline(wordInput), snapshot = validateSnapshot(snapshotInput);
  const sourceClips = snapshot.clips.filter(c => c.source_id === timeline.source_project_item_id);
  if (!snapshot.completeness.clips) throw new Error("INCOMPLETE_SNAPSHOT: repeated placements cannot be mapped from missing pages");
  if (sourceClips.some(c => c.nested || c.reversed || c.speed.numerator !== c.speed.denominator)) throw new Error("UNSUPPORTED_WORD_MAPPING: nested, reverse and retimed sources require a measured mapping");
  const mapped = [];
  for (const clip of sourceClips) for (let index = 0; index < timeline.words.length; index++) {
    const word = timeline.words[index], fromSeconds = (n: number) => ticks(secondsToTicks(n));
    const sourceStart = fromSeconds(word.start_seconds), sourceEnd = fromSeconds(word.end_seconds), i = ticks(clip.in_ticks), o = ticks(clip.out_ticks);
    const start = sourceStart > i ? sourceStart : i, end = sourceEnd < o ? sourceEnd : o;
    if (start >= end) continue;
    if (mapped.length >= 20000) throw new Error("word placement expansion exceeds 20000 fragments");
    mapped.push({ occurrence_id: `${clip.id}:${index}`, placement_id: clip.id, word_index: index, text: word.text, source_start_ticks: start.toString(), source_end_ticks: end.toString(), sequence_start_ticks: (ticks(clip.start_ticks) + start - i).toString(), sequence_end_ticks: (ticks(clip.start_ticks) + end - i).toString(), clipped: start !== sourceStart || end !== sourceEnd });
  }
  return { transcript_revision: timeline.transcript_revision, snapshot_revision: snapshot.revision, occurrences: mapped, host_applied: false };
}
export function planMusicRemix(input: { beats_ticks: string[]; source_duration_ticks: string; target_duration_ticks: string; protected_intro_ticks: string; protected_outro_ticks: string; crossfade_ticks?: string; signal_classification: "music" | "silence" | "noise" }) {
  boundedObject(input, ["beats_ticks", "source_duration_ticks", "target_duration_ticks", "protected_intro_ticks", "protected_outro_ticks", "crossfade_ticks", "signal_classification"], "music remix");
  if (input.signal_classification !== "music") throw new Error("MUSIC_EVIDENCE_REQUIRED: silence/noise cannot produce a music remix plan");
  if (!Array.isArray(input.beats_ticks) || input.beats_ticks.length < 4 || input.beats_ticks.length > 4096) throw new Error("beats require 4 to 4096 entries");
  const duration = ticks(input.source_duration_ticks), target = ticks(input.target_duration_ticks), intro = ticks(input.protected_intro_ticks), outro = ticks(input.protected_outro_ticks), fade = ticks(input.crossfade_ticks ?? "0");
  if (duration <= 0n || target <= 0n || target > duration || intro < 0n || outro < 0n || fade < 0n || intro + outro > target) throw new Error("remix supports shortening within protected source ranges");
  const beats = input.beats_ticks.map(value => ticks(value));
  if (beats.some((value, index) => value < 0n || value > duration || (index > 0 && value <= beats[index - 1]))) throw new Error("beats must be strictly ordered within source duration");
  const removal = duration - target;
  if (!removal) return { segments: [{ source_in_ticks: "0", source_out_ticks: duration.toString() }], target_duration_ticks: target.toString(), crossfade_ticks: "0", review_required: false, native_remix_supported: false };
  let best: { from: bigint; to: bigint; error: bigint } | null = null;
  for (let i = 0; i < beats.length; i++) {
    const from = beats[i]; if (from < intro + fade) continue;
    // Exact duration: second boundary is proposed, and its nearest measured beat is reported.
    const to = from + removal - fade; if (to <= from || to + outro + fade > duration) continue;
    let lower = 0, upper = beats.length;
    while (lower < upper) { const mid = (lower + upper) >>> 1; if (beats[mid] < to) lower = mid + 1; else upper = mid; }
    const near = [beats[lower], beats[lower - 1]].filter((n): n is bigint => n !== undefined).map(n => n > to ? n - to : to - n);
    const error = near.reduce((a, b) => a < b ? a : b);
    if (!best || error < best.error) best = { from, to, error };
  }
  if (!best) throw new Error("no join preserves protected intro/outro and crossfade handles");
  return { segments: [{ source_in_ticks: "0", source_out_ticks: best.from.toString() }, { source_in_ticks: best.to.toString(), source_out_ticks: duration.toString() }], target_duration_ticks: target.toString(), crossfade_ticks: fade.toString(), nearest_beat_error_ticks: best.error.toString(), review_required: true, native_remix_supported: false, audible_clicks_verified: false, algorithm: "deterministic-shortening-v1" };
}
export function planSceneSegmentation(input: { source_id: string; source_duration_ticks: string; candidates: Array<{ ticks: string; confidence: number; classification: "cut" | "flash" | "pan" | "fade" }>; approved_indices: number[]; handle_ticks?: string }) {
  boundedObject(input, ["source_id", "source_duration_ticks", "candidates", "approved_indices", "handle_ticks"], "scene segmentation");
  identity(input.source_id, "source_id");
  const duration = ticks(input.source_duration_ticks), handle = ticks(input.handle_ticks ?? "0");
  if (duration <= 0n || handle < 0n || !Array.isArray(input.candidates) || input.candidates.length > 2000 || !Array.isArray(input.approved_indices) || input.approved_indices.length > 2000 || new Set(input.approved_indices).size !== input.approved_indices.length) throw new Error("invalid bounded scene evidence");
  input.candidates.forEach(candidate => { boundedObject(candidate, ["ticks", "confidence", "classification"], "scene candidate"); if (ticks(candidate.ticks) <= 0n || ticks(candidate.ticks) >= duration || !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1 || !["cut", "flash", "pan", "fade"].includes(candidate.classification)) throw new Error("invalid scene candidate"); });
  const approved = input.approved_indices.map(index => { if (!Number.isSafeInteger(index) || !input.candidates[index]) throw new Error("approved scene index invalid"); return input.candidates[index]; }).sort((a, b) => ticks(a.ticks) < ticks(b.ticks) ? -1 : 1);
  if (new Set(approved.map(c => c.ticks)).size !== approved.length) throw new Error("duplicate approved scene boundary");
  const boundaries = [0n, ...approved.map(c => ticks(c.ticks)), duration];
  return { source_id: input.source_id, segments: boundaries.slice(0, -1).map((start, index) => ({ index, start_ticks: start.toString(), end_ticks: boundaries[index + 1].toString(), handle_in_ticks: (start > handle ? start - handle : 0n).toString(), handle_out_ticks: (boundaries[index + 1] + handle < duration ? boundaries[index + 1] + handle : duration).toString() })), approved_candidates: approved, rejected_candidates: input.candidates.filter((_c, index) => !input.approved_indices.includes(index)), preserve_audio: true, apply_routes: ["add_markers_batch", "create_subclip", "create_bin"], host_applied: false };
}
export function verifyCaptionRenderEvidence(input: { artifact_sha256: string; frame_width: number; frame_height: number; safe_margin: number; cues: Array<{ text: string; bounds: { x: number; y: number; width: number; height: number }; missing_glyphs: string[]; line_breaks_verified: boolean; bidi_verified: boolean; sampled_ticks: string; evidence_method: "manual_render_review" | "pixel_measurement" }> }) {
  boundedObject(input, ["artifact_sha256", "frame_width", "frame_height", "safe_margin", "cues"], "caption evidence");
  if (!/^[a-f0-9]{64}$/.test(input.artifact_sha256) || !Number.isInteger(input.frame_width) || !Number.isInteger(input.frame_height) || input.frame_width < 16 || input.frame_height < 16 || input.frame_width > 16384 || input.frame_height > 16384 || !Number.isFinite(input.safe_margin) || input.safe_margin < 0 || input.safe_margin >= 0.5 || !Array.isArray(input.cues) || input.cues.length < 1 || input.cues.length > 1000) throw new Error("invalid rendered caption evidence bounds");
  const issues: Array<{ index: number; reason: string }> = [];
  input.cues.forEach((cue, index) => {
    boundedObject(cue, ["text", "bounds", "missing_glyphs", "line_breaks_verified", "bidi_verified", "sampled_ticks", "evidence_method"], "cue evidence");
    if (typeof cue.text !== "string" || cue.text.length > 4096 || !Array.isArray(cue.missing_glyphs) || cue.missing_glyphs.length > 256 || cue.missing_glyphs.some(s => typeof s !== "string" || s.length > 16) || !["manual_render_review", "pixel_measurement"].includes(cue.evidence_method) || typeof cue.line_breaks_verified !== "boolean" || typeof cue.bidi_verified !== "boolean") throw new Error("invalid caption cue review");
    ticks(cue.sampled_ticks); const b = boundedObject(cue.bounds, ["x", "y", "width", "height"], "caption bounds") as typeof cue.bounds;
    if ([b.x, b.y, b.width, b.height].some(n => !Number.isFinite(n)) || b.width <= 0 || b.height <= 0) throw new Error("invalid measured caption bounds");
    if (b.x < input.frame_width * input.safe_margin || b.y < input.frame_height * input.safe_margin || b.x + b.width > input.frame_width * (1 - input.safe_margin) || b.y + b.height > input.frame_height * (1 - input.safe_margin)) issues.push({ index, reason: "outside_safe_zone_or_clipped" });
    if (cue.missing_glyphs.length) issues.push({ index, reason: "missing_glyphs" });
    if (!cue.line_breaks_verified) issues.push({ index, reason: "line_breaks_unverified" });
    if (/[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(cue.text) && !cue.bidi_verified) issues.push({ index, reason: "bidi_unverified" });
  });
  return { artifact_sha256: input.artifact_sha256, passed: issues.length === 0, issues, sampled_cues: input.cues.length, evidence_scope: "caller-supplied measurements of this rendered artifact; no OCR or exhaustive glyph/render claim" };
}
export function bindProxyProvenance(input: { source_id: string; source_sha256: string | null; proxy_sha256: string | null; original_offline: boolean; proxy_attached: boolean; analysis_provider: "original" | "proxy"; snapshot_revision: string; export_provider_verified: boolean }) {
  boundedObject(input, ["source_id", "source_sha256", "proxy_sha256", "original_offline", "proxy_attached", "analysis_provider", "snapshot_revision", "export_provider_verified"], "provenance");
  identity(input.source_id, "source_id"); identity(input.snapshot_revision, "snapshot_revision");
  for (const digest of [input.source_sha256, input.proxy_sha256]) if (digest !== null && !/^[a-f0-9]{64}$/.test(digest)) throw new Error("media identity requires SHA256 or null");
  for (const flag of [input.original_offline, input.proxy_attached, input.export_provider_verified]) if (typeof flag !== "boolean") throw new Error("provenance flags must be boolean");
  if (!["original", "proxy"].includes(input.analysis_provider) || (input.analysis_provider === "proxy" && (!input.proxy_attached || !input.proxy_sha256)) || (input.analysis_provider === "original" && (input.original_offline || !input.source_sha256))) throw new Error("analysis provider is unavailable or lacks content identity");
  return { ...input, analysis_identity: input.analysis_provider === "proxy" ? input.proxy_sha256 : input.source_sha256, revision: `sha256:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`, delivery_ready: !input.original_offline && input.source_sha256 !== null && input.export_provider_verified, limitations: input.export_provider_verified ? ["Export provider is caller-evidenced; rendered artifact still requires verification."] : ["Proxy attachment does not prove full-resolution export provider."] };
}
export function planStackedCameraEdit(snapshotInput: unknown, cuts: Array<{ start_ticks: string; end_ticks: string; camera_track_id: string }>, cameraTracks: string[], masterAudioTracks: string[]) {
  const snapshot = validateSnapshot(snapshotInput);
  if (!snapshot.completeness.clips || !snapshot.completeness.locks || !snapshot.completeness.links || !Array.isArray(cuts) || !cuts.length || cuts.length > 100 || !cameraTracks.length || cameraTracks.length > 16 || !masterAudioTracks.length || masterAudioTracks.length > 32 || new Set(cameraTracks).size !== cameraTracks.length || new Set(masterAudioTracks).size !== masterAudioTracks.length) throw new Error("stacked camera edit requires bounded complete clips, links and explicit master audio");
  for (const id of cameraTracks) if (!snapshot.tracks.some(t => t.id === id && t.type === "video" && t.locked === false)) throw new Error("camera track must be an unlocked inspected video track");
  for (const id of masterAudioTracks) if (!snapshot.tracks.some(t => t.id === id && t.type === "audio")) throw new Error("master audio track missing");
  cuts.forEach((cut, index) => { boundedObject(cut, ["start_ticks", "end_ticks", "camera_track_id"], "camera cut"); if (ticks(cut.end_ticks) <= ticks(cut.start_ticks) || !cameraTracks.includes(cut.camera_track_id) || (index && cut.start_ticks !== cuts[index - 1].end_ticks)) throw new Error("camera cuts must be contiguous, ordered and mapped"); });
  const operations: ExpectedEdit[] = [];
  for (const cut of cuts) {
    for (const trackId of cameraTracks) {
      const clips = snapshot.clips.filter(c => c.track_id === trackId && ticks(c.start_ticks) < ticks(cut.end_ticks) && ticks(c.end_ticks) > ticks(cut.start_ticks));
      if (clips.length !== 1 || clips[0].start_ticks !== cut.start_ticks || clips[0].end_ticks !== cut.end_ticks || clips[0].nested || clips[0].reversed || clips[0].speed.numerator !== clips[0].speed.denominator) throw new Error("CAMERA_BOUNDARIES_REQUIRE_REVIEW: pre-razor ordinary camera clips at every approved cut using a supported route");
      operations.push({ type: "enable", clip_id: clips[0].id, enabled: trackId === cut.camera_track_id });
    }
  }
  if (operations.length > 100) throw new Error("camera edit exceeds 100 bound operations; split reviewed ranges");
  const expected = predictEdits(snapshot, operations);
  return { snapshot_revision: snapshot.revision, operations, expected, master_audio: snapshot.clips.filter(c => masterAudioTracks.includes(c.track_id)), duplicate_required: true, native_multicam: false, limitation: "Only ordinary pre-razored stacked clips; no native multicam angle-switching API." };
}
/** Versioned receipt state is a review aid; loading never executes pending work. */
export function validateWorkflowCheckpoint(input: unknown) {
  const raw = boundedObject(input, ["schema_version", "project_id", "sequence_id", "snapshot_revision", "backup_reference", "sequence_checkpoint_reference", "operations"], "checkpoint");
  if (raw.schema_version !== 1 || !Array.isArray(raw.operations) || raw.operations.length > 1000) throw new Error("unsupported workflow checkpoint version or operation bound");
  for (const key of ["project_id", "sequence_id", "snapshot_revision"]) identity(raw[key], key);
  for (const key of ["backup_reference", "sequence_checkpoint_reference"]) if (raw[key] !== null) identity(raw[key], key);
  const seen = new Set<string>();
  const operations = raw.operations.map(value => { const op = boundedObject(value, ["operation_id", "tool", "state", "receipt_digest"], "checkpoint operation"); const id = identity(op.operation_id, "operation_id"); if (seen.has(id)) throw new Error("duplicate checkpoint operation"); seen.add(id); identity(op.tool, "tool"); if (!["completed", "pending", "unknown", "failed"].includes(String(op.state))) throw new Error("unknown checkpoint operation state"); if (op.receipt_digest !== null && !/^sha256:[a-f0-9]{64}$/.test(String(op.receipt_digest))) throw new Error("invalid receipt digest"); return op; });
  return { ...raw, operations, automatic_replay: false as const, recovery_required: operations.some(op => op.state === "unknown" || op.state === "pending") };
}
