import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, existsSync, lstatSync, fstatSync, openSync, closeSync, linkSync, unlinkSync } from "node:fs";
import { dirname, extname, isAbsolute, join } from "node:path";
import { currentInvocation, assertInvocationNotCancelled } from "./invocation-context.js";

const run = promisify(execFile);
const MAX_REVIEW_BYTES = 128 * 1024 * 1024;
export interface ArtifactSnapshot { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
const sameIdentity = (left: ArtifactSnapshot, right: ArtifactSnapshot) => left.dev === right.dev && left.ino === right.ino;
const sameContents = (left: ArtifactSnapshot, right: ArtifactSnapshot) => sameIdentity(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs;
const sameSnapshot = (left: ArtifactSnapshot, right: ArtifactSnapshot) => sameContents(left, right) && left.ctimeMs === right.ctimeMs;

/** Pin a regular, non-symlink file before composing evidence from multiple readers. */
export function snapshotArtifact(path: string, label = "ARTIFACT_SOURCE", maximumBytes = Number.MAX_SAFE_INTEGER): ArtifactSnapshot {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || !Number.isSafeInteger(stats.size) || stats.size <= 0 || stats.size > maximumBytes) throw new Error(`${label}_INVALID: require a non-empty regular file within the byte limit`);
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
}
export function assertArtifactUnchanged(path: string, expected: ArtifactSnapshot, label = "ARTIFACT_SOURCE"): void {
  let current: ArtifactSnapshot;
  try { current = snapshotArtifact(path, label); } catch { throw new Error(`${label}_CHANGED: file disappeared or changed type`); }
  if (!sameSnapshot(expected, current)) throw new Error(`${label}_CHANGED: identity or contents changed between evidence stages`);
}
/** Hash one pinned descriptor with bounded memory; growth and replacement fail closed. */
export async function hashStableArtifact(path: string, expected: ArtifactSnapshot, label = "ARTIFACT_SOURCE"): Promise<string> {
  assertInvocationNotCancelled();
  assertArtifactUnchanged(path, expected, label);
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameSnapshot(expected, fstatSync(descriptor))) throw new Error(`${label}_CHANGED: file changed before checksum read`);
    const hash = createHash("sha256"); let bytes = 0;
    for await (const chunk of createReadStream(path, { fd: descriptor, autoClose: false, highWaterMark: 64 * 1024, signal: currentInvocation()?.signal })) {
      assertInvocationNotCancelled();
      bytes += chunk.length;
      if (bytes > expected.size) throw new Error(`${label}_CHANGED: file grew during checksum read`);
      hash.update(chunk);
    }
    if (bytes !== expected.size || !sameSnapshot(expected, fstatSync(descriptor))) throw new Error(`${label}_CHANGED: file changed during checksum read`);
    assertArtifactUnchanged(path, expected, label);
    return hash.digest("hex");
  } finally { closeSync(descriptor); }
}
/** Publish the exact measured inode without replacing a concurrent destination. */
export async function publishArtifactExclusive(staging: string, output: string, staged: ArtifactSnapshot, sha256: string): Promise<ArtifactSnapshot> {
  assertInvocationNotCancelled();
  assertArtifactUnchanged(staging, staged, "REVIEW_PUBLICATION");
  linkSync(staging, output);
  try {
    // Our hardlink changes ctime. Require its new shared snapshot and checksum.
    const published = snapshotArtifact(output, "REVIEW_PUBLICATION", staged.size);
    if (!sameContents(staged, published)) throw new Error("REVIEW_PUBLICATION_CHANGED: linked output is not the measured artifact");
    assertArtifactUnchanged(staging, published, "REVIEW_PUBLICATION");
    if (await hashStableArtifact(output, published, "REVIEW_PUBLICATION") !== sha256) throw new Error("REVIEW_PUBLICATION_CHANGED: linked output checksum changed");
    assertArtifactUnchanged(output, published, "REVIEW_PUBLICATION");
    return published;
  } catch (error) {
    try { if (sameIdentity(staged, lstatSync(output))) unlinkSync(output); } catch { /* preserve another writer's replacement */ }
    throw error;
  }
}
/** Remove only the staging inode measured for this request. */
export function removeOwnedStaging(path: string, expected?: ArtifactSnapshot): void {
  try { if (expected && sameIdentity(expected, lstatSync(path))) unlinkSync(path); } catch { /* no unrelated cleanup */ }
}
/** Create-only, bounded review excerpt; no delivery output is overwritten. */
export async function createReviewClip(input: string, output: string, start: number, duration: number) {
  if (!isAbsolute(input) || !isAbsolute(output) || extname(output).toLowerCase() !== ".mp4" || existsSync(output)) throw new Error("REVIEW_CLIP_PATH: choose an existing absolute input and a new .mp4 destination");
  if (!Number.isFinite(start) || start < 0 || start > 86400 || !Number.isFinite(duration) || duration <= 0 || duration > 30) throw new Error("REVIEW_CLIP_RANGE: start must be 0..86400 and duration >0..30 seconds");
  const before = snapshotArtifact(input, "REVIEW_CLIP_INPUT");
  // Windows change timestamps can remain unchanged after an in-place write and
  // restored mtime. Pin content as well as metadata before reading the source.
  const sourceSha256 = await hashStableArtifact(input, before, "REVIEW_CLIP_SOURCE");
  const staging = join(dirname(output), `.mcp-review-${randomUUID()}.mp4`);
  let staged: ArtifactSnapshot | undefined;
  let linked = false;
  try {
    assertInvocationNotCancelled();
    await run("ffmpeg", ["-nostdin", "-v", "error", "-n", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,avi,mpegts,mxf", "-ss", String(start), "-i", input, "-t", String(duration), "-map", "0:v:0", "-map", "0:a?", "-vf", "scale=960:540:force_original_aspect_ratio=decrease", "-c:v", "libx264", "-preset", "fast", "-crf", "22", "-c:a", "aac", "-movflags", "+faststart", "-fs", String(MAX_REVIEW_BYTES), staging], {timeout:60000,maxBuffer:1024*1024,signal:currentInvocation()?.signal});
    staged = snapshotArtifact(staging, "REVIEW_CLIP_STAGING", MAX_REVIEW_BYTES);
    assertArtifactUnchanged(input, before, "REVIEW_CLIP_SOURCE");
    const measured = JSON.parse((await run("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", staging], {timeout:30000,maxBuffer:1024*1024,signal:currentInvocation()?.signal})).stdout);
    const video = measured.streams?.find((stream: {codec_type:string}) => stream.codec_type === "video");
    if (!video || !Number.isSafeInteger(Number(video.nb_read_frames)) || Number(video.nb_read_frames) < 2 || !Number.isFinite(Number(measured.format?.duration)) || Number(measured.format.duration) <= 0) throw new Error("REVIEW_CLIP_EMPTY: requested range produced no reviewable video");
    assertArtifactUnchanged(input, before, "REVIEW_CLIP_SOURCE");
    assertArtifactUnchanged(staging, staged, "REVIEW_CLIP_STAGING");
    const sha256 = await hashStableArtifact(staging, staged, "REVIEW_CLIP_STAGING");
    assertInvocationNotCancelled();
    if (await hashStableArtifact(input, before, "REVIEW_CLIP_SOURCE") !== sourceSha256) throw new Error("REVIEW_CLIP_SOURCE_CHANGED: source checksum changed during encoding");
    const published = await publishArtifactExclusive(staging, output, staged, sha256);
    linked = true;
    if (await hashStableArtifact(input, before, "REVIEW_CLIP_SOURCE") !== sourceSha256) throw new Error("REVIEW_CLIP_SOURCE_CHANGED: source checksum changed during publication");
    assertArtifactUnchanged(output, published, "REVIEW_CLIP_PUBLICATION");
    return {path:output,sha256,sourceSha256,bytes:staged.size,requestedStartSeconds:start,requestedDurationSeconds:duration,observedDurationSeconds:Number(measured.format.duration),decodedFrames:Number(video.nb_read_frames),renderVerified:false,verificationScope:"Decoded local review excerpt with stable source checksum; visual comparison, audio quality and Premiere lineage remain unverified"};
  } catch (error) {
    if (linked && staged) { try { if (sameIdentity(staged, lstatSync(output))) unlinkSync(output); } catch { /* never remove a replacement owned by another writer */ } }
    throw error;
  } finally { removeOwnedStaging(staging, staged); }
}
