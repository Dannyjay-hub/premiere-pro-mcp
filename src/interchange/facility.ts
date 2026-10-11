import { createHash } from "node:crypto";
import { frameToTimecode, rate, ticks, ticksToFrame, type RationalRate } from "../ai/exact-time.js";
import { boundJsonTree, boundedText, MAX_INTERCHANGE_BYTES, MAX_INTERCHANGE_ENTRIES, onlyKeys, record } from "./bounded-file.js";

export interface ReviewMarker { id: string; name: string; comment: string; color: string; start_ticks: string; duration_ticks: string }
export interface ReviewMarkerExport { target: { kind: "sequence" | "source"; id: string; display_start_ticks: string }; rate: RationalRate; drop_frame?: boolean; markers: ReviewMarker[] }

export function spreadsheetSafe(value: string): string {
  return /^[\s]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
}
function csv(value: unknown): string { return `"${spreadsheetSafe(String(value)).replace(/"/g, '""')}"`; }

export function buildReviewMarkerExport(input: unknown, format: "csv" | "json") {
  boundJsonTree(input);
  const document = record(input, "marker export") as unknown as ReviewMarkerExport;
  onlyKeys(document as unknown as Record<string, unknown>, ["target", "rate", "drop_frame", "markers"], "marker export");
  const target = record(document.target, "target");
  onlyKeys(target, ["kind", "id", "display_start_ticks"], "target");
  if (target.kind !== "sequence" && target.kind !== "source") throw new Error("target.kind must be sequence or source");
  const targetId = boundedText(target.id, "target.id", 512, false), displayStart = ticks(target.display_start_ticks, "display_start_ticks");
  const frameRate = rate(document.rate);
  if (document.drop_frame !== undefined && typeof document.drop_frame !== "boolean") throw new Error("drop_frame must be boolean");
  frameToTimecode("0", frameRate, document.drop_frame);
  if (!Array.isArray(document.markers) || document.markers.length > MAX_INTERCHANGE_ENTRIES) throw new Error("markers must contain at most 2,000 entries");
  const seen = new Set<string>();
  const markers = document.markers.map((raw, index) => {
    const marker = record(raw, `markers[${index}]`);
    onlyKeys(marker, ["id", "name", "comment", "color", "start_ticks", "duration_ticks"], "marker");
    const id = boundedText(marker.id, "marker.id", 512, false);
    if (seen.has(id)) throw new Error(`Duplicate marker ID: ${id}`);
    seen.add(id);
    const start = ticks(marker.start_ticks, "start_ticks"), duration = ticks(marker.duration_ticks, "duration_ticks");
    if (start < 0n || duration < 0n) throw new Error("Marker start/duration must be non-negative");
    const frame = ticksToFrame((displayStart + start).toString(), frameRate);
    const endFrame = ticksToFrame((displayStart + start + duration).toString(), frameRate);
    return { id, name: boundedText(marker.name, "name"), comment: boundedText(marker.comment, "comment", 4096), color: boundedText(marker.color, "color", 64), start_ticks: start.toString(), duration_ticks: duration.toString(), end_ticks: (start + duration).toString(), timecode: frameToTimecode(frame, frameRate, document.drop_frame), end_timecode: frameToTimecode(endFrame, frameRate, document.drop_frame), display_frame: frame };
  });
  const receipt = { schemaVersion: "premiere-mcp.review-markers.v1", target: { kind: target.kind, id: targetId, display_start_ticks: displayStart.toString() }, rate: frameRate, drop_frame: document.drop_frame === true, timecodePolicy: "nearest_frame_display_with_exact_tick_columns", markers, hostVerified: false };
  if (format === "json") return { contents: JSON.stringify(receipt, null, 2) + "\n", receipt };
  if (format !== "csv") throw new Error("format must be csv or json");
  const header = ["target_kind", "target_id", "marker_id", "name", "comment", "color", "start_ticks", "duration_ticks", "end_ticks", "timecode", "end_timecode", "display_frame", "rate_numerator", "rate_denominator", "drop_frame"];
  const rows = markers.map(marker => [target.kind, targetId, marker.id, marker.name, marker.comment, marker.color, marker.start_ticks, marker.duration_ticks, marker.end_ticks, marker.timecode, marker.end_timecode, marker.display_frame, frameRate.numerator, frameRate.denominator, receipt.drop_frame].map(csv).join(","));
  return { contents: header.join(",") + "\r\n" + (rows.length ? rows.join("\r\n") + "\r\n" : ""), receipt };
}

