import { describe, expect, it } from "vitest";
import { getEditorialReviewTools } from "../../src/tools/editorial-review.js";
import { reviewDialogue, reviewQuotes, reviewText, reviewSync, reviewBroll } from "../../src/ai/editorial-review.js";
import { capabilitiesForToolInvocation, guardToolHandler, isToolPermitted, resolveCapabilities } from "../../src/security/capabilities.js";

const rev = `sha256:${"a".repeat(64)}`, other = `sha256:${"b".repeat(64)}`;
const segment = { id: "quote", source_project_item_id: "camera", transcript_revision: rev, start_seconds: 0, end_seconds: 1, text: "um hello" };
const segments = [segment, { ...segment, id: "next", start_seconds: 3, end_seconds: 4, text: "next words" }];
const entry = { id: "headline", target_id: "clip", source_revision: rev, kind: "mogrt_text" as const, original_text: "Hello world" };
const match = { id: "m", camera_source_id: "camera", recorder_source_id: "recorder", camera_revision: rev, recorder_revision: rev,
  estimates: [{ method: "timecode" as const, offset_seconds: 2, confidence: 0.99 }, { method: "waveform" as const, offset_seconds: 2.02, confidence: 0.95 }] };
const placement = { id: "p", sequence_id: "seq", sequence_revision: rev, timeline_start_seconds: 1, quote: "coffee", source_project_item_id: "broll", source_revision: rev, source_start_seconds: 0, source_end_seconds: 2, reason: "Owned shot of coffee" };

const cases = [
  { name: "review_dialogue_candidates", run: reviewDialogue, input: { segments, filler_words: ["um"] }, id: () => reviewDialogue({ segments, filler_words: ["um"] }).cards[0].id },
  { name: "review_text_changes", run: reviewText, input: { entries: [entry], find_text: "Hello", replace_text: "Hi" }, id: () => "headline" },
  { name: "review_sync_evidence", run: reviewSync, input: { matches: [match] }, id: () => "m" },
  { name: "review_broll_placements", run: reviewBroll, input: { placements: [placement] }, id: () => "p" },
];

describe("local editorial review boundaries", () => {
  it.each(cases)("$name requires unchanged evidence and explicit decisions", ({ run, input, id }) => {
    const first = run(input);
    expect(first).toMatchObject({ applied: false, host_verified: false, approval_token: null });
    expect(first.cards[0].decision).toBe("pending");
    const selected = { ...input, expected_review_revision: first.review_revision, selected_ids: [id()] };
    expect(run(selected).cards[0].decision).toBe("approved");
    expect(run({ ...input, expected_review_revision: first.review_revision, rejected_ids: [id()] }).cards[0].decision).toBe("rejected");
    expect(run({ ...input, expected_review_revision: first.review_revision, selected_ids: [] }).cards[0].decision).toBe("pending");
    expect(() => run({ ...selected, expected_review_revision: other })).toThrow(/unchanged/);
    expect(() => run({ ...input, selected_ids: [id()] })).toThrow(/unchanged/);
    expect(() => run({ ...selected, selected_ids: ["missing"] })).toThrow(/unknown/);
    expect(() => run({ ...selected, selected_ids: [id(), id()] })).toThrow(/duplicate/);
    expect(() => run({ ...selected, rejected_ids: [id(), id()] })).toThrow(/duplicate/);
    expect(() => run({ ...selected, rejected_ids: [id()] })).toThrow(/both/);
    expect(() => run({ ...input, expected_review_revision: other })).toThrow(/changed/);
    expect(() => run({ ...input, surprise: true })).toThrow();
  });
  it.each([...cases.map(({ name, input }) => [name, input] as const), ["review_quote_paper_edit", { segments }] as const])("%s is inspect-only and exposes strict bounded schemas", async (name, input) => {
    const tool = getEditorialReviewTools()[name as keyof ReturnType<typeof getEditorialReviewTools>];
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(capabilitiesForToolInvocation(name, input)).toEqual(["inspect"]);
    expect(isToolPermitted(name, resolveCapabilities("inspect"))).toBe(true);
    expect(isToolPermitted(name, resolveCapabilities("edit"))).toBe(false);
    expect((await guardToolHandler(name, tool.handler, resolveCapabilities("inspect"))(input)).success).toBe(true);
    await expect(guardToolHandler(name, tool.handler, resolveCapabilities("edit"))(input)).rejects.toThrow(/inspect/);
    expect((await tool.handler({})).success).toBe(false);
    expect((await tool.handler(null)).success).toBe(false);
  });
  it("bounds raw handler input and normalizes non-Error serialization failures", async () => {
    const handler = getEditorialReviewTools().review_text_changes.handler;
    expect(await handler({ data: "a".repeat(5 * 1024 * 1024) })).toMatchObject({ success: false, error: "Review input exceeds 5 MiB" });
    expect((await handler(undefined)).success).toBe(false);
    expect(await handler({ toJSON() { throw "serialization failed"; } })).toEqual({ success: false, error: "serialization failed" });
  });
});

