# Repeatable temporal and interchange evidence

`verify_temporal_render_artifact` decodes a short actual video at multiple times,
checks expected RGB means, optionally decodes audio RMS windows, and hashes the
artifact. A stored property value, still image, QE render, or queued job cannot
pass this temporal gate. Whole-frame RGB means suit generated color fixtures;
explicit pixel regions can measure generated motion/effect oracles at several
positions/times. These bounded means cannot establish glyph correctness, HDR
legal ranges, or complete visual fidelity. Use a fuller image oracle for those
fixtures.

Generate a disposable local source and harness expectation:

```sh
node scripts/create-temporal-render-fixture.mjs /absolute/new/fixture-directory
```

This source is generated with local ffmpeg, not Premiere. The local artifact can
exercise the decoder/validator but is never evidence of Premiere compatibility.
Use its hashes and measured expectations to build a disposable licensed-host
project, export the exact requested range, then run the validator on that export.
Keep original fixture hashes and export hashes separate. Never use a personal
project or enable unsafe scripting to obtain test evidence.

The matrix in `temporal-render-fixtures.matrix.json` contains effects,
transitions, interpolation, speed, slip/slide, duplication, native interchange,
and DAW turnover cases. Every checked-in cell is `not_run`. Generate one report
per host/build/locale/backend/capability set:

```sh
node scripts/create-temporal-host-report.mjs provenance.json new-report.json
```

Provenance requires `premiereBuild`, `os`, `locale`, `backend`, `panelSha256`,
`serverCommit`, `clientVersion`, `fixtureSha256`, and bounded `capabilityIds`.
Reports use opaque evidence IDs and hashes; private projects, media paths,
screen content, and MCP payload dumps stay in local diagnostics outside commits.
Record `passed`, `failed`, `unsupported`, and `not_run` separately. Validate
recorded cells with `validate-temporal-host-report.mjs` before using them.
Validation takes the report path and optional explicitly approved local evidence
directory. Each evidence entry has an opaque `ref`, allowed `kind`, and the
SHA-256 of `ref.json` inside that directory. Temporal entries contain actual
validator receipts. Manual/native checks contain `kind`, `fixtureSha256`,
boolean `checked`, and `provenanceBinding` (SHA-256 of compact JSON provenance
with its top-level keys sorted alphabetically). Passed temporal receipts must
match all pinned host fields. The validator verifies bytes and links; host
identity and manual observations remain operator attestations.

For each mutation, record exact before/after state, verify intended linked-source
continuity, perform Undo and verify restoration, save/reopen the fixture and
verify state, and observe playback. Export an actual video and measure times on
both sides of edits and at transition/interpolation midpoints. Keep destination
import evidence separate from native interchange export and offline parser
round trips. Only cells with every required measured evidence item can support
compatibility claims; declared provenance alone does not authenticate a host.

Offline OTIO conversion supports Timeline.1/Stack.1/Track.1 with integer-frame
Clip.1/Clip.2, Gap.1 and Transition.1 timing. It refuses serialization of opaque
nests and effect parameters. Integer audio sample clocks up to 768kHz are
supported. Fractional clock counts are inspected with explicit warnings and
refused by the integer-frame serializer. The loss report identifies actual `xmeml` vs
`fcpxml` roots and distinguishes inspection from preservation; AAF/OMF remain
opaque bytes until an appropriate native/destination reader measures them.

Marker CSV exports quote cells, escape formula prefixes, and preserve tick
columns beside rounded frame-display timecodes. ALE intake maps only named
facility fields, requires source matching preview, and leaves duplicates or
unsupported columns ineligible for application. Audio-post plans preserve
requested channels, handles, automation, media manifest and reference picture
without treating those requests as destination DAW acceptance.
