import { divide, frameToTicks, rate, ticks, ticksToFrame, type RationalRate } from "../ai/exact-time.js";
import { boundJsonTree, boundedText, MAX_INTERCHANGE_BYTES, MAX_INTERCHANGE_ENTRIES, onlyKeys, record } from "./bounded-file.js";

export interface InterchangeEntry {
  id: string;
  kind: "clip" | "gap" | "transition" | "nested";
  name: string;
  record_start_ticks: string;
  source_start_ticks: string;
  duration_ticks: string;
  source_rate: RationalRate;
  media_reference: string | null;
  effects: string[];
  transition?: { in_offset_ticks: string; out_offset_ticks: string; type: string };
}
export interface InterchangeSnapshot {
  schemaVersion: "premiere-mcp.interchange.snapshot.v1";
  name: string;
  rate: RationalRate;
  global_start_ticks: string;
  tracks: Array<{ id: string; name: string; kind: "Video" | "Audio"; entries: InterchangeEntry[] }>;
  warnings: string[];
  complete: boolean;
  identityBoundary: "offline_synthetic_ids_never_authorize_host_mutations";
}

/** IDs describe this offline parse only; compare the supported editorial payload. */
export function supportedSnapshotProjection(snapshot: InterchangeSnapshot) {
  return { name: snapshot.name, rate: rate(snapshot.rate), global_start_ticks: snapshot.global_start_ticks, tracks: snapshot.tracks.map(track => ({ name: track.name, kind: track.kind, entries: track.entries.map(entry => ({ kind: entry.kind, name: entry.name, record_start_ticks: entry.record_start_ticks, source_start_ticks: entry.source_start_ticks, duration_ticks: entry.duration_ticks, source_rate: rate(entry.source_rate), media_reference: entry.media_reference, effects: entry.effects, ...(entry.transition ? { transition: entry.transition } : {}) })) })) };
}

function schema(node: Record<string, unknown>, allowed: readonly string[], label: string) {
  if (typeof node.OTIO_SCHEMA !== "string" || !allowed.includes(node.OTIO_SCHEMA)) throw new Error(`${label} has unsupported OTIO schema ${String(node.OTIO_SCHEMA)}`);
}
function otioRate(value: unknown): RationalRate {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 768000) throw new Error("OTIO rate must be finite and in (0, 768000], including audio sample clocks");
  for (const numerator of [24000, 30000, 60000, 120000]) {
    if (Math.abs(value - numerator / 1001) < 1e-10) return rate({ numerator, denominator: 1001 });
  }
  const spelling = String(value);
  if (!/^\d+(\.\d{1,6})?$/.test(spelling)) throw new Error("OTIO rate precision is unsupported; supply an exact supported rational rate");
  const [whole, fraction = ""] = spelling.split(".");
  return rate({ numerator: Number(whole + fraction), denominator: 10 ** fraction.length });
}
function rationalTime(value: unknown, label: string) {
  const node = record(value, label);
  schema(node, ["RationalTime.1"], label);
  if (typeof node.value !== "number" || !Number.isFinite(node.value) || Math.abs(node.value) > Number.MAX_SAFE_INTEGER || !/^-?\d+(\.\d{1,6})?$/.test(String(node.value))) throw new Error(`${label}.value must be a bounded plain frame/sample count with at most six fractional digits`);
  const frameRate = otioRate(node.rate);
  const spelling = String(node.value), negative = spelling.startsWith("-"), [whole, fraction = ""] = (negative ? spelling.slice(1) : spelling).split(".");
  const numerator = BigInt(whole + fraction) * (negative ? -1n : 1n) * 254016000000n * BigInt(frameRate.denominator), denominator = BigInt(frameRate.numerator) * 10n ** BigInt(fraction.length);
  const tickValue = divide(numerator, denominator).toString();
  return { ticks: tickValue, rate: frameRate, exact: BigInt(tickValue) * denominator === numerator, fractional: fraction.length > 0 };
}
function range(value: unknown, label: string) {
  const node = record(value, label);
  schema(node, ["TimeRange.1"], label);
  const start = rationalTime(node.start_time, `${label}.start_time`), duration = rationalTime(node.duration, `${label}.duration`);
  if (ticks(duration.ticks) < 0n) throw new Error(`${label}.duration must not be negative`);
  return { start, duration };
}
function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_INTERCHANGE_ENTRIES) throw new Error(`${label} must contain at most ${MAX_INTERCHANGE_ENTRIES} entries`);
  return value;
}
function name(value: unknown, label: string): string { return boundedText(value ?? "", label); }

