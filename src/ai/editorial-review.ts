import { createHash } from "node:crypto";
import { z } from "zod";
import { analyzeDialogueEditCandidates, normalizeDialogueSegments } from "../tools/dialogue-analysis.js";

const id = z.string().trim().min(1).max(512);
const revision = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const time = z.number().finite().min(0).max(86400);
const shortText = z.string().max(1000);
const selection = z.array(id).max(512);
const reviewFields = {
  expected_review_revision: revision.optional().describe("Revision from the initial review; required when selecting or rejecting entries. A changed input requires a new review."),
  selected_ids: selection.optional().describe("Explicitly approved entry IDs. Omit for an initial review; an empty array approves nothing."),
  rejected_ids: selection.optional().describe("Explicitly rejected entry IDs. Unselected entries remain pending."),
};
const segment = z.strictObject({
  id: id.max(128).describe("Stable transcript segment ID."),
  source_project_item_id: id.describe("Exact source project-item ID."),
  transcript_revision: revision.describe("Revision of the captured source transcript."),
  start_seconds: time.describe("Source-time start in seconds."),
  end_seconds: time.describe("Source-time end, greater than start."),
  text: shortText.describe("Supplied transcript text; never uploaded or retained by this tool."),
  speaker_label: id.max(128).optional().describe("Reviewed speaker label."),
});
const range = z.strictObject({
  source_project_item_id: id.describe("Exact source project-item ID."),
  start_seconds: time.describe("Source-time start."),
  end_seconds: time.describe("Source-time end greater than start."),
});
export const dialogueReviewSchema = z.strictObject({
  segments: z.array(segment).min(1).max(10000).describe("Captured transcript segments; each source must have one consistent revision."),
  silence_ranges: z.array(range).max(2000).optional().describe("Supplied local silence evidence; every source must occur in segments."),
  filler_words: z.array(z.string().min(1).max(64)).max(64).optional().describe("Exact filler words or phrases to flag for whole-segment review."),
  minimum_silence_seconds: z.number().min(0.1).max(30).optional().describe("Minimum silence duration; defaults to 0.7."),
  padding_seconds: z.number().min(0).max(2).default(0.1).describe("Speech retained at both edges of silence cuts; defaults to 0.1 seconds. Does not alter filler-word ranges."),
  ...reviewFields,
});
export const quoteReviewSchema = z.strictObject({
  segments: z.array(segment).min(1).max(512).describe("Quote library with captured transcript revisions and source ranges."),
  quote_order: z.array(id.max(128)).max(512).optional().describe("Explicitly approved quote IDs in final paper-edit order. Omit for an unapproved library preview."),
  expected_review_revision: reviewFields.expected_review_revision,
});
export const textReviewSchema = z.strictObject({
  entries: z.array(z.strictObject({
    id: id.describe("Stable text-field or cue ID."),
    target_id: id.describe("Exact MOGRT clip or supplied caption-artifact target ID."),
    source_revision: revision.describe("Revision of the inspected text evidence; re-inspect before any later mutation."),
    kind: z.enum(["mogrt_text", "caption_artifact"]).describe("Supported review evidence; not native graphics or native caption editing."),
    original_text: z.string().max(4000).describe("Current inspected text."),
    proposed_text: z.string().max(4000).optional().describe("Optional caller-reviewed replacement, including an empty string."),
  })).min(1).max(512).describe("Bounded copy-review entries; original text is preserved for later comparison."),
  find_text: z.string().min(1).max(1000).optional().describe("Optional literal, case-sensitive search; regex is not executed."),
  replace_text: z.string().max(1000).optional().describe("Literal replacement, required together with find_text. Dollar signs have no special meaning."),
  ...reviewFields,
});
export const syncReviewSchema = z.strictObject({
  matches: z.array(z.strictObject({
    id: id.describe("Stable proposed match ID."),
    camera_source_id: id.describe("Exact camera project-item ID."),
    recorder_source_id: id.describe("Exact recorder project-item ID."),
    camera_revision: revision.describe("Revision of captured camera evidence."),
    recorder_revision: revision.describe("Revision of captured recorder evidence."),
    estimates: z.array(z.strictObject({
      method: z.enum(["timecode", "waveform", "dialogue"]).describe("Independent evidence method supplied by the caller; not run by this tool."),
      offset_seconds: z.number().finite().min(-86400).max(86400).describe("Recorder source time equals camera source time plus this offset."),
      confidence: z.number().min(0).max(1).describe("Caller-supplied confidence, not a calibrated tool probability."),
    })).min(1).max(3).describe("One estimate per independent method; conflicting evidence remains blocked."),
  })).min(1).max(128).describe("Camera-recorder proposals from already captured local analysis."),
  agreement_tolerance_seconds: z.number().min(0).max(1).default(0.04).describe("Maximum spread between methods for agreement; defaults to 0.04 seconds."),
  minimum_confidence: z.number().min(0).max(1).default(0.9).describe("Required confidence on every estimate to label strong agreement; all matches still need approval."),
  ...reviewFields,
});
export const brollReviewSchema = z.strictObject({
  placements: z.array(z.strictObject({
    id: id.describe("Stable placement proposal ID."),
    sequence_id: id.describe("Exact target sequence ID; re-inspect before later insertion."),
    sequence_revision: revision.describe("Revision of captured target-sequence evidence."),
    timeline_start_seconds: time.describe("Proposed destination start in sequence seconds."),
    quote: shortText.describe("Dialogue or editorial intent matched by the caller."),
    source_project_item_id: id.describe("Exact owned-footage source project-item ID."),
    source_revision: revision.describe("Revision of captured source evidence."),
    source_start_seconds: time.describe("Proposed source in point."),
    source_end_seconds: time.describe("Proposed source out point, greater than in."),
    reason: shortText.min(1).describe("Supplied reason for this pick; tool performs no vision inference."),
    alternative_source_ids: z.array(id).max(8).default([]).describe("Other caller-supplied footage candidates for re-review."),
  })).min(1).max(128).describe("Caller-proposed video-only B-roll placements with captured revisions."),
  ...reviewFields,
});

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate IDs`);
}
function consistent(rows: Array<{ key: string; revision: string }>) {
  const revisions = new Map<string, string>();
  for (const row of rows) {
    const prior = revisions.get(row.key);
    if (prior && prior !== row.revision) throw new Error("Conflicting evidence revisions; capture a consistent snapshot");
    revisions.set(row.key, row.revision);
  }
}
function validateSegments(segments: z.infer<typeof segment>[]) {
  const normalized = normalizeDialogueSegments(segments);
  for (const s of normalized) positive(s.start_seconds, s.end_seconds);
  consistent(normalized.map((s) => ({ key: s.source_project_item_id, revision: s.transcript_revision })));
  return normalized;
}
function decide(ids: string[], input: { expected_review_revision?: string; selected_ids?: string[]; rejected_ids?: string[] }, rev: string) {
  unique(ids, "entries");
  if ((input.selected_ids !== undefined || input.rejected_ids !== undefined) && input.expected_review_revision !== rev) throw new Error("Selection requires the unchanged expected_review_revision; preview again");
  if (input.expected_review_revision !== undefined && input.expected_review_revision !== rev) throw new Error("Review evidence changed; preview again");
  const selected = input.selected_ids ?? [], rejected = input.rejected_ids ?? [];
  unique(selected, "selected_ids"); unique(rejected, "rejected_ids");
  if ([...selected, ...rejected].some((x) => !ids.includes(x))) throw new Error("Selection references an unknown entry ID");
  if (selected.some((x) => rejected.includes(x))) throw new Error("An entry cannot be both selected and rejected");
  return (id: string) => selected.includes(id) ? "approved" as const : rejected.includes(id) ? "rejected" as const : "pending" as const;
}
function envelope(rev: string) {
  return { review_revision: rev, applied: false, host_verified: false, approval_token: null,
    verification_boundary: "Local review of supplied evidence only. Not a host apply token; re-inspect targets and use the existing guarded preview/apply tools before mutation." };
}
function positive(start: number, end: number) {
  if (end <= start) throw new Error("Ranges must have positive duration");
}
function unionSeconds(rows: Array<{ source_project_item_id: string; start_seconds: number; end_seconds: number }>) {
  const ends = new Map<string, number>();
  let duration = 0;
  for (const row of [...rows].sort((a, b) => a.source_project_item_id.localeCompare(b.source_project_item_id) || a.start_seconds - b.start_seconds)) {
    const prior = ends.get(row.source_project_item_id) ?? -1;
    duration += Math.max(0, row.end_seconds - Math.max(prior, row.start_seconds));
    ends.set(row.source_project_item_id, Math.max(prior, row.end_seconds));
  }
  return Number(duration.toFixed(6));
}

function contextPassage(segments: Array<{ text: string }>) {
  let text = "";
  for (const segment of segments) {
    const next = (text ? " " : "") + segment.text;
    if (text.length + next.length > 1000) return { text: (text + next).slice(0, 1000), truncated: true };
    text += next;
  }
  return { text, truncated: false };
}

export function reviewDialogue(input: unknown) {
  const args = dialogueReviewSchema.parse(input);
  const segments = validateSegments(args.segments);
  const sources = new Set(segments.map((s) => s.source_project_item_id));
  if (args.silence_ranges?.some((s) => !sources.has(s.source_project_item_id))) throw new Error("Silence evidence references an unknown transcript source");
  const analysis = analyzeDialogueEditCandidates({ segments, fillerWords: args.filler_words, silenceRanges: args.silence_ranges, minimumSilenceSeconds: args.minimum_silence_seconds });
  if (analysis.truncated) throw new Error("Candidate analysis is truncated; narrow inputs before reviewing selections");
  const rev = digest({ analysis_revision: analysis.analysis_revision, padding_seconds: args.padding_seconds });
  const state = decide(analysis.candidates.map((c) => c.id), args, rev);
  const cards = analysis.candidates.map((candidate) => {
    const padding = candidate.reason === "long_silence" ? args.padding_seconds : 0;
    const start = candidate.start_seconds + padding, end = candidate.end_seconds - padding;
    if (state(candidate.id) === "approved" && end <= start) throw new Error("Selected silence has no removable duration after padding");
    const neighbors = segments.filter((s) => s.source_project_item_id === candidate.source_project_item_id);
    const overlapping = neighbors.filter((s) => s.end_seconds > candidate.start_seconds && s.start_seconds < candidate.end_seconds);
    const before = neighbors.filter((s) => s.end_seconds <= candidate.start_seconds).at(-1);
    const after = neighbors.find((s) => s.start_seconds >= candidate.end_seconds);
    const passage = contextPassage(overlapping);
    return { ...candidate, decision: state(candidate.id), context: { before: before?.text ?? "", passage: passage.text, after: after?.text ?? "" }, context_truncated: passage.truncated,
      removable_range: end > start ? { source_project_item_id: candidate.source_project_item_id, start_seconds: start, end_seconds: end } : null };
  });
  const approved = cards.filter((c) => c.decision === "approved").map((c) => c.removable_range!);
  return { ...envelope(rev), cards, approved_source_cut_ranges: approved, projected_removed_source_seconds: unionSeconds(approved),
    pending_count: cards.filter((c) => c.decision === "pending").length,
    limitations: [...analysis.limitations, "Source-time union duration is not a timeline duration estimate. No source-to-sequence mapping or word-level cut is inferred."] };
}

function csvCell(value: string | number) {
  let text = String(value);
  // Neutralize spreadsheet formulas, including cells prefixed by whitespace.
  if (/^[\s]*[=+@-]/u.test(text)) text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
}
export function reviewQuotes(input: unknown) {
  const args = quoteReviewSchema.parse(input);
  const segments = validateSegments(args.segments);
  const rev = digest(segments);
  decide(segments.map((s) => s.id), { expected_review_revision: args.expected_review_revision, selected_ids: args.quote_order }, rev);
  let position = 0;
  const rows = (args.quote_order ?? []).map((id) => {
    const s = segments.find((s) => s.id === id)!;
    const row = { ...s, output_start_seconds: position, duration_seconds: Number((s.end_seconds - s.start_seconds).toFixed(6)) };
    position = Number((position + row.duration_seconds).toFixed(6));
    return row;
  });
  const columns = ["id", "source_project_item_id", "transcript_revision", "start_seconds", "end_seconds", "speaker_label", "text", "output_start_seconds", "duration_seconds"] as const;
  const csv = [columns.map(csvCell).join(","), ...rows.map((row) => columns.map((key) => csvCell(row[key] ?? "")).join(","))].join("\r\n") + "\r\n";
  return { ...envelope(rev), library: segments, rows, output_duration_seconds: position, csv,
    limitations: ["CSV is returned inline, not saved. Only explicitly ordered quotes are included; text is spreadsheet-formula neutralized.", "No multi-source timeline assembly or transcript freshness is verified by this local review."] };
}
export function reviewText(input: unknown) {
  const args = textReviewSchema.parse(input);
  if ((args.find_text === undefined) !== (args.replace_text === undefined)) throw new Error("find_text and replace_text must be supplied together");
  unique(args.entries.map((e) => e.id), "entries");
  consistent(args.entries.map((e) => ({ key: e.target_id, revision: e.source_revision })));
  const proposals = args.entries.map((e) => ({ ...e, proposed_text: e.proposed_text ?? (args.find_text === undefined ? e.original_text : e.original_text.split(args.find_text).join(args.replace_text!)) }));
  if (proposals.some((e) => e.proposed_text.length > 4000)) throw new Error("Proposed text exceeds 4000 characters");
  const rev = digest(proposals), state = decide(proposals.map((e) => e.id), args, rev);
  const cards = proposals.map((e) => ({ ...e, changed: e.original_text !== e.proposed_text, decision: state(e.id) }));
  return { ...envelope(rev), cards, approved_changes: cards.filter((e) => e.decision === "approved" && e.changed),
    limitations: ["No translation, spelling model, native graphics access or native caption-text mutation runs here.", "Caller revisions identify evidence only; compare original text to fresh target readback before applying any replacement."] };
}
export function reviewSync(input: unknown) {
  const args = syncReviewSchema.parse(input);
  unique(args.matches.map((m) => m.id), "matches");
  consistent(args.matches.flatMap((m) => [{ key: m.camera_source_id, revision: m.camera_revision }, { key: m.recorder_source_id, revision: m.recorder_revision }]));
  const rev = digest({ matches: args.matches, tolerance: args.agreement_tolerance_seconds, confidence: args.minimum_confidence });
  const state = decide(args.matches.map((m) => m.id), args, rev);
  const cards = args.matches.map((m) => {
    if (m.camera_source_id === m.recorder_source_id) throw new Error("Camera and recorder sources must differ");
    unique(m.estimates.map((e) => e.method), "estimate methods");
    const offsets = m.estimates.map((e) => e.offset_seconds), spread = Math.max(...offsets) - Math.min(...offsets);
    const agreement = spread <= args.agreement_tolerance_seconds + 1e-9;
    const confidence = !agreement ? "conflicting" : m.estimates.length < 2 || m.estimates.some((e) => e.confidence < args.minimum_confidence) ? "review_required" : "strong_agreement";
    if (state(m.id) === "approved" && !agreement) throw new Error("Conflicting synchronization evidence cannot be approved; resolve and preview again");
    return { ...m, evidence_status: confidence, offset_spread_seconds: Number(spread.toFixed(6)), proposed_offset_seconds: agreement ? offsets.reduce((a, b) => a + b, 0) / offsets.length : null, decision: state(m.id) };
  });
  const approved = cards.filter((c) => c.decision === "approved");
  unique(approved.map((c) => c.camera_source_id), "approved camera sources");
  return { ...envelope(rev), cards, approved_matches: approved,
    limitations: ["No timecode extraction, waveform correlation or dialogue matching runs here. Confidence is caller-supplied, not calibrated.", "Even strong agreement remains pending until selected. Constant offsets do not prove drift correction, playback sync or frame accuracy."] };
}
export function reviewBroll(input: unknown) {
  const args = brollReviewSchema.parse(input);
  unique(args.placements.map((p) => p.id), "placements");
  consistent(args.placements.flatMap((p) => [{ key: `sequence:${p.sequence_id}`, revision: p.sequence_revision }, { key: `source:${p.source_project_item_id}`, revision: p.source_revision }]));
  for (const p of args.placements) {
    positive(p.source_start_seconds, p.source_end_seconds);
    unique(p.alternative_source_ids, "alternative_source_ids");
    if (p.timeline_start_seconds + p.source_end_seconds - p.source_start_seconds > 86400) throw new Error("B-roll placement exceeds the 86400-second limit");
  }
  const rev = digest(args.placements), state = decide(args.placements.map((p) => p.id), args, rev);
  const cards = args.placements.map((p) => ({ ...p, decision: state(p.id), timeline_end_seconds: p.timeline_start_seconds + p.source_end_seconds - p.source_start_seconds, video_only: true }));
  const approved = cards.filter((p) => p.decision === "approved").sort((a, b) => a.sequence_id.localeCompare(b.sequence_id) || a.timeline_start_seconds - b.timeline_start_seconds);
  for (let i = 1; i < approved.length; i++) {
    if (approved[i].sequence_id === approved[i - 1].sequence_id && approved[i].timeline_start_seconds < approved[i - 1].timeline_end_seconds) throw new Error("Approved B-roll placements overlap; select one alternative or replan");
  }
  return { ...envelope(rev), cards, approved_placements: approved,
    limitations: ["No vision model, semantic ranking, stock search, download or timeline insertion runs here.", "Target tracks and existing occupancy are not inspected; use a fresh guarded edit-plan preview before video-only placement."] };
}
