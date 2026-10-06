(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PremiereMcpSlideWorkflows = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // A slide is a narrow three-item trim composition: it moves the center item
  // without changing its source range, then retimes the immediate neighbours
  // to retain both adjacent cuts. It intentionally does not ripple, relink, or
  // infer source handles outside the exact readback below.
  function createSlideWorkflowDefinitions(deps) {
    const ppro = deps.ppro;
    const FrameTime = deps.FrameTime || (typeof require === "function" ? require("./frame-time.cjs") : globalThis.PremiereMcpFrameTime);
    const fallbackTails = new Map();
    const locks = deps.locks && typeof deps.locks.withTrackMutationLock === "function"
      ? deps.locks
      : { withTrackMutationLock: localLock };
    const definitions = {
      "trackItem.slide.inspect": {
        readOnly: true,
        targetCapabilityProbe: true,
        minHostVersion: "25.6.0",
        probe: canUseTrackItemSlide,
        handler: inspectTrackItemSlide
      },
      "trackItem.slide": {
        destructive: true,
        undoable: true,
        idempotent: true,
        targetCapabilityProbe: true,
        minHostVersion: "25.6.0",
        probe: canUseTrackItemSlide,
        handler: slideTrackItem
      }
    };

    function canUseTrackItemSlide() {
      return !!(ppro.Project && typeof ppro.Project.getActiveProject === "function" &&
        ppro.TickTime && typeof ppro.TickTime.createWithSeconds === "function");
    }

    async function inspectTrackItemSlide(args) {
      assertOnlyKeys(args, ["mediaType", "trackIndex", "clipIndex"]);
      return slideSnapshot(await activeTriplet(args, false));
    }

    async function slideTrackItem(args) {
      assertOnlyKeys(args, ["mediaType", "trackIndex", "clipIndex", "expectedSnapshot", "slideBySeconds", "confirmSlide", "operationId"]);
      requireConfirmation(args.confirmSlide);
      requireOperationId(args.operationId);
      const target = targetCoordinates(args);
      const expected = requiredSnapshot(args.expectedSnapshot);
      const requestedOffset = signedOffset(args.slideBySeconds);
      assertExpectedTarget(expected, target);
      const initial = await activeTriplet(target, true);
      const requestedSlide = await sequenceFrameTime(initial.sequence, requestedOffset);
      const offset = requestedSlide.appliedSeconds;
      if (initial.projectGuid !== expected.projectGuid || initial.sequenceId !== expected.sequenceId) {
        throw commandError("UXP_STALE_TRACK_ITEM", "The active project or sequence no longer matches the reviewed slide snapshot");
      }
      const key = initial.projectGuid + "\u0000" + initial.sequenceId + "\u0000" + target.mediaType + "\u0000" + target.trackIndex;
      return locks.withTrackMutationLock(key, async function () {
        // Read the complete affected triplet only after entering the shared
        // track tail. A different operation ID cannot reuse an old snapshot
        // after a preceding slide or source-only slip has committed.
        const context = await activeTriplet(target, true);
        if (context.projectGuid !== expected.projectGuid || context.sequenceId !== expected.sequenceId) {
          throw commandError("UXP_STALE_TRACK_ITEM", "The active project or sequence changed before the slide transaction");
        }
        const before = await slideSnapshot(context);
        if (!sameSnapshot(before, expected, requestedSlide.ticksPerFrame)) {
          throw commandError("UXP_STALE_TRACK_ITEM", "The target or either immediate neighbour changed since the reviewed slide snapshot");
        }
        assertSlideSupported(before);
        const desired = desiredSlide(before, offset);
        let committed = false;
        context.project.lockedAccess(function () {
          if (guidString(context.project.guid) !== before.projectGuid || guidString(context.sequence.guid) !== before.sequenceId) {
            throw commandError("UXP_STALE_TRACK_ITEM", "The reviewed project or sequence changed before slide action creation");
          }
          // Premiere 26.5 applies a timeline end/start action like a trim: the neighbour's
          // source out/in point moves with it. Sending the source actions as well trimmed the
          // neighbours twice, so the source points are only written afterwards when they did
          // not follow the timeline edges.
          const actions = [
            createAction(context.target, "createMoveAction", offset, "center move"),
            createAction(context.previous, "createSetEndAction", desired.previous.endSeconds, "previous timeline end"),
            createAction(context.following, "createSetStartAction", desired.following.startSeconds, "following timeline start")
          ];
          committed = context.project.executeTransaction(function (compoundAction) {
            for (const action of actions) {
              if (compoundAction.addAction(action) === false) {
                throw commandError("UXP_ACTION_REJECTED", "Premiere rejected a slide action");
              }
            }
          }, "Slide timeline item");
        });
        if (!committed) throw commandError("UXP_TRANSACTION_FAILED", "Premiere did not commit the slide transaction");

        let sourceTransaction = false;
        try {
        const edgeContext = await activeTriplet(target, true);
        const edges = await slideSnapshot(edgeContext);
        const previousSource = !numbersEqual(edges.previous.outSeconds, desired.previous.outSeconds);
        const followingSource = !numbersEqual(edges.following.inSeconds, desired.following.inSeconds);
        if (sameIdentity(before, edges) && (previousSource || followingSource)) {
          let sourceCommitted = false;
          edgeContext.project.lockedAccess(function () {
            const sourceActions = [];
            if (previousSource) sourceActions.push(createAction(edgeContext.previous, "createSetOutPointAction", desired.previous.outSeconds, "previous source out"));
            if (followingSource) sourceActions.push(createAction(edgeContext.following, "createSetInPointAction", desired.following.inSeconds, "following source in"));
            sourceCommitted = edgeContext.project.executeTransaction(function (compoundAction) {
              for (const action of sourceActions) {
                if (compoundAction.addAction(action) === false) {
                  throw commandError("UXP_ACTION_REJECTED", "Premiere rejected a slide source action");
                }
              }
            }, "Slide neighbour source points");
          });
          if (!sourceCommitted) throw commandError("UXP_TRANSACTION_FAILED", "Premiere did not commit the slide source-point transaction");
          sourceTransaction = true;
        }
        // Re-resolve all coordinates. A failed postcondition can follow a
        // committed host transaction, so callers must inspect before another
        // mutation if this verification throws.
        const afterContext = await activeTriplet(target, true);
        if (afterContext.projectGuid !== before.projectGuid || afterContext.sequenceId !== before.sequenceId) {
          throw commandError("UXP_VERIFICATION_FAILED", "Premiere changed the active project or sequence during the committed slide");
        }
        const after = await slideSnapshot(afterContext);
        if (!sameSlideResult(before, after, desired, requestedSlide.ticksPerFrame)) {
          throw commandError("UXP_VERIFICATION_FAILED", "Premiere did not retain the requested contiguous three-item slide");
        }
        return {
          slid: true,
          before,
          after,
          slideBySeconds: offset,
          requestedSlideBySeconds: requestedOffset,
          appliedSlideBySeconds: offset,
          outcome: "verified",
          verificationBoundary: "three_track_item_source_and_timeline_readback",
          undoLabel: "Slide timeline item",
          undoSteps: sourceTransaction ? 2 : 1
        };
        } catch (error) {
          return { slid: false, committed: true, verified: false, partial: true,
            outcome: "committed_unverified", before: before, after: null, timelineChanged: null, rollbackPerformed: false,
            undoSteps: sourceTransaction ? 2 : 1,
            requestedSlideBySeconds: requestedOffset, appliedSlideBySeconds: offset,
            verificationBoundary: "committed_transaction_with_failed_readback",
            readbackError: error && error.message ? error.message : String(error),
            nextStep: "Inspect the affected track before any retry. The committed transaction was not rolled back; use Premiere Undo only after reviewing the change." };
        }
      });
    }

    async function activeTriplet(args, requireTransaction) {
      if (!ppro.Project || typeof ppro.Project.getActiveProject !== "function") {
        throw commandError("UXP_COMMAND_UNAVAILABLE", "Premiere project APIs are unavailable");
      }
      const project = await ppro.Project.getActiveProject();
      if (!project) throw commandError("UXP_NO_ACTIVE_PROJECT", "No active project");
      if (requireTransaction && (typeof project.lockedAccess !== "function" || typeof project.executeTransaction !== "function")) {
        throw commandError("UXP_COMMAND_UNAVAILABLE", "This Premiere build does not expose locked undoable transactions");
      }
      if (typeof project.getActiveSequence !== "function") throw commandError("UXP_COMMAND_UNAVAILABLE", "Premiere cannot resolve the active sequence");
      const sequence = await project.getActiveSequence();
      if (!sequence) throw commandError("UXP_NO_ACTIVE_SEQUENCE", "No active sequence");
      const target = targetCoordinates(args), projectGuid = requiredGuid(project.guid, "active project GUID"), sequenceId = requiredGuid(sequence.guid, "active sequence GUID");
      const items = await clipItemsAt(sequence, target);
      if (target.clipIndex < 1 || target.clipIndex + 1 >= items.length) {
        throw commandError("UXP_TARGET_UNSUPPORTED", "A slide requires an immediate previous and following clip on the same track");
      }
      return {
        project, sequence, projectGuid, sequenceId, ...target,
        previous: items[target.clipIndex - 1], target: items[target.clipIndex], following: items[target.clipIndex + 1]
      };
    }

    async function clipItemsAt(sequence, target) {
      const title = target.mediaType === "video" ? "Video" : "Audio";
      const countMethod = "get" + title + "TrackCount", trackMethod = "get" + title + "Track";
      if (typeof sequence[countMethod] !== "function" || typeof sequence[trackMethod] !== "function") {
        throw commandError("UXP_COMMAND_UNAVAILABLE", target.mediaType + " track APIs are unavailable");
      }
      const count = Number(await sequence[countMethod]());
      if (!Number.isSafeInteger(count) || count < 0) throw commandError("UXP_VERIFICATION_FAILED", "Premiere returned an invalid " + target.mediaType + " track count");
      if (target.trackIndex >= count) throw commandError("UXP_TARGET_NOT_FOUND", target.mediaType + " trackIndex is out of range");
      const track = await sequence[trackMethod](target.trackIndex), itemType = ppro.Constants && ppro.Constants.TrackItemType;
      if (!track || !itemType || itemType.CLIP == null || typeof track.getTrackItems !== "function") {
        throw commandError("UXP_COMMAND_UNAVAILABLE", "Clip track-item APIs are unavailable");
      }
      const items = Array.from(await track.getTrackItems(itemType.CLIP, false) || []);
      if (items.length > 512) throw commandError("UXP_TARGET_TOO_LARGE", "The target track has more than 512 clip items");
      return items;
    }

    async function slideSnapshot(context) {
      return {
        projectGuid: context.projectGuid,
        sequenceId: context.sequenceId,
        mediaType: context.mediaType,
        trackIndex: context.trackIndex,
        clipIndex: context.clipIndex,
        previous: await itemSnapshot(context.previous, "previous"),
        target: await itemSnapshot(context.target, "target"),
        following: await itemSnapshot(context.following, "following")
      };
    }

    async function itemSnapshot(item, label) {
      const snapshot = {
        startSeconds: tickSeconds(await requiredMethod(item, "getStartTime")()),
        endSeconds: tickSeconds(await requiredMethod(item, "getEndTime")()),
        inSeconds: tickSeconds(await requiredMethod(item, "getInPoint")()),
        outSeconds: tickSeconds(await requiredMethod(item, "getOutPoint")()),
        durationSeconds: tickSeconds(await requiredMethod(item, "getDuration")()),
        speed: Number(await requiredMethod(item, "getSpeed")()),
        reversed: Boolean(await requiredMethod(item, "isSpeedReversed")())
      };
      for (const key of ["startSeconds", "endSeconds", "inSeconds", "outSeconds", "durationSeconds"]) {
        if (!Number.isFinite(snapshot[key]) || snapshot[key] < 0 || snapshot[key] > 86400) {
          throw commandError("UXP_VERIFICATION_FAILED", "Premiere returned an invalid " + label + " " + key);
        }
      }
      if (!Number.isFinite(snapshot.speed) || snapshot.speed < 0 || snapshot.speed > 100) {
        throw commandError("UXP_VERIFICATION_FAILED", "Premiere returned an invalid " + label + " speed");
      }
      return snapshot;
    }

    function assertSlideSupported(snapshot) {
      for (const label of ["previous", "target", "following"]) {
        const item = snapshot[label];
        if (!numbersEqual(item.speed, 1) || item.reversed || !numbersEqual(item.endSeconds - item.startSeconds, item.durationSeconds) ||
          !numbersEqual(item.outSeconds - item.inSeconds, item.durationSeconds) || item.durationSeconds <= 0) {
          throw commandError("UXP_TARGET_UNSUPPORTED", "Slide only supports contiguous forward 1x items with matching source and timeline durations");
        }
      }
      if (!numbersEqual(snapshot.previous.endSeconds, snapshot.target.startSeconds) || !numbersEqual(snapshot.target.endSeconds, snapshot.following.startSeconds)) {
        throw commandError("UXP_TARGET_UNSUPPORTED", "Slide requires no gap or overlap at either adjacent cut");
      }
    }

    function desiredSlide(before, offset) {
      const previous = { ...before.previous, endSeconds: before.previous.endSeconds + offset, outSeconds: before.previous.outSeconds + offset, durationSeconds: before.previous.durationSeconds + offset };
      const target = { ...before.target, startSeconds: before.target.startSeconds + offset, endSeconds: before.target.endSeconds + offset };
      const following = { ...before.following, startSeconds: before.following.startSeconds + offset, inSeconds: before.following.inSeconds + offset, durationSeconds: before.following.durationSeconds - offset };
      for (const item of [previous, target, following]) {
        for (const key of ["startSeconds", "endSeconds", "inSeconds", "outSeconds"]) {
          if (!Number.isFinite(item[key]) || item[key] < 0 || item[key] > 86400) {
            throw commandError("UXP_TARGET_UNSUPPORTED", "The requested slide exceeds documented timeline or source-time bounds");
          }
        }
      }
      if (previous.endSeconds <= previous.startSeconds || previous.outSeconds <= previous.inSeconds ||
        following.endSeconds <= following.startSeconds || following.outSeconds <= following.inSeconds) {
        throw commandError("UXP_TARGET_UNSUPPORTED", "The requested slide would create a zero- or negative-duration neighbour");
      }
      return { previous, target, following };
    }

    function sameSlideResult(before, after, desired, ticksPerFrame) {
      return sameIdentity(before, after) &&
        sameItem(after.previous, desired.previous, ticksPerFrame) && sameItem(after.target, desired.target, ticksPerFrame) && sameItem(after.following, desired.following, ticksPerFrame) &&
        FrameTime.withinHalfFrame(after.previous.endSeconds, after.target.startSeconds, ticksPerFrame) && FrameTime.withinHalfFrame(after.target.endSeconds, after.following.startSeconds, ticksPerFrame) &&
        numbersEqual(after.previous.endSeconds - after.previous.startSeconds, after.previous.durationSeconds) &&
        numbersEqual(after.target.endSeconds - after.target.startSeconds, after.target.durationSeconds) &&
        numbersEqual(after.following.endSeconds - after.following.startSeconds, after.following.durationSeconds) &&
        numbersEqual(after.previous.outSeconds - after.previous.inSeconds, after.previous.durationSeconds) &&
        numbersEqual(after.target.outSeconds - after.target.inSeconds, after.target.durationSeconds) &&
        numbersEqual(after.following.outSeconds - after.following.inSeconds, after.following.durationSeconds);
    }

    function sameSnapshot(left, right, ticksPerFrame) {
      return sameIdentity(left, right) && sameItem(left.previous, right.previous, ticksPerFrame) && sameItem(left.target, right.target, ticksPerFrame) && sameItem(left.following, right.following, ticksPerFrame);
    }

    function sameIdentity(left, right) {
      return left.projectGuid === right.projectGuid && left.sequenceId === right.sequenceId && left.mediaType === right.mediaType &&
        left.trackIndex === right.trackIndex && left.clipIndex === right.clipIndex;
    }

    function sameItem(left, right, ticksPerFrame) {
      return FrameTime.withinHalfFrame(left.startSeconds, right.startSeconds, ticksPerFrame) && FrameTime.withinHalfFrame(left.endSeconds, right.endSeconds, ticksPerFrame) &&
        FrameTime.withinHalfFrame(left.inSeconds, right.inSeconds, ticksPerFrame) && FrameTime.withinHalfFrame(left.outSeconds, right.outSeconds, ticksPerFrame) &&
        FrameTime.withinHalfFrame(left.durationSeconds, right.durationSeconds, ticksPerFrame) && numbersEqual(left.speed, right.speed) && left.reversed === right.reversed;
    }

    function createAction(item, method, seconds, label) {
      const action = requiredMethod(item, method)(ppro.TickTime.createWithSeconds(seconds));
      if (!action) throw commandError("UXP_ACTION_REJECTED", "Premiere did not create the " + label + " action");
      return action;
    }

    async function sequenceFrameTime(sequence, seconds) {
      const timebase = String(await sequence.getTimebase());
      if (!/^\d{1,18}$/.test(timebase) || BigInt(timebase) <= 0n) throw commandError("UXP_VERIFICATION_FAILED", "Premiere did not return a valid sequence ticksPerFrame timebase");
      return { ...FrameTime.snapSeconds(seconds, timebase), ticksPerFrame: timebase };
    }

    function targetCoordinates(args) {
      return { mediaType: enumValue(args.mediaType, "mediaType", ["video", "audio"]), trackIndex: nonNegativeInt(args.trackIndex, "trackIndex"), clipIndex: nonNegativeInt(args.clipIndex, "clipIndex") };
    }

    function requiredSnapshot(value) {
      assertObject(value, "expectedSnapshot");
      const allowed = ["projectGuid", "sequenceId", "mediaType", "trackIndex", "clipIndex", "previous", "target", "following"];
      assertOnlyKeys(value, allowed);
      for (const key of allowed) if (!(key in value)) throw commandError("UXP_INVALID_ARGUMENT", "expectedSnapshot." + key + " is required");
      return {
        projectGuid: requiredGuid(value.projectGuid, "expectedSnapshot.projectGuid"), sequenceId: requiredGuid(value.sequenceId, "expectedSnapshot.sequenceId"),
        mediaType: enumValue(value.mediaType, "expectedSnapshot.mediaType", ["video", "audio"]), trackIndex: nonNegativeInt(value.trackIndex, "expectedSnapshot.trackIndex"),
        clipIndex: nonNegativeInt(value.clipIndex, "expectedSnapshot.clipIndex"),
        previous: requiredItemSnapshot(value.previous, "expectedSnapshot.previous"), target: requiredItemSnapshot(value.target, "expectedSnapshot.target"), following: requiredItemSnapshot(value.following, "expectedSnapshot.following")
      };
    }

    function requiredItemSnapshot(value, name) {
      assertObject(value, name);
      const allowed = ["startSeconds", "endSeconds", "inSeconds", "outSeconds", "durationSeconds", "speed", "reversed"];
      assertOnlyKeys(value, allowed);
      for (const key of allowed) if (!(key in value)) throw commandError("UXP_INVALID_ARGUMENT", name + "." + key + " is required");
      return {
        startSeconds: boundedSeconds(value.startSeconds, name + ".startSeconds"), endSeconds: boundedSeconds(value.endSeconds, name + ".endSeconds"),
        inSeconds: boundedSeconds(value.inSeconds, name + ".inSeconds"), outSeconds: boundedSeconds(value.outSeconds, name + ".outSeconds"),
        durationSeconds: boundedSeconds(value.durationSeconds, name + ".durationSeconds"), speed: boundedSpeed(value.speed, name + ".speed"), reversed: requiredBoolean(value.reversed, name + ".reversed")
      };
    }

    function assertExpectedTarget(expected, target) {
      if (expected.mediaType !== target.mediaType || expected.trackIndex !== target.trackIndex || expected.clipIndex !== target.clipIndex) {
        throw commandError("UXP_INVALID_ARGUMENT", "expectedSnapshot target coordinates must match mediaType, trackIndex, and clipIndex");
      }
    }

    function signedOffset(value) {
      const offset = Number(value);
      if (!Number.isFinite(offset) || offset < -60 || offset > 60 || numbersEqual(offset, 0)) {
        throw commandError("UXP_INVALID_ARGUMENT", "slideBySeconds must be a non-zero number from -60 to 60");
      }
      return offset;
    }

    function localLock(key, operation) {
      const previous = fallbackTails.get(key) || Promise.resolve();
      let release;
      const gate = new Promise(function (resolve) { release = resolve; });
      const tail = previous.catch(function () { return undefined; }).then(function () { return gate; });
      fallbackTails.set(key, tail);
      return previous.catch(function () { return undefined; }).then(operation).finally(function () {
        release();
        if (fallbackTails.get(key) === tail) fallbackTails.delete(key);
      });
    }

    function requiredMethod(target, name) { if (!target || typeof target[name] !== "function") throw commandError("UXP_COMMAND_UNAVAILABLE", "The timeline item does not expose " + name); return target[name].bind(target); }
    function assertObject(value, name) { if (!value || typeof value !== "object" || Array.isArray(value)) throw commandError("UXP_INVALID_ARGUMENT", name + " must be an object"); }
    function assertOnlyKeys(value, allowed) { assertObject(value, "arguments"); for (const key of Object.keys(value)) if (allowed.indexOf(key) === -1) throw commandError("UXP_INVALID_ARGUMENT", "Unexpected argument: " + key); }
    function enumValue(value, name, allowed) { if (allowed.indexOf(value) === -1) throw commandError("UXP_INVALID_ARGUMENT", name + " must be one of " + allowed.join(", ")); return value; }
    function nonNegativeInt(value, name) { if (!Number.isSafeInteger(value) || value < 0 || value > 511) throw commandError("UXP_INVALID_ARGUMENT", name + " must be an integer from 0 to 511"); return value; }
    function boundedSeconds(value, name) { const seconds = Number(value); if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) throw commandError("UXP_INVALID_ARGUMENT", name + " must be a number from 0 to 86400"); return seconds; }
    function boundedSpeed(value, name) { const speed = Number(value); if (!Number.isFinite(speed) || speed < 0 || speed > 100) throw commandError("UXP_INVALID_ARGUMENT", name + " must be a number from 0 to 100"); return speed; }
    function requiredBoolean(value, name) { if (typeof value !== "boolean") throw commandError("UXP_INVALID_ARGUMENT", name + " must be a boolean"); return value; }
    function requireConfirmation(value) { if (value !== true) throw commandError("UXP_CONFIRMATION_REQUIRED", "trackItem.slide requires confirmSlide: true"); }
    function requireOperationId(value) { if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw commandError("UXP_INVALID_ARGUMENT", "operationId is required and must be 1-128 safe characters"); }
    function requiredGuid(value, name) { const guid = guidString(value); if (!guid || guid.length > 128 || guid.indexOf("\u0000") !== -1) throw commandError("UXP_VERIFICATION_FAILED", name + " is unavailable or invalid"); return guid; }
    function guidString(value) { if (value == null) return ""; try { return typeof value.toString === "function" ? String(value.toString()) : String(value); } catch (_) { return ""; } }
    function tickSeconds(value) { const seconds = value && Number(value.seconds); return Number.isFinite(seconds) ? seconds : null; }
    function numbersEqual(left, right) { return Number.isFinite(Number(left)) && Number.isFinite(Number(right)) && Math.abs(Number(left) - Number(right)) < 0.000001; }
    function commandError(code, message) { const error = new Error(message); error.code = code; return error; }

    return definitions;
  }

  return { createSlideWorkflowDefinitions };
});