/** Declared subset: timeline + ordered tracks, clips/gaps/transitions. No project import. */
export function inspectOtio(contents: string): InterchangeSnapshot {
  if (Buffer.byteLength(contents) > MAX_INTERCHANGE_BYTES) throw new Error("OTIO exceeds byte limit");
  const parsed: unknown = JSON.parse(contents);
  boundJsonTree(parsed);
  const timeline = record(parsed, "timeline");
  schema(timeline, ["Timeline.1"], "timeline");
  const stack = record(timeline.tracks, "timeline.tracks");
  schema(stack, ["Stack.1"], "timeline.tracks");
  const warnings: string[] = [];
  const start = timeline.global_start_time == null ? null : rationalTime(timeline.global_start_time, "global_start_time");
  let inferredRate: RationalRate | null = start?.rate ?? null;
  let entryCount = 0;
  const warn = (message: string) => { if (warnings.length < 256) warnings.push(message); };
  if (start?.fractional || (start && !start.exact)) warn("Global start has fractional clock units or tick rounding; integer-frame serialization is unsupported");
  if (stack.source_range != null) warn("Top-level stack source-range trimming is unsupported by this linear snapshot");
  if (stack.effects != null && list(stack.effects, "stack.effects").length) warn("Top-level stack effects are not converted");
  const tracks = list(stack.children, "tracks.children").map((rawTrack, trackIndex) => {
    const track = record(rawTrack, `track ${trackIndex}`);
    schema(track, ["Track.1"], `track ${trackIndex}`);
    if (track.kind !== "Video" && track.kind !== "Audio") throw new Error("OTIO track kind must be Video or Audio");
    if (track.source_range != null) warn(`track ${trackIndex}: track source-range trimming is not applied by this linear snapshot`);
    let position = 0n;
    const entries = list(track.children, "track.children").map((rawEntry, entryIndex): InterchangeEntry => {
      if (++entryCount > MAX_INTERCHANGE_ENTRIES) throw new Error("OTIO exceeds the total 2,000-entry limit");
      const entry = record(rawEntry, `entry ${entryIndex}`), id = `offline:${trackIndex}:${entryIndex}`;
      const entrySchema = String(entry.OTIO_SCHEMA);
      schema(entry, ["Clip.1", "Clip.2", "Gap.1", "Transition.1", "Stack.1", "Track.1"], id);
      const effects = entry.effects == null ? [] : list(entry.effects, `${id}.effects`).map((value, index) => {
        const effect = record(value, `${id}.effects[${index}]`);
        const effectName = name(effect.effect_name ?? effect.name ?? effect.OTIO_SCHEMA, "effect name");
        warn(`${id}: effect ${effectName} is inspected by name only; its parameters/retiming are not converted`);
        return effectName;
      });
      if (entry.markers != null && list(entry.markers, `${id}.markers`).length) warn(`${id}: OTIO markers are not converted in this snapshot; export review markers separately`);
      if (entry.metadata && Object.keys(record(entry.metadata, `${id}.metadata`)).length) warn(`${id}: entry metadata is not converted`);
      if (entrySchema === "Transition.1") {
        const incoming = rationalTime(entry.in_offset, `${id}.in_offset`), outgoing = rationalTime(entry.out_offset, `${id}.out_offset`);
        if (ticks(incoming.ticks) < 0n || ticks(outgoing.ticks) < 0n) throw new Error("Transition offsets must be non-negative");
        if (incoming.fractional || outgoing.fractional || !incoming.exact || !outgoing.exact) warn(`${id}: fractional/rounded transition offsets are inspected only; integer-frame serialization is unsupported`);
        inferredRate ??= incoming.rate;
        return { id, kind: "transition", name: name(entry.name, "entry name"), record_start_ticks: position.toString(), source_start_ticks: "0", duration_ticks: "0", source_rate: incoming.rate, media_reference: null, effects, transition: { in_offset_ticks: incoming.ticks, out_offset_ticks: outgoing.ticks, type: name(entry.transition_type, "transition type") } };
      }
      const source = range(entry.source_range, `${id}.source_range`);
      inferredRate ??= source.duration.rate;
      if (!source.start.exact || !source.duration.exact) warn(`${id}: rational time rounded to the nearest Premiere tick`);
      if (source.start.fractional || source.duration.fractional) warn(`${id}: fractional frame/sample timing is inspected in ticks but integer-frame serialization is unsupported`);
      let media: string | null = null;
      if (entrySchema.startsWith("Clip.")) {
        const reference = record(entry.media_reference, `${id}.media_reference`);
        schema(reference, ["ExternalReference.1", "MissingReference.1"], `${id}.media_reference`);
        if (reference.OTIO_SCHEMA === "ExternalReference.1") media = boundedText(reference.target_url, "target_url", 4096, false);
        else warn(`${id}: missing media reference`);
      }
      const nested = entrySchema === "Stack.1" || entrySchema === "Track.1";
      if (nested) warn(`${id}: nested composition retained as an opaque duration; child edits are unsupported`);
      const result: InterchangeEntry = { id, kind: nested ? "nested" : entrySchema === "Gap.1" ? "gap" : "clip", name: name(entry.name, "entry name"), record_start_ticks: position.toString(), source_start_ticks: source.start.ticks, duration_ticks: source.duration.ticks, source_rate: source.duration.rate, media_reference: media, effects };
      position += ticks(result.duration_ticks);
      return result;
    });
    return { id: `offline:track:${trackIndex}`, name: name(track.name, "track name"), kind: track.kind, entries } as InterchangeSnapshot["tracks"][number];
  });
  if (timeline.metadata && Object.keys(record(timeline.metadata, "metadata")).length) warn("Timeline metadata is not converted; use named facility fields for handoff");
  if (!inferredRate) warn("Empty timeline has no rate; offline snapshot uses 24/1 and declares this default");
  return { schemaVersion: "premiere-mcp.interchange.snapshot.v1", name: name(timeline.name, "timeline name"), rate: inferredRate ?? { numerator: 24, denominator: 1 }, global_start_ticks: start?.ticks ?? "0", tracks, warnings, complete: warnings.length === 0, identityBoundary: "offline_synthetic_ids_never_authorize_host_mutations" };
}

