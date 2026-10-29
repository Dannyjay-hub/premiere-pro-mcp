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
export function sequenceReadScript(args: SequenceReadArgs = {}, includeSync = false): string {
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
    ${includeSync ? "var __readPageIds = {};" : ""}
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
      ${includeSync ? 'if (value.nodeId !== undefined && value.nodeId !== null) __readPageIds["$" + String(value.nodeId)] = true;' : ""}
    }
    ${includeSync ? SEQUENCE_SYNC_READ_SCRIPT : ""}
    function __readResult(value) {
      ${includeSync ? "var sync = __readSync(seq); value.syncWarnings = sync.warnings; value.syncCheck = sync.check;" : ""}
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

// Source alignment is a bounded heuristic, not playback or rendered-sync proof.
const SEQUENCE_SYNC_READ_SCRIPT = `
    function __readSync(sequence) {
      var warnings = [], entries = [], byId = {}, sourceCache = {}, groups = {}, seenPairs = {};
      var maxClips = 10000, maxLinks = 200, maxPairs = 4000, maxWarnings = 25, maxWarningChars = 10000;
      var identityChars = 0, warningChars = 0, comparedPairs = 0, skippedClips = 0, skippedPairs = 0;
      var ambiguousMatches = 0, unreadableLinks = 0, unknownSources = 0, warningsTruncated = false, scanTruncated = false;
      var frameTicks = NaN;
      function ticks(raw) {
        if (typeof raw !== "string" && typeof raw !== "number") return NaN;
        var text = String(raw);
        if (!/^-?[0-9]+$/.test(text)) return NaN;
        var value = Number(text);
        return isFinite(value) && Math.abs(value) <= 9007199254740991 && Math.floor(value) === value ? value : NaN;
      }
      function count(raw) { return typeof raw === "number" && isFinite(raw) && raw >= 0 && Math.floor(raw) === raw ? raw : NaN; }
      try { frameTicks = ticks(sequence.timebase); } catch (frameError) {}
      var check = {
        scope: "Heuristic source-time alignment for pairs touching returned clips only; no playback, rendered sync, or complete-sequence sync verification. Linked clips may intentionally use different source origins.",
        frameTicks: isFinite(frameTicks) && frameTicks > 0 ? String(frameTicks) : null,
        status: "partial", scannedClips: 0, comparedPairs: 0, skippedClips: 0, skippedPairs: 0,
        ambiguousMatches: 0, unreadableLinks: 0, unknownSources: 0, truncated: false,
        maxScannedClips: maxClips, maxLinkedItemsPerClip: maxLinks, maxComparedPairs: maxPairs, maxWarnings: maxWarnings
      };
      if (!isFinite(frameTicks) || frameTicks <= 0) { check.status = "unavailable"; check.reason = "The sequence frame grid is unreadable; source alignment was not checked."; return { warnings: warnings, check: check }; }
      function source(clip) {
        try {
          var item = clip.projectItem;
          if (!item) return null;
          var id = typeof item.nodeId === "string" && item.nodeId.length > 0 && item.nodeId.length <= 512 ? item.nodeId : "";
          if (id && sourceCache["$" + id] !== undefined) return sourceCache["$" + id];
          var path = "";
          try { if (typeof item.getMediaPath === "function") path = item.getMediaPath(); } catch (pathError) {}
          var identity = typeof path === "string" && path.length > 0 && path.length <= 4096 ? "path:" + path : (id ? "item:" + id : null);
          if (identity) {
            identityChars += identity.length;
            if (identityChars > 2000000) { scanTruncated = true; identity = null; }
          }
          if (id) sourceCache["$" + id] = identity;
          return identity;
        } catch (sourceError) { return null; }
      }
      function collect(tracks, type) {
        var trackCount = count(tracks.numTracks);
        if (!isFinite(trackCount) || trackCount > maxClips) { scanTruncated = true; return; }
        for (var t = 0; t < trackCount; t++) {
          var track = tracks[t], clips = track.clips, clipCount = count(clips.numItems);
          if (!isFinite(clipCount)) { scanTruncated = true; continue; }
          for (var c = 0; c < clipCount; c++) {
            if (check.scannedClips >= maxClips) { scanTruncated = true; return; }
            check.scannedClips++;
            try {
              var clip = clips[c];
              var id = clip.nodeId;
              if (typeof id !== "string" || id.length === 0 || id.length > 512 || byId["$" + id]) { skippedClips++; continue; }
              var start = ticks(clip.start.ticks), inside = ticks(clip.inPoint.ticks);
              if (!isFinite(start) || !isFinite(inside) || !isFinite(inside - start)) { skippedClips++; continue; }
              var identity = source(clip);
              if (!identity) unknownSources++;
              var entry = { id: id, clip: clip, type: type, track: t, start: start, inside: inside, source: identity };
              entries.push(entry); byId["$" + id] = entry;
              if (identity) {
                var key = "$" + String(start) + ":" + identity;
                var group = groups[key];
                if (!group) { group = { video: null, audio: null, videoCount: 0, audioCount: 0 }; groups[key] = group; }
                group[type] = entry; group[type + "Count"]++;
              }
            } catch (clipError) { skippedClips++; }
          }
        }
      }
      try { collect(sequence.videoTracks, "video"); collect(sequence.audioTracks, "audio"); }
      catch (collectionError) { scanTruncated = true; }
      function compare(left, right, basis) {
        var video = left.type === "video" ? left : right, audio = left.type === "audio" ? left : right;
        var key = "$" + video.id.length + ":" + video.id + audio.id;
        if (seenPairs[key]) return;
        if (comparedPairs >= maxPairs) { scanTruncated = true; return; }
        seenPairs[key] = true; comparedPairs++;
        var drift = (audio.inside - audio.start) - (video.inside - video.start);
        if (!isFinite(drift) || Math.abs(drift) > 9007199254740991) { skippedPairs++; return; }
        if (Math.abs(drift) < frameTicks) return;
        var warning = {
          code: "SOURCE_ALIGNMENT_DIFFERENCE", basis: basis,
          videoNodeId: video.id, videoTrackIndex: video.track, audioNodeId: audio.id, audioTrackIndex: audio.track,
          videoInTicks: String(video.inside), audioInTicks: String(audio.inside),
          videoStartTicks: String(video.start), audioStartTicks: String(audio.start),
          videoInSeconds: video.inside / TICKS_PER_SECOND, audioInSeconds: audio.inside / TICKS_PER_SECOND,
          sourceAlignmentDeltaTicks: String(drift), sourceAlignmentDeltaSeconds: drift / TICKS_PER_SECOND,
          sourceAlignmentDeltaFrames: drift / frameTicks,
          sameSourceMedia: video.source && audio.source ? video.source === audio.source : null
        };
        var size = __jsonStringify(warning).length;
        if (warnings.length >= maxWarnings || warningChars + size > maxWarningChars) { warningsTruncated = true; return; }
        warnings.push(warning); warningChars += size;
      }
      for (var e = 0; e < entries.length; e++) {
        var entry = entries[e];
        if (!__readPageIds["$" + entry.id]) continue;
        var linked = null, linkedCount = 0, hasLinkedPartner = false, unresolvedLinked = false;
        try {
          if (typeof entry.clip.getLinkedItems === "function") {
            linked = entry.clip.getLinkedItems();
            if (linked) {
              linkedCount = count(linked.numItems === undefined ? linked.length : linked.numItems);
              if (!isFinite(linkedCount)) { unreadableLinks++; unresolvedLinked = true; linkedCount = 0; }
              if (linkedCount > maxLinks) { scanTruncated = true; unresolvedLinked = true; linkedCount = maxLinks; }
            }
          } else unreadableLinks++;
        } catch (linkedError) { unreadableLinks++; unresolvedLinked = true; }
        for (var l = 0; l < linkedCount; l++) {
          try {
            var partner = byId["$" + String(linked[l].nodeId)];
            if (!partner) { skippedPairs++; unresolvedLinked = true; continue; }
            if (partner.type === entry.type) continue;
            hasLinkedPartner = true;
            compare(entry, partner, "linked");
          } catch (partnerError) { skippedPairs++; unresolvedLinked = true; }
        }
        if (!hasLinkedPartner && !unresolvedLinked && entry.source) {
          var group = groups["$" + String(entry.start) + ":" + entry.source];
          if (group && group.videoCount > 0 && group.audioCount > 0) {
            if (group.videoCount === 1 && group.audioCount === 1) compare(group.video, group.audio, "same_source_same_start");
            else ambiguousMatches++;
          }
        }
      }
      check.comparedPairs = comparedPairs; check.skippedClips = skippedClips; check.skippedPairs = skippedPairs;
      check.ambiguousMatches = ambiguousMatches; check.unreadableLinks = unreadableLinks; check.unknownSources = unknownSources;
      check.truncated = scanTruncated || warningsTruncated; check.warningsTruncated = warningsTruncated;
      check.status = check.truncated || skippedClips || skippedPairs || ambiguousMatches || unreadableLinks || unknownSources ? "partial" : "page_scoped";
      return { warnings: warnings, check: check };
    }
`;