describe("dialogue review", () => {
  const input = { segments, filler_words: ["um"], silence_ranges: [{ source_project_item_id: "camera", start_seconds: 1, end_seconds: 3 }] };
  it("retains context and padding, with source-time union instead of summed overlaps", () => {
    const first = reviewDialogue(input);
    expect(first.cards[0].context).toEqual({ before: "", passage: "um hello", after: "next words" });
    expect(first.cards[1].context).toEqual({ before: "um hello", passage: "", after: "next words" });
    const approved = reviewDialogue({ ...input, expected_review_revision: first.review_revision, selected_ids: first.cards.map((c) => c.id) });
    expect(approved.approved_source_cut_ranges[1]).toEqual({ source_project_item_id: "camera", start_seconds: 1.1, end_seconds: 2.9 });
    expect(approved.projected_removed_source_seconds).toBe(2.8);
    expect(approved.pending_count).toBe(0);
    expect(reviewDialogue({ ...input, rejected_ids: [], expected_review_revision: first.review_revision }).projected_removed_source_seconds).toBe(0);
  });
  it("unions overlapping source cuts and preserves separate source clocks", () => {
    const data = { segments: [segment, { ...segment, id: "second", source_project_item_id: "other" }], filler_words: ["um"], padding_seconds: 0,
      silence_ranges: [{ source_project_item_id: "camera", start_seconds: 0.5, end_seconds: 2 }] };
    const first = reviewDialogue(data);
    const result = reviewDialogue({ ...data, expected_review_revision: first.review_revision, selected_ids: first.cards.map((c) => c.id) });
    expect(result.projected_removed_source_seconds).toBe(3);
  });
  it("does not approve silence fully consumed by padding", () => {
    const data = { ...input, padding_seconds: 2 }, first = reviewDialogue(data);
    expect(first.cards[1].removable_range).toBeNull();
    expect(() => reviewDialogue({ ...data, selected_ids: [first.cards[1].id], expected_review_revision: first.review_revision })).toThrow(/padding/);
  });
  it("invalidates changed padding, text, revisions and ranges", () => {
    const first = reviewDialogue(input), selected = { ...input, selected_ids: [first.cards[0].id], expected_review_revision: first.review_revision };
    expect(() => reviewDialogue({ ...selected, padding_seconds: 0.2 })).toThrow(/unchanged/);
    expect(() => reviewDialogue({ ...selected, segments: [{ ...segment, text: "um changed" }] })).toThrow(/unchanged/);
    expect(() => reviewDialogue({ ...selected, segments: [{ ...segment, transcript_revision: other }] })).toThrow(/unchanged/);
    expect(() => reviewDialogue({ ...input, silence_ranges: [{ source_project_item_id: "unknown", start_seconds: 1, end_seconds: 2 }] })).toThrow(/unknown/);
    expect(() => reviewDialogue({ segments: [segment, { ...segment, id: "second", transcript_revision: other }] })).toThrow(/Conflicting/);
  });
  it("bounds passage context even when many transcript segments overlap", () => {
    const overlapping = [segment, { ...segment, id: "second", text: "x".repeat(1000) }];
    const result = reviewDialogue({ segments: overlapping, filler_words: ["um"] });
    expect(result.cards[0].context.passage).toHaveLength(1000);
    expect(result.cards[0].context_truncated).toBe(true);
    expect(() => reviewDialogue({ segments: [{ ...segment, end_seconds: 0.0000001 }] })).toThrow(/positive/);
  });
  it("refuses candidate truncation", () => {
    const many = Array.from({ length: 520 }, (_, i) => ({ ...segment, id: String(i), start_seconds: i, end_seconds: i + 1 }));
    expect(() => reviewDialogue({ segments: many, filler_words: ["um"] })).toThrow(/truncated/);
  });
});

