import { buildToolScript, escapeForExtendScript } from "../bridge/script-builder.js";
import { sendCommand, BridgeOptions } from "../bridge/file-bridge.js";

const RANGE_LIMIT = 2000;

type SourceRange = { start_seconds: number; end_seconds: number };
type MapArgs = {
  sequence_id?: string;
  track_type: "video" | "audio";
  track_index: number;
  source_project_item_id?: string;
  media_path?: string;
  ranges: SourceRange[];
  range_offset?: number;
  range_limit?: number;
};

export function getSourceToTimelineTools(bridgeOptions: BridgeOptions) {
  return {
    map_source_ranges_to_timeline: {
      description: "Read-only mapping from source-media time ranges to placements on one sequence track. Reads the selected track once, maps only normal-speed forward clips, reports source portions not present on the track as unplaced, and returns bounded pages. This inspects timeline placement; it does not prove rendered or audible content.",
      parameters: {
        type: "object" as const,
        properties: {
          sequence_id: { type: "string", description: "Sequence name or ID; uses the active sequence when omitted." },
          track_type: { type: "string", enum: ["video", "audio"], description: "Track collection to inspect." },
          track_index: { type: "integer", minimum: 0, description: "Zero-based index within the selected track collection." },
          source_project_item_id: { type: "string", description: "Project item node ID to match. Provide this or media_path." },
          media_path: { type: "string", description: "Exact media path returned by Premiere to match. Provide this or source_project_item_id." },
          ranges: { type: "array", minItems: 1, maxItems: RANGE_LIMIT, items: { type: "object", properties: {
            start_seconds: { type: "number", minimum: 0, description: "Inclusive start in source-media seconds." },
            end_seconds: { type: "number", minimum: 0, description: "Exclusive end in source-media seconds; must exceed start_seconds." },
          }, required: ["start_seconds", "end_seconds"] }, description: `Source-media ranges to map; maximum ${RANGE_LIMIT}.` },
          range_offset: { type: "integer", minimum: 0, description: "Zero-based offset into the input ranges after mapping (default: 0). Follow nextOffset to continue." },
          range_limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum mapped ranges per page (default: 50, maximum: 200). Payload budget may shorten the page." },
        },
        required: ["track_type", "track_index", "ranges"],
      },
      handler: async (args: MapArgs) => {
        if (args.track_type !== "video" && args.track_type !== "audio") throw new Error("track_type must be video or audio");
        if (!Number.isSafeInteger(args.track_index) || args.track_index < 0) throw new Error("track_index must be a nonnegative safe integer");
        if (!!args.source_project_item_id === !!args.media_path) throw new Error("Provide exactly one of source_project_item_id or media_path");
        if (!Array.isArray(args.ranges) || args.ranges.length < 1 || args.ranges.length > RANGE_LIMIT) throw new Error(`ranges must contain 1 to ${RANGE_LIMIT} entries`);
        for (let i = 0; i < args.ranges.length; i++) {
          const range = args.ranges[i];
          if (!range || !Number.isFinite(range.start_seconds) || !Number.isFinite(range.end_seconds) || range.start_seconds < 0 || range.end_seconds <= range.start_seconds) {
            throw new Error(`ranges[${i}] must have finite nonnegative start_seconds and a greater end_seconds`);
          }
        }
        const offset = args.range_offset ?? 0;
        const limit = args.range_limit ?? 50;
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("range_offset must be a nonnegative safe integer");
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("range_limit must be an integer from 1 to 200");

        const seqLookup = args.sequence_id === undefined
          ? "var seq = app.project.activeSequence; if (!seq) return __error('No active sequence');"
          : `var seq = __findSequence("${escapeForExtendScript(args.sequence_id)}"); if (!seq) return __error("Sequence not found");`;
        const sourceId = args.source_project_item_id === undefined ? "" : escapeForExtendScript(args.source_project_item_id);
        const mediaPath = args.media_path === undefined ? "" : escapeForExtendScript(args.media_path);
        const inputRanges = JSON.stringify(args.ranges.map((r) => ({ start: r.start_seconds, end: r.end_seconds })));
        const script = buildToolScript(`
          ${seqLookup}
          var seqId = String(seq.sequenceID);
          var tracks = ${args.track_type === "video" ? "seq.videoTracks" : "seq.audioTracks"};
          if (!tracks || typeof tracks.numTracks !== "number" || ${args.track_index} >= tracks.numTracks) return __error("Track index is outside the selected track collection");
          var track = tracks[${args.track_index}];
          if (!track || !track.clips || typeof track.clips.numItems !== "number") return __error("Premiere did not report the selected track's clips");
          var sourceId = "${sourceId}";
          var wantedPath = "${mediaPath}";
          var inputRanges = ${inputRanges};
          var sorted = [];
          for (var r = 0; r < inputRanges.length; r++) sorted.push({ index: r, start: inputRanges[r].start, end: inputRanges[r].end });
          sorted.sort(function(a, b) { return a.start - b.start || a.end - b.end || a.index - b.index; });
          var results = [];
          var coverage = [];
          var fragments = [];
          for (var ri = 0; ri < inputRanges.length; ri++) coverage[ri] = [];
          for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            if (!clip) return __error("Track contains an unreadable clip; mapping stopped without a partial result");
            var projectItem = null;
            try { projectItem = clip.projectItem; } catch (eItem) { return __error("Cannot determine whether clip " + c + " has a source project item; mapping refused"); }
            if (!projectItem) continue;
            var clipSourceId = "", clipPath = "";
            if (sourceId) {
              var rawSourceId;
              try { rawSourceId = projectItem.nodeId; } catch (eId) { return __error("Cannot read source project item identity for clip " + c + "; mapping refused"); }
              if (rawSourceId === null || rawSourceId === undefined || String(rawSourceId) === "") return __error("Source project item identity is unreadable for clip " + c + "; mapping refused");
              clipSourceId = String(rawSourceId);
              if (clipSourceId !== sourceId) continue;
            } else {
              var rawPath;
              try { rawPath = projectItem.getMediaPath(); } catch (ePath) { return __error("Cannot read source media path for clip " + c + "; mapping refused"); }
              if (typeof rawPath !== "string" || !rawPath) return __error("Source media path is unreadable for clip " + c + "; mapping refused");
              clipPath = rawPath;
              if (clipPath !== wantedPath) continue;
            }
            var speed, reversed;
            try {
              speed = clip.getSpeed();
              reversed = clip.isSpeedReversed();
            } catch (eSpeed) { return __error("Cannot verify speed/reverse state for matching clip " + c + "; mapping refused"); }
            if (typeof speed !== "number" || !isFinite(speed) || Math.abs(speed - 1) >= 0.0001 || !(reversed === false || reversed === true || reversed === 0 || reversed === 1) || reversed === true || reversed === 1) {
              return __error("Matching clip " + c + " has non-1x or reversed playback; source-to-timeline mapping refused");
            }
            var startTicks = parseFloat(clip.start && clip.start.ticks), endTicks = parseFloat(clip.end && clip.end.ticks);
            var inTicks = parseFloat(clip.inPoint && clip.inPoint.ticks), outTicks = parseFloat(clip.outPoint && clip.outPoint.ticks);
            if (!isFinite(startTicks) || !isFinite(endTicks) || !isFinite(inTicks) || !isFinite(outTicks) || endTicks <= startTicks || outTicks <= inTicks) return __error("Matching clip " + c + " has unreadable or invalid timing");
            var timelineDuration = (endTicks - startTicks) / TICKS_PER_SECOND;
            var sourceDuration = (outTicks - inTicks) / TICKS_PER_SECOND;
            if (Math.abs(timelineDuration - sourceDuration) > 0.000001) return __error("Matching clip " + c + " has inconsistent source and timeline duration; mapping refused");
            var clipIn = inTicks / TICKS_PER_SECOND, clipOut = outTicks / TICKS_PER_SECOND;
            var lo = 0, hi = sorted.length;
            while (lo < hi) { var mid = Math.floor((lo + hi) / 2); if (sorted[mid].end <= clipIn) lo = mid + 1; else hi = mid; }
            var nodeId = "";
            try { nodeId = String(clip.nodeId); } catch (eNode) {}
            if (!nodeId) return __error("Matching clip " + c + " has no readable nodeId");
            for (var si = lo; si < sorted.length && sorted[si].start < clipOut; si++) {
              var overlapStart = Math.max(sorted[si].start, clipIn);
              var overlapEnd = Math.min(sorted[si].end, clipOut);
              if (overlapEnd <= overlapStart) continue;
              var mappedStart = startTicks / TICKS_PER_SECOND + overlapStart - clipIn;
              var mappedEnd = startTicks / TICKS_PER_SECOND + overlapEnd - clipIn;
              fragments.push({ inputIndex: sorted[si].index, timelineStartSeconds: mappedStart, timelineEndSeconds: mappedEnd, clipNodeId: nodeId });
              coverage[sorted[si].index].push({ start: overlapStart, end: overlapEnd });
            }
          }
          for (var i = 0; i < inputRanges.length; i++) {
            var pieces = coverage[i];
            pieces.sort(function(a, b) { return a.start - b.start || a.end - b.end; });
            var merged = [];
            for (var p = 0; p < pieces.length; p++) {
              var last = merged.length ? merged[merged.length - 1] : null;
              if (last && pieces[p].start <= last.end) last.end = Math.max(last.end, pieces[p].end);
              else merged.push({ start: pieces[p].start, end: pieces[p].end });
            }
            var unplaced = [], cursor = inputRanges[i].start;
            for (var m = 0; m < merged.length; m++) {
              if (merged[m].start > cursor) unplaced.push({ startSeconds: cursor, endSeconds: merged[m].start });
              if (merged[m].end > cursor) cursor = merged[m].end;
            }
            if (cursor < inputRanges[i].end) unplaced.push({ startSeconds: cursor, endSeconds: inputRanges[i].end });
            results.push({ inputIndex: i, sourceStartSeconds: inputRanges[i].start, sourceEndSeconds: inputRanges[i].end, fragments: [], unplaced: unplaced });
          }
          fragments.sort(function(a, b) {
            if (a.inputIndex !== b.inputIndex) return a.inputIndex - b.inputIndex;
            if (a.timelineStartSeconds !== b.timelineStartSeconds) return a.timelineStartSeconds - b.timelineStartSeconds;
            if (a.clipNodeId < b.clipNodeId) return -1;
            if (a.clipNodeId > b.clipNodeId) return 1;
            return 0;
          });
          for (var f = 0; f < fragments.length; f++) results[fragments[f].inputIndex].fragments.push({ timelineStartSeconds: fragments[f].timelineStartSeconds, timelineEndSeconds: fragments[f].timelineEndSeconds, clipNodeId: fragments[f].clipNodeId });
          var page = [], chars = 0, returned = 0, blocked = false;
          for (var q = ${offset}; q < results.length && returned < ${limit}; q++) {
            var itemSize = __jsonStringify(results[q]).length;
            if (chars + itemSize > 40000) { blocked = true; if (returned === 0) return __error("One mapped range exceeds the bounded payload budget. Split that source range into smaller intervals."); break; }
            page.push(results[q]); chars += itemSize; returned++;
          }
          var next = ${offset} + returned;
          var truncated = next < results.length;
          var response = { sequenceId: seqId, trackType: "${args.track_type}", trackIndex: ${args.track_index}, sourceProjectItemId: sourceId || null, mediaPath: sourceId ? null : wantedPath,
            ranges: page, pagination: { totalRanges: results.length, offset: ${offset}, limit: ${limit}, returned: returned, truncated: truncated, nextOffset: truncated ? next : null, payloadBudgetCharacters: 40000 } };
          var serialized = __result(response);
          if (serialized.length > 60000) return __error("Mapped page exceeds the transport payload budget. Reduce range_limit or split source ranges.");
          return serialized;
        `);
        return sendCommand(script, bridgeOptions);
      },
    },
  };
}