const FACILITY_FIELDS = ["Scene", "Shot", "Take", "Tape", "CameraRoll", "SoundRoll", "LogNote", "Comment", "Description"] as const;
export interface FacilitySource { id: string; file_name: string }

export function inspectAle(contents: string) {
  if (Buffer.byteLength(contents) > MAX_INTERCHANGE_BYTES || /\0/.test(contents)) throw new Error("ALE exceeds size limit or contains NUL");
  const lines = contents.replace(/^\uFEFF/, "").split(/\r?\n/);
  const headingIndex = lines.findIndex(line => line.trim() === "Heading"), columnIndex = lines.findIndex(line => line.trim() === "Column"), dataIndex = lines.findIndex(line => line.trim() === "Data");
  if (headingIndex !== 0 || columnIndex < headingIndex + 1 || dataIndex < columnIndex + 2) throw new Error("ALE must have ordered Heading, Column and Data sections");
  const columns = lines[columnIndex + 1].split("\t").map(value => boundedText(value.trim(), "ALE column", 64, false));
  if (columns.length > 256 || new Set(columns).size !== columns.length) throw new Error("ALE columns exceed 256 or contain duplicates");
  const headings: Record<string, string> = Object.create(null);
  for (const line of lines.slice(headingIndex + 1, columnIndex)) {
    if (!line.trim()) continue;
    const [key, value, ...extra] = line.split("\t");
    if (extra.length || !/^[A-Z_]{1,64}$/.test(key)) throw new Error("ALE heading is malformed");
    if (Object.keys(headings).length >= 64) throw new Error("ALE heading count exceeds 64");
    headings[key] = boundedText(value, "ALE heading value", 256);
  }
  const rows: Record<string, string>[] = [];
  for (const [offset, line] of lines.slice(dataIndex + 1).entries()) {
    if (!line.trim()) continue;
    if (rows.length >= MAX_INTERCHANGE_ENTRIES) throw new Error("ALE exceeds the 2,000-row limit");
    const cells = line.split("\t");
    if (cells.length !== columns.length) throw new Error(`ALE row ${offset + 1} does not match column count`);
    const row: Record<string, string> = Object.create(null);
    columns.forEach((column, index) => { row[column] = boundedText(cells[index], `ALE ${column}`, 4096); });
    rows.push(row);
  }
  return { format: "ALE", headings, columns, rows, rowCount: rows.length, hostVerified: false };
}