/** Refuse unsupported features rather than silently dropping them during a round trip. */
export function snapshotToOtio(input: unknown): string {
  boundJsonTree(input);
  const snapshot = record(input, "snapshot") as unknown as InterchangeSnapshot;
  onlyKeys(snapshot as unknown as Record<string, unknown>, ["schemaVersion", "name", "rate", "global_start_ticks", "tracks", "warnings", "complete", "identityBoundary"], "snapshot");
  if (snapshot.schemaVersion !== "premiere-mcp.interchange.snapshot.v1" || snapshot.identityBoundary !== "offline_synthetic_ids_never_authorize_host_mutations") throw new Error("Unsupported offline snapshot schema/identity boundary");
  const frameRate = rate(snapshot.rate);
  if (!Array.isArray(snapshot.warnings) || snapshot.warnings.length || snapshot.complete !== true) throw new Error("Snapshot has unresolved loss/timing warnings; unsupported conversion requires a separately reviewed representation");
  function time(value: string, targetRate: RationalRate) {
    const frames = ticksToFrame(value, targetRate);
    if (frameToTicks(frames, targetRate) !== value || !Number.isSafeInteger(Number(frames))) throw new Error("Snapshot time is not exactly representable on the requested OTIO frame grid");
    return { OTIO_SCHEMA: "RationalTime.1", value: Number(frames), rate: targetRate.numerator / targetRate.denominator };
  }
  let count = 0;
  const tracks = list(snapshot.tracks, "snapshot.tracks").map((value, index) => {
    const track = record(value, "track") as unknown as InterchangeSnapshot["tracks"][number];
    onlyKeys(track as unknown as Record<string, unknown>, ["id", "name", "kind", "entries"], "snapshot track");
    if (!["Video", "Audio"].includes(track.kind)) throw new Error("snapshot track kind must be Video or Audio");
    let position = 0n;
    const children = list(track.entries, "entries").map(value => {
      if (++count > MAX_INTERCHANGE_ENTRIES) throw new Error("Snapshot exceeds the total entry limit");
      const entry = record(value, "entry") as unknown as InterchangeEntry;
      onlyKeys(entry as unknown as Record<string, unknown>, ["id", "kind", "name", "record_start_ticks", "source_start_ticks", "duration_ticks", "source_rate", "media_reference", "effects", "transition"], "snapshot entry");
      if (entry.kind === "nested" || list(entry.effects, "effects").length) throw new Error("Nested compositions and effect parameters cannot be serialized by the supported OTIO subset");
      if (ticks(entry.record_start_ticks) !== position) throw new Error("Snapshot entries must be contiguous and ordered; represent gaps explicitly");
      const entryRate = rate(entry.source_rate);
      const common = { name: name(entry.name, "entry name"), metadata: {}, effects: [], markers: [] };
      if (entry.kind === "transition") {
        const transition = record(entry.transition, "transition") as NonNullable<InterchangeEntry["transition"]>;
        if (ticks(transition.in_offset_ticks) < 0n || ticks(transition.out_offset_ticks) < 0n) throw new Error("Transition offsets must be non-negative");
        return { OTIO_SCHEMA: "Transition.1", ...common, transition_type: name(transition.type, "transition type"), in_offset: time(transition.in_offset_ticks, entryRate), out_offset: time(transition.out_offset_ticks, entryRate) };
      }
      if (entry.kind !== "clip" && entry.kind !== "gap") throw new Error("Unsupported snapshot entry kind");
      if (ticks(entry.duration_ticks) < 0n) throw new Error("Snapshot duration must not be negative");
      position += ticks(entry.duration_ticks);
      const sourceRange = { OTIO_SCHEMA: "TimeRange.1", start_time: time(entry.source_start_ticks, entryRate), duration: time(entry.duration_ticks, entryRate) };
      return { OTIO_SCHEMA: entry.kind === "gap" ? "Gap.1" : "Clip.2", ...common, source_range: sourceRange, ...(entry.kind === "clip" ? { media_reference: entry.media_reference ? { OTIO_SCHEMA: "ExternalReference.1", target_url: boundedText(entry.media_reference, "media reference", 4096, false), available_range: null, metadata: {}, name: "" } : { OTIO_SCHEMA: "MissingReference.1", name: "", metadata: {}, available_range: null } } : {}) };
    });
    return { OTIO_SCHEMA: "Track.1", name: name(track.name, `track ${index} name`), kind: track.kind, children, source_range: null, metadata: {}, effects: [], markers: [] };
  });
  return JSON.stringify({ OTIO_SCHEMA: "Timeline.1", name: name(snapshot.name, "snapshot name"), global_start_time: time(snapshot.global_start_ticks, frameRate), tracks: { OTIO_SCHEMA: "Stack.1", name: "tracks", children: tracks, source_range: null, metadata: {}, effects: [], markers: [] }, metadata: {} }, null, 2) + "\n";
}