describe("quote paper edit", () => {
  it("requires explicit ordering and returns durations in selected order", () => {
    const first = reviewQuotes({ segments });
    expect(first.rows).toEqual([]);
    expect(first.csv.split("\r\n")).toHaveLength(2);
    const result = reviewQuotes({ segments, quote_order: ["next", "quote"], expected_review_revision: first.review_revision });
    expect(result.rows.map((s) => s.id)).toEqual(["next", "quote"]);
    expect(result.rows.map((s) => s.output_start_seconds)).toEqual([0, 1]);
    expect(result.output_duration_seconds).toBe(2);
    expect(() => reviewQuotes({ segments, quote_order: ["quote"] })).toThrow(/unchanged/);
    expect(() => reviewQuotes({ segments, quote_order: ["quote", "quote"], expected_review_revision: first.review_revision })).toThrow(/duplicate/);
    expect(() => reviewQuotes({ segments, quote_order: ["absent"], expected_review_revision: first.review_revision })).toThrow(/unknown/);
  });
  it.each(["=HYPERLINK(\"x\")", " +SUM(1,2)", "\t@cmd", "-3", "'ordinary'\nsecond line"])('escapes spreadsheet text %s', (text) => {
    const evidence = [{ ...segment, text, speaker_label: "=speaker" }], first = reviewQuotes({ segments: evidence });
    const csv = reviewQuotes({ segments: evidence, quote_order: ["quote"], expected_review_revision: first.review_revision }).csv;
    expect(csv).toContain('"\'=speaker"');
    expect(csv).toContain(`"${(/^[\s]*[=+@-]/u.test(text) ? "'" : "") + text.replaceAll('"', '""')}"`);
  });
  it("preserves multi-source quote identity and refuses mixed revisions", () => {
    const evidence = [segment, { ...segment, id: "second", source_project_item_id: "other", transcript_revision: other }];
    expect(reviewQuotes({ segments: evidence }).library).toHaveLength(2);
    expect(() => reviewQuotes({ segments: [segment, { ...segment, id: "second", transcript_revision: other }] })).toThrow(/Conflicting/);
  });
});

describe("batch copy review", () => {
  it("uses literal replacement and original text without executing regex or replacement tokens", () => {
    const data = { entries: [{ ...entry, original_text: "a.b a.b" }], find_text: "a.b", replace_text: "$&" }, first = reviewText(data);
    expect(first.cards[0].proposed_text).toBe("$& $&");
    expect(first.approved_changes).toEqual([]);
    expect(reviewText({ ...data, selected_ids: ["headline"], expected_review_revision: first.review_revision }).approved_changes[0].original_text).toBe("a.b a.b");
    expect(reviewText({ entries: [{ ...entry, proposed_text: "" }] }).cards[0].proposed_text).toBe("");
    expect(reviewText({ entries: [entry] }).cards[0].changed).toBe(false);
    const unchanged = reviewText({ entries: [entry] });
    expect(reviewText({ entries: [entry], selected_ids: ["headline"], expected_review_revision: unchanged.review_revision }).approved_changes).toEqual([]);
  });
  it("rejects incomplete replacements, duplicate IDs, stale evidence and output expansion", () => {
    expect(() => reviewText({ entries: [entry], find_text: "x" })).toThrow(/together/);
    expect(() => reviewText({ entries: [entry], replace_text: "x" })).toThrow(/together/);
    expect(() => reviewText({ entries: [entry, entry] })).toThrow(/duplicate/);
    expect(() => reviewText({ entries: [entry, { ...entry, id: "second", source_revision: other }] })).toThrow(/Conflicting/);
    expect(() => reviewText({ entries: [{ ...entry, original_text: "x".repeat(4000) }], find_text: "x", replace_text: "yy" })).toThrow(/4000/);
    const first = reviewText({ entries: [entry] });
    expect(() => reviewText({ entries: [{ ...entry, original_text: "changed" }], selected_ids: [entry.id], expected_review_revision: first.review_revision })).toThrow(/unchanged/);
  });
});