export function previewFacilityMetadataIntake(contents: string, input: unknown) {
  boundJsonTree(input);
  const options = record(input, "intake");
  onlyKeys(options, ["match_column", "column_mapping", "sources"], "intake");
  const table = inspectAle(contents), matchColumn = boundedText(options.match_column, "match_column", 64, false);
  if (!table.columns.includes(matchColumn)) throw new Error("match_column does not exist in ALE");
  const mapping = record(options.column_mapping, "column_mapping");
  if (Object.keys(mapping).length > 256) throw new Error("column_mapping exceeds 256 fields");
  const unsupportedFields: string[] = [];
  for (const [column, field] of Object.entries(mapping)) {
    if (!table.columns.includes(column)) throw new Error(`Mapped column does not exist: ${column}`);
    if (typeof field !== "string" || !FACILITY_FIELDS.includes(field as typeof FACILITY_FIELDS[number])) unsupportedFields.push(column);
  }
  if (new Set(Object.values(mapping)).size !== Object.values(mapping).length) throw new Error("Two columns map to the same metadata field");
  if (!Array.isArray(options.sources) || options.sources.length > MAX_INTERCHANGE_ENTRIES) throw new Error("sources must have at most 2,000 entries");
  const byName = new Map<string, FacilitySource[]>(), ids = new Set<string>();
  for (const raw of options.sources) {
    const source = record(raw, "source");
    onlyKeys(source, ["id", "file_name"], "source");
    const id = boundedText(source.id, "source.id", 512, false), fileName = boundedText(source.file_name, "file_name", 512, false);
    if (ids.has(id)) throw new Error("Duplicate source ID");
    ids.add(id);
    byName.set(fileName, [...(byName.get(fileName) ?? []), { id, file_name: fileName }]);
  }
  const rowNames = new Map<string, number>();
  table.rows.forEach(row => rowNames.set(row[matchColumn], (rowNames.get(row[matchColumn]) ?? 0) + 1));
  const proposals = table.rows.map((row, rowIndex) => {
    const matches = byName.get(row[matchColumn]) ?? [];
    const duplicateRow = (rowNames.get(row[matchColumn]) ?? 0) > 1;
    const status = duplicateRow ? "duplicate_table_key" : matches.length > 1 ? "ambiguous_source" : matches.length === 0 ? "missing_source" : "matched";
    const fields = Object.entries(mapping).filter(([column]) => !unsupportedFields.includes(column)).map(([column, field]) => ({ field, value: row[column] }));
    return { rowIndex, status, candidateIds: matches.map(match => match.id), proposedFields: fields, applicable: status === "matched" && unsupportedFields.length === 0 };
  });
  const binding = createHash("sha256").update(JSON.stringify({ contents, options })).digest("hex");
  return { schemaVersion: "premiere-mcp.facility-intake.v1", binding, columns: table.columns, proposals, unsupportedFields, mutatesProject: false, nextRoute: "Inspect exact source identity, then review each supported named field with manage_metadata_uxp; this preview is not authority to apply writes", packetDumpRequired: false, hostVerified: false };
}

export function buildAle(input: unknown): string {
  boundJsonTree(input);
  const options = record(input, "ALE export");
  onlyKeys(options, ["columns", "rows", "fps"], "ALE export");
  if (!Array.isArray(options.columns) || options.columns.length < 1 || options.columns.length > 256 || new Set(options.columns).size !== options.columns.length) throw new Error("columns must contain 1 through 256 unique column names");
  const columns = options.columns.map(value => boundedText(value, "column", 64, false));
  if (!Array.isArray(options.rows) || options.rows.length > MAX_INTERCHANGE_ENTRIES) throw new Error("rows exceeds 2,000 entries");
  const fps = boundedText(options.fps, "fps", 32, false);
  if (!/^\d{1,3}(\.\d{1,6})?$/.test(fps) || Number(fps) <= 0 || Number(fps) > 240) throw new Error("fps must be a decimal rate from 0 to 240");
  const cell = (value: unknown, label: string) => {
    const text = boundedText(value ?? "", label, 4096);
    if (/[\t\r\n]/.test(text)) throw new Error("ALE cells cannot contain tabs/newlines; use JSON metadata handoff for multiline values");
    return text;
  };
  columns.forEach(column => cell(column, "column"));
  const rows = options.rows.map(value => {
    const row = record(value, "row");
    onlyKeys(row, columns, "ALE row");
    return columns.map(column => cell(row[column], column)).join("\t");
  });
  return `Heading\nFIELD_DELIM\tTABS\nFPS\t${fps}\n\nColumn\n${columns.join("\t")}\n\nData\n${rows.join("\n")}${rows.length ? "\n" : ""}`;
}
