/** Shared bounds for CEP sequence reads. Paging order is video, then audio, track/index order. */
export interface SequenceReadArgs {
  track_type?: string; track_index?: number; start_seconds?: number; end_seconds?: number;
  clip_offset?: number; clip_limit?: number;
}
export const sequenceReadProperties = {
  track_type: { type: "string", enum: ["video", "audio", "both"], description: "Track type to page (default: both). Track counts remain available." },
  track_index: { type: "integer", minimum: 0, description: "Optional zero-based track index within each selected type." },
  start_seconds: { type: "number", minimum: 0, description: "Optional inclusive window start; returns overlapping items." },
  end_seconds: { type: "number", minimum: 0, description: "Optional exclusive window end; must exceed start_seconds." },
  clip_offset: { type: "integer", minimum: 0, description: "Offset into matching clips (matching gaps for get_timeline_gaps), video before audio (default: 0)." },
  clip_limit: { type: "integer", minimum: 1, maximum: 200, description: "Page size (default: 50, maximum: 200). Payload budget may shorten a page. Inspect nextOffset." },
};
export function sequenceReadScript(args: SequenceReadArgs = {}): string {
  const type = args.track_type ?? "both", offset = args.clip_offset ?? 0, limit = args.clip_limit ?? 50;
  if (!["video", "audio", "both"].includes(type)) throw new Error("track_type must be video, audio, or both");
  for (const [name, value] of [["track_index", args.track_index], ["clip_offset", offset], ["clip_limit", limit]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < (name === "clip_limit" ? 1 : 0))) throw new Error(`${name} must be a nonnegative safe integer (clip_limit must be positive)`);
  }
  if (limit > 200) throw new Error("clip_limit must be at most 200");
  for (const [name, value] of [["start_seconds", args.start_seconds], ["end_seconds", args.end_seconds]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error(`${name} must be a finite nonnegative number`);
  }
  if (args.end_seconds !== undefined && args.end_seconds <= (args.start_seconds ?? 0)) throw new Error("end_seconds must exceed start_seconds");
  return `
    var __readTotalClips = 0, __readMatched = 0, __readReturned = 0, __readChars = 0, __readBlocked = false, __readError = null;
    function __readTrack(type, index) { return (${JSON.stringify(type)} === "both" || ${JSON.stringify(type)} === type) && ${args.track_index === undefined ? "true" : `index === ${args.track_index}`}; }
    function __readWindow(start, end) { return end > ${args.start_seconds ?? -1} && ${args.end_seconds === undefined ? "true" : `start < ${args.end_seconds}`}; }
    function __readInclude(clip, type, index) {
      __readTotalClips++;
      if (!__readTrack(type, index) || !__readWindow(__ticksToSeconds(clip.start.ticks), __ticksToSeconds(clip.end.ticks))) return false;
      var ordinal = __readMatched++;
      return ordinal >= ${offset} && __readReturned < ${limit} && !__readBlocked;
    }
    function __readPush(array, value) {
      var size = __jsonStringify(value).length;
      if (__readChars + size > 40000) {
        __readBlocked = true;
        if (__readReturned === 0) __readError = "One item exceeds the sequence page budget. Use a narrower clip inspection.";
        return;
      }
      array.push(value); __readReturned++; __readChars += size;
    }
    function __readResult(value) {
      var serialized = __result(value);
      if (serialized.length > 60000) return __error("Sequence page exceeds the bounded payload budget. Reduce clip_limit or narrow track/time filters; inspect markers and transitions separately.");
      return serialized;
    }
    function __readReceipt() {
      var truncated = __readMatched > ${offset} + __readReturned;
      return { totalClips: __readTotalClips, matchingCount: __readMatched, returned: __readReturned, truncated: truncated,
        nextOffset: truncated ? ${offset} + __readReturned : null, offset: ${offset}, limit: ${limit}, order: "video_then_audio_track_index", payloadBudgetCharacters: 40000 };
    }
  `;
}