describe("sync evidence", () => {
  it("labels agreement without automatically approving and handles weak or conflicting evidence", () => {
    const first = reviewSync({ matches: [match] });
    expect(first.cards[0]).toMatchObject({ evidence_status: "strong_agreement", decision: "pending", offset_spread_seconds: 0.02 });
    expect(first.approved_matches).toEqual([]);
    expect(reviewSync({ matches: [{ ...match, estimates: [match.estimates[0]] }] }).cards[0].evidence_status).toBe("review_required");
    expect(reviewSync({ matches: [match], minimum_confidence: 1 }).cards[0].evidence_status).toBe("review_required");
    const conflicts = { matches: [{ ...match, estimates: [match.estimates[0], { ...match.estimates[1], offset_seconds: 9 }] }] };
    const conflict = reviewSync(conflicts);
    expect(conflict.cards[0]).toMatchObject({ evidence_status: "conflicting", proposed_offset_seconds: null });
    expect(() => reviewSync({ ...conflicts, selected_ids: ["m"], expected_review_revision: conflict.review_revision })).toThrow(/cannot be approved/);
  });
  it("rejects duplicate methods, identical sources and two approved alternatives for one camera", () => {
    expect(() => reviewSync({ matches: [{ ...match, estimates: [match.estimates[0], match.estimates[0]] }] })).toThrow(/duplicate/);
    expect(() => reviewSync({ matches: [{ ...match, recorder_source_id: "camera" }] })).toThrow(/must differ/);
    expect(() => reviewSync({ matches: [match, match] })).toThrow(/duplicate/);
    const alternatives = { matches: [match, { ...match, id: "alt", recorder_source_id: "recorder2" }] }, first = reviewSync(alternatives);
    expect(() => reviewSync({ ...alternatives, selected_ids: ["m", "alt"], expected_review_revision: first.review_revision })).toThrow(/approved camera/);
    expect(reviewSync({ ...alternatives, selected_ids: ["alt"], rejected_ids: ["m"], expected_review_revision: first.review_revision }).approved_matches).toHaveLength(1);
    expect(() => reviewSync({ matches: [match, { ...match, id: "alt", camera_revision: other }] })).toThrow(/Conflicting/);
  });
});

describe("B-roll evidence", () => {
  it("shows alternatives and refuses overlapping approved placements", () => {
    const data = { placements: [placement, { ...placement, id: "alt", timeline_start_seconds: 2, alternative_source_ids: ["another"] }] }, first = reviewBroll(data);
    expect(first.cards[1].alternative_source_ids).toEqual(["another"]);
    expect(first.cards[0]).toMatchObject({ video_only: true, timeline_end_seconds: 3, decision: "pending" });
    expect(() => reviewBroll({ ...data, selected_ids: ["p", "alt"], expected_review_revision: first.review_revision })).toThrow(/overlap/);
    expect(reviewBroll({ ...data, selected_ids: ["alt"], expected_review_revision: first.review_revision }).approved_placements).toHaveLength(1);
  });
  it("allows adjoining placements and separate sequence clocks", () => {
    const data = { placements: [placement, { ...placement, id: "next", timeline_start_seconds: 3 }, { ...placement, id: "other", sequence_id: "seq2" }] }, first = reviewBroll(data);
    expect(reviewBroll({ ...data, selected_ids: ["p", "next", "other"], expected_review_revision: first.review_revision }).approved_placements).toHaveLength(3);
  });
  it("rejects invalid ranges, duplicates, stale sequence revisions and placements past the bound", () => {
    expect(() => reviewBroll({ placements: [{ ...placement, source_end_seconds: 0 }] })).toThrow(/positive/);
    expect(() => reviewBroll({ placements: [placement, placement] })).toThrow(/duplicate/);
    expect(() => reviewBroll({ placements: [{ ...placement, alternative_source_ids: ["x", "x"] }] })).toThrow(/duplicate/);
    expect(() => reviewBroll({ placements: [{ ...placement, timeline_start_seconds: 86400 }] })).toThrow(/limit/);
    expect(() => reviewBroll({ placements: [placement, { ...placement, id: "other", sequence_revision: other }] })).toThrow(/Conflicting/);
    const first = reviewBroll({ placements: [placement] });
    expect(() => reviewBroll({ placements: [{ ...placement, reason: "Changed intent" }], selected_ids: ["p"], expected_review_revision: first.review_revision })).toThrow(/unchanged/);
  });
});
