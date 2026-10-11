# Filmcraft-inspired improvements: implementation and evidence

This is the complete 52-item ledger for the Filmcraft source review at
[`4e2d0bc2d3646f9cf27ef7aa8b2095c6858c7efe`](https://github.com/storytold/filmcraft/tree/4e2d0bc2d3646f9cf27ef7aa8b2095c6858c7efe).
The implementation started from current `origin/main` (`3b433ad`), which already
contained newer workflows than the original review snapshot. Changes are original
TypeScript/ES3/CJS adapters and contracts around the existing MCP, not imported
Filmcraft codecs, renderer, UI or project internals.

## Evidence boundary

There are 41 new core tools and five guided workflow routes. Development source
now declares 434 core tools, 432 under default authority and 528 with the 96 UXP
additions. Package version and published v1.22.0 artifact counts are unchanged;
this ledger is source-checkout evidence, not a publication receipt.

Package implementations are bounded deliberately. Pure models predict supported
subsets, unknown native fields remain unknown, and undocumented or unmeasured
Adobe operations refuse. Native multicam switching, nonlinear/nested retime
mapping, DSP music rendering, OCR and accepted-native-job cancellation are not
advertised as working operations. These limits are recorded per item below.

**Licensed Premiere validation has not run.** No Premiere application is installed
on the implementation machine. Unit/VM/fault tests prove contracts; the actual
FFmpeg dissolve/excerpt tests prove local decoder/artifact behavior. Neither is a
Premiere playback, Undo, reopen, host compatibility or native round-trip claim.
The checked-in host matrix therefore keeps every host case `not_run`.

## Complete implementation map

| ID | Change | Main implementation | Contract and remaining boundary |
| --- | --- | --- | --- |
| 01 | Bound replay identity | [`uxp-plugin/operation-ledger.cjs`](../uxp-plugin/operation-ledger.cjs) | Changed arguments, project, sequence or session conflict; bounded hashed reservations. |
| 02 | Consumed unknown receipts | [`uxp-plugin/operation-ledger.cjs`](../uxp-plugin/operation-ledger.cjs) | Durable hashed tombstones survive panel reload; unexpected post-dispatch errors are never retry permission. Capacity is 4,096 IDs / 1 MiB; full, corrupt or unwritable storage refuses new writes. Reviewed acknowledgement does not erase consumed IDs. |
| 03 | Explicit MCP hints | [`src/workflows/tool-metadata.ts`](../src/workflows/tool-metadata.ts) | Definition annotations win; mixed actions remain conservative and authority is independently enforced. |
| 04 | Exact invocation preflight | [`src/tools/execution-workflows.ts`](../src/tools/execution-workflows.ts) | can_execute validates schema, authority, files and bounded CEP targets; unavailable UXP action predicates remain unknown. |
| 05 | Common mutation receipts | [`src/workflows/mutation-receipt.ts`](../src/workflows/mutation-receipt.ts) | Versioned dispatch/outcome/boundary/partial-step/output evidence; existing detailed handler outcomes preserved. |
| 06 | Cooperating host ownership | [`src/bridge/host-lease.ts`](../src/bridge/host-lease.ts) | Cross-process lease spans protected workflows for shared private bridge directory. Premiere UI and unrelated extensions are outside the lease. |
| 07 | Expected host targets | [`src/bridge/project-guard.ts`](../src/bridge/project-guard.ts) | expected_cep_target guards project document, sequence, source, clip exact ticks and effect parameter before generated body; no UXP fallback. |
| 08 | Reviewed recovery gate | [`src/tools/operation-recovery.ts`](../src/tools/operation-recovery.ts) | Unknown outcomes block dependent writes until exact latest ledger/host revision is reviewed and acknowledged. Consumed IDs remain consumed. |
| 09 | Schema/receipt negotiation | [`uxp-plugin/protocol.cjs`](../uxp-plugin/protocol.cjs) | UXP writes require matching command schema/receipt versions and durable hashed tombstone storage; older unversioned panels allow reads only. CEP heartbeat/doctor reports its independent compatibility boundary, including legacy transport. Host API support is probed separately. |
| 10 | Strict nested validation | [`src/workflows/strict-schema.ts`](../src/workflows/strict-schema.ts) | Named unknown-field and nonfinite/depth/breadth errors; intentionally open metadata maps preserved. Existing typed cross-field validation retained. |
| 11 | Lossless tick contract | [`src/ai/exact-time.ts`](../src/ai/exact-time.ts) | BigInt decimal ticks stay lossless in canonical planning; legacy convenience seconds are accepted only when safe for selected workflows. |
| 12 | Rational rates/timecode | [`src/ai/exact-time.ts`](../src/ai/exact-time.ts) | Signed frame/sample/time conversion, exclusive ends and 29.97/59.94 drop-frame minute rules; host code remains ES3. |
| 13 | Canonical snapshots | [`src/ai/timeline-contract.ts`](../src/ai/timeline-contract.ts) | Version, session/project/sequence, exact ranges, descriptors, completeness and revision. Missing CEP links/locks/effects/transitions/markers remain unknown. |
| 14 | Expected-edit algebra | [`src/ai/timeline-contract.ts`](../src/ai/timeline-contract.ts) | Pure insert/overwrite/trim/split/move/remove/ripple/enable subset predicts exact diffs; synthetic additions never authorize host mutation. |
| 15 | Extended typed compound plans | [`src/tools/extended-edit-plans.ts`](../src/tools/extended-edit-plans.ts) | Single-use previews compose supported trim/split/move/enable/effect/keyframe handlers with exact target guards; sequential partial work is explicit. |
| 16 | Source/neighbor constraints | [`src/ai/timeline-contract.ts`](../src/ai/timeline-contract.ts) | Shared source-handle/neighbor preflight in the canonical model and compound routes complements existing physical-duration checks in legacy trim/slide/slip tools. Unknown mappings refuse. |
| 17 | Explicit ripple scope | [`src/ai/timeline-contract.ts`](../src/ai/timeline-contract.ts) | Model names every participating track/clip and requires known locks/sync state. Existing native ripple route remains separately guarded. |
| 18 | A/V continuity verification | [`src/ai/timeline-contract.ts`](../src/ai/timeline-contract.ts) | Exact links/source/ranges/speed/reverse/nesting and unaffected-neighbor comparison; structural proof does not establish audible synchronization. |
| 19 | Effect descriptor identity | [`src/ai/timeline-contract.ts`](../src/ai/timeline-contract.ts) | Stable match and exact indexed parameter identity, type/units/writability/animation evidence. Compound writes refuse built-ins and unknown descriptors. |
| 20 | Keyframe timing domains | [`src/ai/timeline-contract.ts`](../src/ai/timeline-contract.ts) | Explicit source/relative/sequence tick mappings for supported forward 1x clips. Nonlinear retiming/nesting refuse without a measured adapter. |
| 21 | Progress and job status | [`src/workflows/invocation-context.ts`](../src/workflows/invocation-context.ts) | Bounded MCP progress, local/native job observation and exact tracked-receipt identity. Missing receipts never mean completion. |
| 22 | Owned local cancellation | [`src/workflows/job-contract.ts`](../src/workflows/job-contract.ts) | Undispatched jobs and local subprocesses use AbortSignal; stopped waits never claim accepted native work was cancelled. |
| 23 | Export lineage receipts | [`uxp-plugin/events.cjs`](../uxp-plugin/events.cjs) | Exact bounded project/sequence/item/range/preset/destination lineage is SHA-256 bound in Node. Pinned EncoderManager returns Boolean; generic terminal events normalize to unknown/reconciliation-required, with no completion claim. nativeJobId is absent unless actually supplied. |
| 24 | Guarded delivery orchestration | [`src/tools/execution-workflows.ts`](../src/tools/execution-workflows.ts) | Saved exact CEP project/sequence guard, new output, validated preset/contract, direct render, checksum/conformance and optional decoded QC. Visual rendering remains a separate check. |
| 25 | Decoded temporal harness | [`src/tools/temporal-render-evidence.ts`](../src/tools/temporal-render-evidence.ts) | Actual multi-frame video decoding, sampled RGB/ROI and optional decoded PCM RMS against a measured oracle. A generated dissolve passes and wrong expectations fail. |
| 26 | Checked capture restoration | [`src/bridge/script-builder.ts`](../src/bridge/script-builder.ts) | Temporary-mark ownership and restore readback propagate recovery-required uncertainty; concurrent UI changes are not overwritten silently. |
| 27 | Owned image evidence | [`src/tools/export.ts`](../src/tools/export.ts) | UUID capture paths, exact target/time evidence/method/resolution, PNG header and stable regular-file checks; no arbitrary panel path read/unlink. |
| 28 | Before/after review artifacts | [`src/tools/execution-workflows.ts`](../src/tools/execution-workflows.ts) | Bounded contact sheets plus optional create-only <=30-second MP4 excerpts, hashes and decoded frame counts. Comparison remains human/explicit-oracle work. |
| 29 | Rendered output scopes | [`src/tools/execution-workflows.ts`](../src/tools/execution-workflows.ts) | Actual local output RGB sampling and ffprobe encoded color metadata, caller declarations kept separate. RGB proxy does not establish HDR/legal-range correctness. |
| 30 | Content/revision analysis cache | [`src/workflows/analysis-cache.ts`](../src/workflows/analysis-cache.ts) | Opt-in six allowlisted read analyses keyed by canonical source identity, content hash, options, revision and tool version; bounded LRU, concurrent insertion accounting, source stability checks and clone isolation. |
| 31 | Synchronization proposal | [`src/ai/editorial-workflows.ts`](../src/ai/editorial-workflows.ts) | Bounded PCM correlation or measured timecode/marker anchors return confidence and ambiguous alternatives; never automatically shifts native media. |
| 32 | Stacked camera executor | [`src/tools/timeline-editorial.ts`](../src/tools/timeline-editorial.ts) | Reviewed ordinary pre-razored tracks are cloned, video enabled states checked, master-audio structural ranges preserved. Native multicam switching is unsupported. |
| 33 | Transcript readiness composition | [`src/tools/timeline-editorial.ts`](../src/tools/timeline-editorial.ts) | Existing native has/start/readiness/segment routes, persistent start claims and revision-bound evidence; uncertain starts are never blindly resent. |
| 34 | Repeated word placement | [`src/ai/editorial-workflows.ts`](../src/ai/editorial-workflows.ts) | Distinct occurrence IDs across repeated forward 1x placements with exact ticks; nested/nonlinear retime mappings remain unsupported. |
| 35 | Caption render evidence contract | [`src/ai/editorial-workflows.ts`](../src/ai/editorial-workflows.ts) | Checks caller-measured rendered bounds, glyphs, line breaks, bidi and safe zones with SHA-256 provenance. No OCR or unmeasured visual success claim. |
| 36 | Deterministic music remix plan | [`src/ai/editorial-workflows.ts`](../src/ai/editorial-workflows.ts) | Measured beat-grid shortening, protected intro/outro and explicit proposed joins/crossfades. No DSP renderer or native Adobe Remix API claim. |
| 37 | Reviewed scene application | [`src/tools/scene-review-workflow.ts`](../src/tools/scene-review-workflow.ts) | Approved candidates, exact saved project/source and physical bounds; actual source markers/subclips/bin composition. Audio inclusion requested, decoded audio preservation remains unverified. |
| 38 | Source/proxy provenance | [`src/ai/editorial-workflows.ts`](../src/ai/editorial-workflows.ts) | Content/revision/provider identity travels in bounded planning evidence; delivery cannot assume proxy evidence represents the original. |
| 39 | Project handoff manifest | [`src/tools/timeline-editorial.ts`](../src/tools/timeline-editorial.ts) | Expected/observed dependencies and contained-file byte inventory, missing/unresolved/truncated states. Completeness needs explicit project dependency evidence. |
| 40 | Persistent workflow checkpoints | [`src/tools/timeline-editorial.ts`](../src/tools/timeline-editorial.ts) | Private bounded versioned receipt/state references survive restart; inspection never restores or replays uncertain host edits. |
| 41 | Honest native OTIO capability | [`src/platform-capabilities.ts`](../src/platform-capabilities.ts) | Documented UXP OTIO and XML probes are independent; Boolean export acceptance is committed_unverified. Optional fresh bounded artifact readback needs filesystem authority. |
| 42 | Bounded offline OTIO | [`src/interchange/otio.ts`](../src/interchange/otio.ts) | Exact rational-time inspection and supported snapshot conversion. Effects/nests/metadata/schema loss is refused or explicitly reported; no prproj parser. |
| 43 | Feature-level loss reports | [`src/interchange/evidence.ts`](../src/interchange/evidence.ts) | OTIO, FCP7 xmeml, modern FCPXML, EDL, AAF and OMF support/loss/unknown matrix; opaque native formats remain unknown. |
| 44 | Canonical interchange fixtures | [`tests/tools/interchange-workflows.test.ts`](../tests/tools/interchange-workflows.test.ts) | Retained seeded rational-rate parse/serialize/parse fixtures and exact supported snapshot projection; destination-editor/native fidelity remains a host gate. |
| 45 | Audio-post turnover contract | [`src/interchange/facility.ts`](../src/interchange/facility.ts) | Existing AAF/OMF native routes with explicit handles/range/channel/rate/gain/media/reference-picture plan and post-export checks. No new opaque serializer. |
| 46 | Spreadsheet-safe review markers | [`src/interchange/facility.ts`](../src/interchange/facility.ts) | Create-only bounded CSV/JSON with IDs/comments/colors/rational rate/exact ticks/drop-frame display and escaped multiline/formula text. |
| 47 | Facility metadata adapter | [`src/interchange/facility.ts`](../src/interchange/facility.ts) | Bounded ALE intake/export reports duplicates/missing sources/unsupported fields; proposals route separately through existing named-field metadata readback. |
| 48 | Retained property seeds | [`tests/ai/expected-edit-properties.test.ts`](../tests/ai/expected-edit-properties.test.ts) | Retained seeds cover 480 individual edits and 240 eight-operation sequences, plus exact-time properties across rational rates. Unsupported mappings/refusals and collateral-state checks are explicit. |
| 49 | Licensed-host fixture matrix | [`docs/temporal-render-fixtures.matrix.json`](../docs/temporal-render-fixtures.matrix.json) | Repeatable host reports require pinned environment/capabilities and hashed before/after, Undo/reopen, playback and export evidence. All licensed-host cells remain not_run. |
| 50 | Transport fault injection | [`tests/bridge/uxp-execution-faults.test.ts`](../tests/bridge/uxp-execution-faults.test.ts) | Disconnects/late/wrong/duplicate replies, changed arguments, panel reload, cache expiry, recovery and independent-process concurrency are covered without resend. |
| 51 | Dependency boundary gate | [`scripts/check-dependency-boundaries.mjs`](../scripts/check-dependency-boundaries.mjs) | npm run check:layers gates pure planning/security dependencies; two existing parser reuse edges are explicit exceptions, not blanket permissions. |
| 52 | Bounded performance evidence | [`src/workflows/performance-diagnostics.ts`](../src/workflows/performance-diagnostics.ts) | Content-free bounded numeric stage medians/p95/payload/cache counts plus generated 100/1,000/10,000-clip benchmark. Unmeasured stages remain null; no host latency claim. |

## Use the new workflow routes

Discover schemas with `get_capabilities` and preflight exact arguments using
`can_execute`. Use the canonical snapshot/time tools for supported predictions,
then unchanged single-use previews for extended, scene and stacked-camera
application. Inspect per-step receipts after any failure; unknown outcomes
require reviewed recovery rather than replay.

Install the matching UXP panel before editing. Missing command/receipt versions
leave an older panel read-only; unavailable durable ledger storage refuses writes.
Ledger storage is bounded and consumed IDs are retained. Reconnecting or
acknowledging recovery does not reset that storage or authorize an ID replay.
Recovery snapshots inspect bounded active-sequence clip identities/ranges;
effects, source media and other project state still need actual reconciliation.

Use `export_and_verify` with a saved project, explicit preset, new destination
and delivery contract. Generic encoder events are observations. Artifact hashing,
ffprobe conformance, decoded QC, measured temporal oracles, caption measurements
and human image/playback review establish distinct evidence scopes.

For interchange, inspect actual bounded files and loss reports first. Review ALE
proposals before separately calling named-field metadata tools; do not replace
metadata packets or disclose sensitive fields to apply a facility table.

## Repeatable verification

- `npm run check` includes lint, dependency boundaries, inventories, build,
  catalogs, manifest/branding/registry checks and unit tests.
- `npm run test:coverage` retains existing thresholds; no coverage exclusions or
  reduced thresholds were introduced for these additions.
- `npm run benchmark:planning` emits numeric local 100/1,000/10,000-clip results.
- `npm run fixture:temporal -- <new-directory>` creates an actual local dissolve
  fixture and measured oracle. This is not a native Premiere render.
- `npm run prepare:temporal-host-report` and
  `npm run validate:temporal-host-report -- <report.json>` support the independent
  licensed-host matrix in [temporal-render-fixtures.md](temporal-render-fixtures.md).

On the implementation Mac (Node 24.21.0, arm64), seven generated validate/predict
runs measured medians of 2.88 / 17.56 / 163.01 ms for 100 / 1,000 / 10,000 clips,
with bounded input sizes 32,843 / 326,950 / 3,304,018 bytes. Tail measurements
were 22.24 / 89.64 / 452.98 ms. These are a local planning baseline, not a
cross-machine regression limit or Premiere benchmark.
