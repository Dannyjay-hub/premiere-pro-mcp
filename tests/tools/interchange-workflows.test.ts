import { mkdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { frameToTicks } from "../../src/ai/exact-time.js";
import { boundJsonTree, boundedText, onlyKeys, readBoundedInterchange, record, writeNewInterchange } from "../../src/interchange/bounded-file.js";
import { inspectInterchangeArtifact, interchangeLossReport, planAudioPostTurnover } from "../../src/interchange/evidence.js";
import { buildAle, buildReviewMarkerExport, inspectAle, previewFacilityMetadataIntake, spreadsheetSafe } from "../../src/interchange/facility.js";
import { inspectOtio, snapshotToOtio } from "../../src/interchange/otio.js";
import { getInterchangeWorkflowTools } from "../../src/tools/interchange-workflows.js";
import { getUxpTools } from "../../src/tools/uxp.js";
import type { UxpWebSocketBridge } from "../../src/bridge/uxp-websocket-bridge.js";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

afterAll(cleanupTempDirs);
const tools = getInterchangeWorkflowTools({ tempDir: "/tmp/interchange-workflows" });
const rt = (value: number, rate = 24) => ({ OTIO_SCHEMA: "RationalTime.1", value, rate });
const range = (start: number, duration: number, rate = 24) => ({ OTIO_SCHEMA: "TimeRange.1", start_time: rt(start, rate), duration: rt(duration, rate) });
function timeline(children: unknown[] = []) {
  return { OTIO_SCHEMA: "Timeline.1", name: "Fixture", global_start_time: rt(86400), tracks: { OTIO_SCHEMA: "Stack.1", children: [{ OTIO_SCHEMA: "Track.1", name: "V1", kind: "Video", source_range: null, children }] }, metadata: {} };
}
const clip = (start = 0, duration = 24, rate = 24) => ({ OTIO_SCHEMA: "Clip.2", name: "Source", source_range: range(start, duration, rate), media_reference: { OTIO_SCHEMA: "ExternalReference.1", target_url: "file:///fixture.mov" }, effects: [], markers: [], metadata: {} });
function fixture(name: string, contents: string | Buffer) { const path = join(makeTempDir("interchange-workflows-"), name); writeFileSync(path, contents); return path; }

describe("bounded OTIO subset and canonical round trips", () => {
  it("preserves exact clips, explicit gaps and transitions across parse/serialize/parse", () => {
    const original = inspectOtio(JSON.stringify(timeline([clip(12, 24), { OTIO_SCHEMA: "Gap.1", name: "gap", source_range: range(0, 12) }, { OTIO_SCHEMA: "Transition.1", name: "dissolve", transition_type: "SMPTE_Dissolve", in_offset: rt(6), out_offset: rt(6) }, clip(24, 48)])));
    const reparsed = inspectOtio(snapshotToOtio(original));
    expect(reparsed).toEqual(original);
    expect(original).toMatchObject({ complete: true, global_start_ticks: frameToTicks("86400", { numerator: 24, denominator: 1 }), identityBoundary: "offline_synthetic_ids_never_authorize_host_mutations" });
    expect(original.tracks[0].entries.map(value => value.record_start_ticks)).toEqual(["0", frameToTicks("24", original.rate), frameToTicks("36", original.rate), frameToTicks("36", original.rate)]);
  });

  it("round-trips generated exact edit grids with deterministic failing-seed context", () => {
    let state = 0x51a7;
    const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
    for (let seed = 0; seed < 60; seed++) {
      const fps = [24, 25, 30000 / 1001][seed % 3];
      const document = timeline(Array.from({ length: 1 + next() % 8 }, () => clip(next() % 1000, 1 + next() % 240, fps)));
      document.global_start_time = rt(0, fps);
      const before = inspectOtio(JSON.stringify(document));
      expect(inspectOtio(snapshotToOtio(before)), `seed=${seed},state=${state}`).toEqual(before);
    }
  });

  it("keeps decimal 29.97 distinct from 30000/1001 and marks tick approximation", () => {
    const document = timeline([clip(0, 1, 29.97)]); document.global_start_time = rt(0, 29.97);
    const parsed = inspectOtio(JSON.stringify(document));
    expect(parsed.rate).toEqual({ numerator: 2997, denominator: 100 });
    expect(parsed.warnings.join(" ")).toContain("rounded");
    expect(() => snapshotToOtio(parsed)).toThrow("unresolved");
  });

  it("reports missing references, opaque effects/nests/metadata and refuses lossful serialization", () => {
    const document = timeline([{ ...clip(), media_reference: { OTIO_SCHEMA: "MissingReference.1" }, effects: [{ OTIO_SCHEMA: "LinearTimeWarp.1", effect_name: "LinearTimeWarp" }], markers: [{}], metadata: { note: "x" } }, { OTIO_SCHEMA: "Stack.1", name: "nest", source_range: range(0, 24) }]);
    document.metadata = { private: "not exposed" };
    const parsed = inspectOtio(JSON.stringify(document));
    expect(parsed.complete).toBe(false);
    expect(parsed.warnings.join(" ")).toMatch(/effect.*markers.*metadata.*missing.*nested.*metadata/);
    expect(() => snapshotToOtio(parsed)).toThrow("unresolved");
    const forced = { ...parsed, warnings: [], complete: true };
    expect(() => snapshotToOtio(forced)).toThrow("Nested compositions and effect");
  });

  it.each([
    ["unsupported root", { OTIO_SCHEMA: "Timeline.99" }, /unsupported OTIO/],
    ["unsafe clock count", timeline([{ ...clip(), source_range: range(Number.MAX_SAFE_INTEGER + 1, 24) }]), /bounded plain/],
    ["negative duration", timeline([{ ...clip(), source_range: range(0, -1) }]), /negative/],
    ["unsupported rate", timeline([clip(0, 1, 0)]), /rate/],
    ["excess rate precision", timeline([clip(0, 1, 23.12345678)]), /precision/],
    ["unknown ref", timeline([{ ...clip(), media_reference: { OTIO_SCHEMA: "GeneratorReference.99" } }]), /unsupported/],
    ["wrong track kind", { ...timeline(), tracks: { OTIO_SCHEMA: "Stack.1", children: [{ OTIO_SCHEMA: "Track.1", kind: "Other", children: [] }] } }, /Video or Audio/],
  ])("rejects %s", (_name, document, error) => expect(() => inspectOtio(JSON.stringify(document))).toThrow(error as RegExp));

  it("rejects malformed, huge, deep and unsafe JSON; validates snapshot continuity", () => {
    expect(() => inspectOtio("{" )).toThrow();
    expect(() => inspectOtio(" ".repeat(10 * 1024 * 1024 + 1))).toThrow("byte");
    expect(() => inspectOtio('{"__proto__":{}}')).toThrow("unsafe");
    let deep: unknown = null; for (let i = 0; i < 34; i++) deep = [deep];
    expect(() => boundJsonTree(deep)).toThrow("nesting");
    expect(() => boundJsonTree(new Array(2001))).toThrow("entry");
    expect(() => boundJsonTree("x".repeat(16385))).toThrow("string");
    expect(() => boundJsonTree(NaN)).toThrow("finite");
    const snapshot = inspectOtio(JSON.stringify(timeline([clip()])));
    expect(() => snapshotToOtio({ ...snapshot, extra: 1 })).toThrow("unknown");
    expect(() => snapshotToOtio({ ...snapshot, schemaVersion: "bad" })).toThrow("schema");
    snapshot.tracks[0].entries[0].record_start_ticks = "1";
    expect(() => snapshotToOtio(snapshot)).toThrow("contiguous");
    snapshot.tracks[0].entries[0].record_start_ticks = "0"; snapshot.tracks[0].entries[0].source_start_ticks = "1";
    expect(() => snapshotToOtio(snapshot)).toThrow("frame grid");
    const noRate = { OTIO_SCHEMA: "Timeline.1", tracks: { OTIO_SCHEMA: "Stack.1", children: [] } };
    expect(inspectOtio(JSON.stringify(noRate)).warnings.join(" ")).toContain("24/1");
    const trimmed = timeline([clip()]); trimmed.tracks.children[0].source_range = range(0, 24) as any;
    expect(inspectOtio(JSON.stringify(trimmed)).warnings.join(" ")).toContain("track source-range");
    const top = timeline([clip()]); Object.assign(top.tracks, { source_range: range(0, 24), effects: [{ effect_name: "blur" }] });
    expect(inspectOtio(JSON.stringify(top)).warnings.join(" ")).toMatch(/stack source-range.*stack effects/);
    const negativeTransition = timeline([{ OTIO_SCHEMA: "Transition.1", in_offset: rt(-1), out_offset: rt(0) }]);
    expect(() => inspectOtio(JSON.stringify(negativeTransition))).toThrow("offsets");
    const badTrack = inspectOtio(JSON.stringify(timeline([clip()]))); badTrack.tracks[0].kind = "Other" as any;
    expect(() => snapshotToOtio(badTrack)).toThrow("kind");
    const badKind = inspectOtio(JSON.stringify(timeline([clip()]))); badKind.tracks[0].entries[0].kind = "unknown" as any;
    expect(() => snapshotToOtio(badKind)).toThrow("entry kind");
    const negativeDuration = inspectOtio(JSON.stringify(timeline([clip()]))); negativeDuration.tracks[0].entries[0].duration_ticks = "-1";
    expect(() => snapshotToOtio(negativeDuration)).toThrow("negative");
  });
  it("inspects fractional timing with warnings and round-trips exact audio sample clocks", () => {
    const fractional = inspectOtio(JSON.stringify(timeline([{ ...clip(), source_range: range(0.5, 24) }])));
    expect(fractional.warnings.join(" ")).toContain("fractional frame/sample");
    expect(() => snapshotToOtio(fractional)).toThrow("unresolved");
    const audio = timeline([clip(4800, 48000, 48000)]); audio.tracks.children[0].kind = "Audio";
    const parsed = inspectOtio(JSON.stringify(audio));
    expect(parsed.tracks[0].entries[0].source_rate).toEqual({ numerator: 48000, denominator: 1 });
    expect(inspectOtio(snapshotToOtio(parsed))).toEqual(parsed);
  });
});

describe("marker and ALE adapters", () => {
  const marker = { id: "m1", name: '=SUM(1,2)', comment: 'Quoted "note"\nsecond line', color: "green", start_ticks: "0", duration_ticks: frameToTicks("30", { numerator: 30000, denominator: 1001 }) };
  const request = { target: { kind: "sequence", id: "s1", display_start_ticks: frameToTicks("1800", { numerator: 30000, denominator: 1001 }) }, rate: { numerator: 30000, denominator: 1001 }, drop_frame: true, markers: [marker] };
  it("preserves quotes/newlines, exact ticks, nonzero start and drop-frame display with formula-safe CSV", () => {
    const exported = buildReviewMarkerExport(request, "csv");
    expect(exported.contents).toContain('"\'=SUM(1,2)"');
    expect(exported.contents).toContain('Quoted ""note""\nsecond line');
    expect(exported.receipt.markers[0].timecode).toBe("00:01:00;02");
    expect(JSON.parse(buildReviewMarkerExport({ ...request, target: { ...request.target, kind: "source" } }, "json").contents).target.kind).toBe("source");
    expect(buildReviewMarkerExport({ ...request, markers: [] }, "csv").contents).toBe("target_kind,target_id,marker_id,name,comment,color,start_ticks,duration_ticks,end_ticks,timecode,end_timecode,display_frame,rate_numerator,rate_denominator,drop_frame\r\n");
    for (const value of [" +SUM(A1)", "-1", "@foo", "\tfoo", "\rnote", "\nline"]) expect(spreadsheetSafe(value)).toBe(`'${value}`);
    expect(spreadsheetSafe("normal")).toBe("normal");
  });
  it.each([
    [{ ...request, markers: [marker, marker] }, /Duplicate/],
    [{ ...request, target: { ...request.target, kind: "unknown" } }, /kind/],
    [{ ...request, drop_frame: "yes" }, /boolean/],
    [{ ...request, rate: { numerator: 24, denominator: 1 } }, /drop-frame/],
    [{ ...request, markers: [{ ...marker, start_ticks: "-1" }] }, /non-negative/],
    [{ ...request, markers: [{ ...marker, extra: 1 }] }, /unknown/],
    [{ ...request, markers: new Array(2001) }, /entry/],
  ])("refuses malformed marker export", (bad, error) => expect(() => buildReviewMarkerExport(bad, "csv")).toThrow(error));

  const ale = buildAle({ columns: ["Name", "Scene", "Unknown"], fps: "24", rows: [{ Name: "a.mov", Scene: "1A", Unknown: "x" }, { Name: "b.mov", Scene: "2B", Unknown: "y" }] });
  it("round-trips ALE rows and previews exact named-field matches without a packet dump", () => {
    expect(inspectAle(ale)).toMatchObject({ rowCount: 2, columns: ["Name", "Scene", "Unknown"], headings: { FIELD_DELIM: "TABS", FPS: "24" } });
    const preview = previewFacilityMetadataIntake(ale, { match_column: "Name", column_mapping: { Scene: "Scene", Unknown: "SensitiveExif" }, sources: [{ id: "a", file_name: "a.mov" }, { id: "b1", file_name: "b.mov" }, { id: "b2", file_name: "b.mov" }] });
    expect(preview).toMatchObject({ mutatesProject: false, packetDumpRequired: false, unsupportedFields: ["Unknown"] });
    expect(preview.proposals.map(value => value.status)).toEqual(["matched", "ambiguous_source"]);
    expect(preview.proposals.every(value => !value.applicable)).toBe(true);
    expect(preview.proposals[0].proposedFields).toEqual([{ field: "Scene", value: "1A" }]);
    const duplicates = ale.replace("b.mov", "a.mov");
    expect(previewFacilityMetadataIntake(duplicates, { match_column: "Name", column_mapping: { Scene: "Scene" }, sources: [] }).proposals[0].status).toBe("duplicate_table_key");
    expect(previewFacilityMetadataIntake(ale, { match_column: "Name", column_mapping: { Scene: "Scene" }, sources: [] }).proposals[0].status).toBe("missing_source");
  });
  it("rejects malformed ALE and unsafe mappings before field writes", () => {
    expect(() => inspectAle("Data\n" )).toThrow("ordered");
    expect(() => inspectAle(ale.replace("Name\tScene\tUnknown", "Name\tName\tUnknown"))).toThrow("duplicates");
    expect(() => inspectAle(ale.replace("1A\tx", "1A"))).toThrow("column count");
    expect(() => buildAle({ columns: ["Name"], fps: "24", rows: [{ Name: "a\tb" }] })).toThrow("tabs/newlines");
    expect(() => buildAle({ columns: ["Name"], fps: "999", rows: [] })).toThrow("fps");
    expect(() => buildAle({ columns: ["Name"], fps: "24", rows: [{ Extra: "x" }] })).toThrow("unknown");
    expect(() => previewFacilityMetadataIntake(ale, { match_column: "No", column_mapping: {}, sources: [] })).toThrow("match_column");
    expect(() => previewFacilityMetadataIntake(ale, { match_column: "Name", column_mapping: { Missing: "Scene" }, sources: [] })).toThrow("Mapped column");
    expect(() => previewFacilityMetadataIntake(ale, { match_column: "Name", column_mapping: { Scene: "Scene", Unknown: "Scene" }, sources: [] })).toThrow("same metadata");
    expect(() => previewFacilityMetadataIntake(ale, { match_column: "Name", column_mapping: {}, sources: [{ id: "same", file_name: "a.mov" }, { id: "same", file_name: "b.mov" }] })).toThrow("Duplicate source");
    expect(() => inspectAle(ale.replace("FPS\t24", "FPS\t24\textra"))).toThrow("heading");
    expect(() => inspectAle(ale.replace("FPS\t24", "FPS\t24\n" + Array.from({ length: 65 }, (_, index) => `HEAD_${String.fromCharCode(65 + Math.floor(index / 26), 65 + index % 26)}\tx`).join("\n")))).toThrow("64");
    expect(() => inspectAle(ale + Array.from({ length: 2000 }, () => "a.mov\t1\tx\n").join(""))).toThrow("2,000");
    expect(() => buildAle({ columns: [], fps: "24", rows: [] })).toThrow("columns");
    expect(() => buildAle({ columns: ["Name"], fps: "24", rows: new Array(2001) })).toThrow("entry");
    expect(buildAle({ columns: ["Name", "Scene"], fps: "24", rows: [{ Name: "a.mov" }] })).toContain("a.mov\t\n");
    expect(() => buildReviewMarkerExport({ ...request, markers: null }, "csv")).toThrow("markers");
    expect(() => buildReviewMarkerExport(request, "invalid" as any)).toThrow("format");
  });
});

describe("artifact evidence and audio-post contracts", () => {
  it("identifies actual XML roots, OTIO and EDL and retains opaque AAF/OMF limits", () => {
    expect(inspectInterchangeArtifact(fixture("wrong.fcpxml", '<?xml version="1.0"?><xmeml version="5"><sequence><clipitem /></sequence></xmeml>'), "fcpxml")).toMatchObject({ format: "fcp7xml", parsed: true, roundTripValidated: false, hostVerified: false });
    expect(inspectInterchangeArtifact(fixture("f.xml", "<!--header--><fcpxml version=\"1.10\"><sequence /></fcpxml>"))).toMatchObject({ format: "fcpxml" });
    expect(inspectInterchangeArtifact(fixture("edit.otio", JSON.stringify(timeline([clip()]))))).toMatchObject({ format: "otio", parsed: true });
    expect(inspectInterchangeArtifact(fixture("edit.edl", "TITLE: EDL\n001 A V C 00:00:00:00 00:00:01:00 01:00:00:00 01:00:01:00"))).toMatchObject({ format: "edl" });
    const aaf = fixture("edit.aaf", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    expect(inspectInterchangeArtifact(aaf, "aaf")).toMatchObject({ parsed: false, verificationBoundary: "local_file_bytes_only" });
    expect(() => inspectInterchangeArtifact(aaf)).toThrow("explicit aaf");
    expect(inspectInterchangeArtifact(fixture("edit.omf", "opaque"), "omf")).toMatchObject({ parsed: false });
    expect(() => inspectInterchangeArtifact(fixture("wrong.xml", "<fcpxml/>"), "otio")).toThrow("not requested");
    expect(() => inspectInterchangeArtifact(fixture("bad.xml", "<outer><fcpxml/></outer>"))).toThrow("root/signature");
    expect(() => inspectInterchangeArtifact(fixture("empty", ""))).toThrow("nonempty");
    expect(() => inspectInterchangeArtifact(fixture("bad.edl", "TITLE: Only"))).toThrow("no supported event");
    expect(inspectInterchangeArtifact(fixture("doctype.xml", '<!DOCTYPE xmeml><xmeml version="5"><sequence><![CDATA[a < b]]></sequence></xmeml>'))).toMatchObject({ format: "fcp7xml", parsed: true });
    for (const bad of ['<xmeml><sequence></xmeml>', '<xmeml/><xmeml/>', '<xmeml><sequence>', '<xmeml version=5/>', '<xmeml version="5" version="4"/>', '<xmeml>&secret;</xmeml>', '<xmeml name="&secret;"/>', '<!DOCTYPE xmeml [<!ENTITY secret SYSTEM "file:///private">]><xmeml/>', '<xmeml><!OTHER /></xmeml>']) expect(() => inspectInterchangeArtifact(fixture("bad-structure.xml", bad))).toThrow();
    expect(() => inspectInterchangeArtifact(fixture("invalid-utf8.otio", Buffer.from([0x7b, 0xff, 0x7d])))).toThrow("UTF-8");
    expect(() => inspectInterchangeArtifact("relative.xml")).toThrow("absolute");
    expect(() => inspectInterchangeArtifact(fixture("deep.xml", "<xmeml>" + "<node>".repeat(65) + "</node>".repeat(65) + "</xmeml>"))).toThrow("nesting");
    expect(inspectInterchangeArtifact(fixture("entities.xml", '<xmeml name="&#65;">&#x10000;&amp;&#9;</xmeml>'))).toMatchObject({ parsed: true });
    for (const bad of ['<xmeml>&#0;</xmeml>', '<xmeml>&#xD800;</xmeml>', '<xmeml name="bad < literal"/>', '<xmeml>]]></xmeml>', '<xmeml><!--invalid -- comment--></xmeml>', '<xmeml><?xml version="1.0"?></xmeml>', '<!DOCTYPE xmeml><!DOCTYPE xmeml><xmeml/>']) expect(() => inspectInterchangeArtifact(fixture("bad-xml-characters.xml", bad))).toThrow();
  });
  it("distinguishes dropped CMX features from unknown native/destination semantics", () => {
    const report = interchangeLossReport("edl", { effects: 2, nests: 1, transitions: 1, captions: 0 });
    expect(report.features.find(value => value.feature === "effects")).toMatchObject({ status: "dropped" });
    expect(report.features.find(value => value.feature === "nests")).toMatchObject({ status: "approximated" });
    expect(report.features.find(value => value.feature === "captions")).toMatchObject({ status: "inspected" });
    expect(interchangeLossReport("otio", { effects: 1 }).features.find(value => value.feature === "effects")?.reason).toContain("refuses");
    expect(interchangeLossReport("aaf", { channel_mapping: 2 }).features.find(value => value.feature === "channel_mapping")?.status).toBe("unknown");
    expect(() => interchangeLossReport("bad" as any)).toThrow("Unsupported");
    expect(() => interchangeLossReport("otio", { unknown: 1 })).toThrow("unknown");
    expect(() => interchangeLossReport("otio", { effects: -1 })).toThrow("bounded counts");
    const artifact = inspectInterchangeArtifact(fixture("f.xml", "<xmeml/>"));
    expect(interchangeLossReport("fcp7xml", { linear_timing: 1 }, artifact).features[0]).toMatchObject({ status: "inspected" });
  });
  const turnover = { format: "aaf", sequence_id: "sequence-1", range: { start_ticks: "0", end_ticks: "254016000000" }, rate: { numerator: 24, denominator: 1 }, handle_frames: 12, sample_rate: 48000, channel_mapping: [{ track_id: "a1", source_channel: 1, destination_channel: 1 }], gain_automation: "preserve_requested", media: [{ id: "media1", file_name: "audio.wav", bytes: 100, sha256: "a".repeat(64), status: "available" }], reference_picture: "reference-1" };
  it("retains exact ranges/handles/channel requests while destination acceptance remains not_run", () => {
    expect(planAudioPostTurnover(turnover)).toMatchObject({ readyForReview: true, destinationAcceptance: "not_run", mutatesProject: false, range: { endPolicy: "exclusive" }, channel_mapping: [{ verification: "requested_not_measured" }] });
    expect(planAudioPostTurnover({ ...turnover, format: "omf", gain_automation: "unsupported", media: [{ ...turnover.media[0], status: "missing" }] })).toMatchObject({ readyForReview: false, route: expect.stringContaining("export_omf") });
  });
  it.each([
    [{ ...turnover, format: "bad" }, /format/], [{ ...turnover, range: { start_ticks: "1", end_ticks: "0" } }, /exclusive/], [{ ...turnover, handle_frames: -1 }, /handle_frames/], [{ ...turnover, sample_rate: 42 }, /sample_rate/], [{ ...turnover, gain_automation: "guess" }, /gain_automation/], [{ ...turnover, channel_mapping: [...turnover.channel_mapping, ...turnover.channel_mapping] }, /Duplicate channel/], [{ ...turnover, channel_mapping: [{ track_id: "a", source_channel: 0, destination_channel: 1 }] }, /source_channel/], [{ ...turnover, media: [...turnover.media, ...turnover.media] }, /Duplicate media/], [{ ...turnover, media: [{ ...turnover.media[0], sha256: "wrong" }] }, /hash/], [{ ...turnover, media: [{ ...turnover.media[0], status: "guess" }] }, /status/],
  ])("validates turnover before native export", (bad, error) => expect(() => planAudioPostTurnover(bad)).toThrow(error));
});

describe("local tool writes, failures and UXP export evidence", () => {
  it("creates readback-verified marker/ALE files without overwriting prior files", async () => {
    const directory = makeTempDir("marker-exports-");
    const output = join(directory, "markers.csv");
    const args = { output_path: output, format: "csv" as const, target: { kind: "sequence", id: "s1", display_start_ticks: "0" }, rate: { numerator: 24, denominator: 1 }, markers: [] };
    expect(await tools.export_review_markers.handler(args)).toMatchObject({ success: true, data: { outcome: "verified", markerCount: 0, hostVerified: false } });
    expect(readFileSync(output, "utf8")).toContain("marker_id");
    expect(await tools.export_review_markers.handler(args)).toMatchObject({ success: false });
    expect(await tools.export_facility_metadata_table.handler({ output_path: join(directory, "metadata.ale"), fps: "24", columns: ["Name"], rows: [] })).toMatchObject({ success: true, data: { rowCount: 0, destinationAcceptance: "not_run" } });
    expect(() => writeNewInterchange("relative.csv", "x")).toThrow("absolute");
    expect(() => readBoundedInterchange("relative.otio")).toThrow("absolute");
    expect(() => readBoundedInterchange(fixture("binary", Buffer.from([0xff])))).toThrow("UTF-8");
    expect(() => boundedText("\0", "x")).toThrow("NUL");
    expect(() => record(null, "x")).toThrow("object");
    expect(() => onlyKeys({ x: 1 }, [], "x")).toThrow("unknown");
    expect(() => boundedText("", "required", 10, false)).toThrow("non-empty");
    const oversized = fixture("large.otio", "{}"); truncateSync(oversized, 10 * 1024 * 1024 + 1);
    expect(() => readBoundedInterchange(oversized)).toThrow("at most");
    expect(() => inspectInterchangeArtifact(oversized)).toThrow("at most");
    const folder = join(directory, "folder"); mkdirSync(folder);
    expect(() => readBoundedInterchange(folder)).toThrow("regular file");
    expect(() => writeNewInterchange(join(directory, "huge.txt"), "x".repeat(10 * 1024 * 1024 + 1))).toThrow("byte limit");
    expect(() => boundJsonTree(Object.fromEntries(Array.from({ length: 257 }, (_, index) => [String(index), null])))).toThrow("256-field");
  });
  it("exposes bounded parse, preview, loss and intake routes and reports failures", async () => {
    const path = fixture("edit.otio", JSON.stringify(timeline([clip()])));
    const inspected = await tools.inspect_otio_interchange.handler({ path }) as any;
    expect(inspected.success).toBe(true);
    expect(await tools.preview_otio_snapshot_export.handler({ snapshot: inspected.data.snapshot })).toMatchObject({ success: true, data: { offlineRoundTrip: true, destinationAcceptance: "not_run" } });
    expect(await tools.inspect_interchange_artifact.handler({ path })).toMatchObject({ success: true, data: { parsed: true } });
    expect(await tools.inspect_interchange_loss_report.handler({ format: "otio", path })).toMatchObject({ success: true, data: { format: "otio" } });
    expect(await tools.inspect_interchange_loss_report.handler({ format: "edl" })).toMatchObject({ success: true, data: { artifact: null } });
    expect(await tools.inspect_otio_interchange.handler({ path: "not-absolute" })).toMatchObject({ success: false });
    const alePath = fixture("table.ale", buildAle({ columns: ["Name", "Scene"], fps: "24", rows: [{ Name: "a.mov", Scene: "1" }] }));
    expect(await tools.preview_facility_metadata_intake.handler({ path: alePath, match_column: "Name", column_mapping: { Scene: "Scene" }, sources: [{ id: "a", file_name: "a.mov" }] })).toMatchObject({ success: true, data: { proposals: [{ status: "matched", applicable: true }] } });
    expect(await tools.plan_audio_post_turnover.handler({ bad: true })).toMatchObject({ success: false });
  });
  it("never calls the bridge for invalid paths and does not trust host verified claims", async () => {
    const request = vi.fn().mockResolvedValue({ exported: true, outcome: "verified" });
    const uxp = getUxpTools({ request } as unknown as UxpWebSocketBridge);
    expect(await uxp.export_interchange_uxp.handler({ format: "otio", output_file_path: "relative.otio" })).toMatchObject({ success: false });
    expect(request).not.toHaveBeenCalled();
    const output = join(makeTempDir("uxp-interchange-"), "new.otio");
    expect(await uxp.export_interchange_uxp.handler({ format: "otio", output_file_path: output })).toMatchObject({ success: true, data: { result: { outcome: "committed_unverified", outputVerified: false } } });
    expect(await uxp.export_interchange_uxp.handler({ format: "otio", output_file_path: output, verify_artifact: true })).toMatchObject({ success: true, data: { result: { outcome: "committed_unverified", artifact: { parsed: false } } } });
    request.mockImplementation(async () => { writeFileSync(output, JSON.stringify(timeline([clip()]))); return { exported: true, outcome: "verified" }; });
    expect(await uxp.export_interchange_uxp.handler({ format: "otio", output_file_path: output, verify_artifact: true })).toMatchObject({ success: true, data: { result: { outcome: "verified", outputVerified: true, verificationBoundary: "fresh_local_artifact_bounded_structure_only" } } });
    expect(await uxp.export_interchange_uxp.handler({ format: "otio", output_file_path: output, verify_artifact: true })).toMatchObject({ success: true, data: { result: { outcome: "committed_unverified", outputVerified: false, artifact: { freshOutput: false } } } });
    request.mockRejectedValue(new Error("Disconnected"));
    expect(await uxp.export_interchange_uxp.handler({ format: "otio", output_file_path: output })).toMatchObject({ success: false, error: "Disconnected" });
  });
});
