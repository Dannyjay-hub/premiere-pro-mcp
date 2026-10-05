# Reviewed assistant editing

Five local tools turn captured editorial evidence into review cards or an inline
paper edit. They perform no file I/O, provider calls, transcription, translation,
vision inference, audio matching, or Premiere mutation. The tools require only
`inspect` authority and are included in the `assistant-edit` pack.

## Review contract

1. Inspect the relevant project, source transcript, MOGRT controls, or sequence.
   Keep exact IDs and captured revisions. Text revisions and sync evidence are
   caller-supplied snapshot references, not proof of fresh host state.
2. Call the review tool without decisions. All cards start pending. Review the
   original text, ranges, reasons, conflicts and alternatives in the MCP client.
3. Submit the same evidence and options with `expected_review_revision` equal to
   the returned `review_revision`. Supply `selected_ids` and/or `rejected_ids`;
   quotes instead use `quote_order` in the desired output order. Empty selections
   approve nothing. Unknown, duplicate, conflicting or stale decisions fail.
4. Re-inspect the host before any later change. Review revisions are **not host
   apply tokens**. Use an existing guarded host preview, its own confirmation and
   fresh readback. These local tools cannot verify live transcript freshness,
   current track occupancy, source media handles, playback, rendered appearance,
   persistence or Undo.

Inputs are closed-schema, bounded by entry counts and a 5 MiB handler limit.
Text and evidence appear in returned results but are never persisted, logged or
uploaded by these tools. The calling MCP client controls its own retention and
provider handling.

## Tools

| Tool | Inputs and output | Important boundary |
| --- | --- | --- |
| `review_dialogue_candidates` | Normalized transcript segments, optional silence ranges/filler words, minimum silence duration, padding; returns context cards, decisions and approved source cut ranges | Padding retains speech at silence edges only. Filler cuts cover whole supplied segments. Removal duration unions overlaps per source; it is not a projected timeline duration. Truncated candidate sets are refused. |
| `review_quote_paper_edit` | Transcript quote library and explicit `quote_order`; returns ordered rows, source revisions, running output timings and inline CSV | No quote is approved by default. CSV is RFC-style quoted and cells beginning with formula triggers after whitespace are prefixed with an apostrophe. File writing and multi-source timeline construction remain separate. |
| `review_text_changes` | Inspected MOGRT text or supplied caption-artifact entries with original text/revisions; literal find/replace or proposed text; returns copy differences and approved changes | Literal case-sensitive replacement only; no regex or model. Native graphics and native caption text are unsupported. Compare original text with fresh target readback before any later write. |
| `review_sync_evidence` | Camera/recorder identities and captured revisions plus independent timecode, waveform or dialogue offset estimates | Caller supplies analysis and confidence. Two agreeing high-confidence methods receive `strong_agreement`, but still remain pending. Conflicting estimates cannot be approved. Multiple approved alternatives for one camera are refused. |
| `review_broll_placements` | Supplied owned-footage picks, source/sequence revisions, quote, reason, source range, destination time and alternative sources | No inferred match, media search, download, thumbnail capture or insertion. Overlapping approved placements within a sequence are refused; track occupancy must be checked separately. |

Sync offset convention: `recorder source time = camera source time + offset`.
Agreement compares the maximum estimate spread against the tolerance (default
0.04 seconds). Confidence is caller-supplied, not a calibrated probability. A
single agreeing estimate or low-confidence method is `review_required`; an
explicit review can select it. Constant-offset agreement does not measure drift.

## Example: quote paper edit

First review a captured library:

```json
{
  "segments": [{
    "id": "quote-1",
    "source_project_item_id": "source-1",
    "transcript_revision": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "start_seconds": 12,
    "end_seconds": 18,
    "text": "This is the first approved idea."
  }]
}
```

The first result has an empty `rows` array and a header-only `csv`. Copy its
`review_revision`, then submit the unchanged segments with:

```json
{
  "quote_order": ["quote-1"],
  "expected_review_revision": "<exact returned review_revision>"
}
```

The second result returns six seconds of ordered source evidence, not a created
sequence. Save `csv` through a separately authorized file operation if requested.
Do not interpret CSV presentation escaping as a change to the original quote.

## Guided recipes and host handoff

- `talking-head-cleanup` and `podcast-first-cut` now include dialogue review before
  the existing `preview_derived_dialogue_sequence_uxp` route. Construct reviewed
  keep ranges separately; the review tool returns source cut ranges and does not
  infer source-to-sequence mapping or automatically supply a derivative plan.
- `quote-paper-edit`, `batch-copy-review`, `sync-match-review` and
  `broll-pick-review` are review-only recipes. Recipe readiness describes the
  presence of named inputs; it is not approval or permission to run a mutation.
- B-roll handoff uses `preview_edit_plan` only after inspecting target tracks and
  mapping approved picks to supported plan operations. An unchanged review is
  not evidence that a track is empty.
- Existing podcast derivative assembly requires reviewed master-audio ranges and
  transcript bindings. An offset estimate does not supply or verify them.

The tools and this documentation are independently implemented from public
workflow research. No Filmit code, presets, plugin binaries or assets are included.
Package tests verify local review behavior; live Premiere support and mutations
retain the boundaries of their existing CEP/UXP tools.
