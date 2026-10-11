import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { BridgeOptions } from "../bridge/file-bridge.js";
import { boundJsonTree, boundedText, onlyKeys, record } from "../interchange/bounded-file.js";

const execute = promisify(execFile);
const LOCAL_INPUT_PROTOCOLS = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,mxf,avi,mpegts,mpegvideo"];
export interface TemporalVideoSample { seconds: number; mean_rgb: number[]; max_error: number; region?: { x: number; y: number; width: number; height: number } }
export interface TemporalAudioSample { seconds: number; duration_seconds: number; rms_min: number; rms_max: number }
export interface TemporalRenderRequest {
  path: string;
  fixture_id: string;
  fixture_sha256: string;
  samples: TemporalVideoSample[];
  audio_samples?: TemporalAudioSample[];
  duration_seconds: number;
  duration_tolerance_seconds?: number;
  host?: { premiere_build: string; os: "Windows" | "macOS"; locale: string; backend: "cep" | "uxp"; panel_sha256: string; server_commit: string; client_version: string; capability_ids: string[] };
}
export type TemporalRunner = (program: string, args: string[], options: { encoding?: "buffer"; timeout: number; maxBuffer: number; windowsHide: true }) => Promise<{ stdout: string | Buffer }>;
const defaultRunner: TemporalRunner = async (program, args, options) => execute(program, args, options) as unknown as Promise<{ stdout: string | Buffer }>;
function boundedNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be finite from ${min} through ${max}`);
  return value;
}
function hash(value: unknown, label: string, length = 64): string {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`).test(value)) throw new Error(`${label} must be a lowercase ${length}-character hex hash`);
  return value;
}
export function validateTemporalRenderRequest(input: unknown): TemporalRenderRequest {
  boundJsonTree(input);
  const request = record(input, "temporal render") as unknown as TemporalRenderRequest;
  onlyKeys(request as unknown as Record<string, unknown>, ["path", "fixture_id", "fixture_sha256", "samples", "audio_samples", "duration_seconds", "duration_tolerance_seconds", "host"], "temporal render");
  const path = boundedText(request.path, "path", 4096, false);
  if (!isAbsolute(path)) throw new Error("path must be absolute");
  boundedText(request.fixture_id, "fixture_id", 64, false);
  hash(request.fixture_sha256, "fixture_sha256");
  boundedNumber(request.duration_seconds, "duration_seconds", 0.01, 60);
  boundedNumber(request.duration_tolerance_seconds ?? 0.05, "duration_tolerance_seconds", 0, 1);
  if (!Array.isArray(request.samples) || request.samples.length < 2 || request.samples.length > 32) throw new Error("samples must contain 2 through 32 temporal checks; a still cannot validate animation");
  const times = new Set<number>();
  for (const raw of request.samples) {
    const sample = record(raw, "sample");
    onlyKeys(sample, ["seconds", "mean_rgb", "max_error", "region"], "sample");
    const time = boundedNumber(sample.seconds, "sample.seconds", 0, request.duration_seconds);
    if (time === request.duration_seconds || times.has(time)) throw new Error("Sample times must be unique and before the exclusive artifact end");
    times.add(time);
    if (!Array.isArray(sample.mean_rgb) || sample.mean_rgb.length !== 3) throw new Error("mean_rgb must contain three values");
    sample.mean_rgb.forEach(value => boundedNumber(value, "mean_rgb", 0, 255));
    boundedNumber(sample.max_error, "max_error", 0, 64);
    if (sample.region !== undefined) {
      const region = record(sample.region, "sample.region");
      onlyKeys(region, ["x", "y", "width", "height"], "sample.region");
      for (const key of ["x", "y", "width", "height"]) if (!Number.isSafeInteger(region[key]) || (region[key] as number) < (key === "x" || key === "y" ? 0 : 1) || (region[key] as number) > 8192) throw new Error("region must use bounded integer pixel coordinates with positive dimensions");
    }
  }
  if (request.audio_samples !== undefined) {
    if (!Array.isArray(request.audio_samples) || request.audio_samples.length > 32) throw new Error("audio_samples exceeds 32 checks");
    for (const raw of request.audio_samples) {
      const sample = record(raw, "audio_sample");
      onlyKeys(sample, ["seconds", "duration_seconds", "rms_min", "rms_max"], "audio_sample");
      const start = boundedNumber(sample.seconds, "audio.seconds", 0, request.duration_seconds), duration = boundedNumber(sample.duration_seconds, "audio.duration_seconds", 0.01, 1);
      if (start + duration > request.duration_seconds) throw new Error("Audio window exceeds artifact duration");
      const min = boundedNumber(sample.rms_min, "rms_min", 0, 1), max = boundedNumber(sample.rms_max, "rms_max", 0, 1);
      if (max < min) throw new Error("rms_max must be at least rms_min");
    }
  }
  if (request.host !== undefined) {
    const host = record(request.host, "host");
    onlyKeys(host, ["premiere_build", "os", "locale", "backend", "panel_sha256", "server_commit", "client_version", "capability_ids"], "host");
    boundedText(host.premiere_build, "premiere_build", 64, false); boundedText(host.locale, "locale", 32, false); boundedText(host.client_version, "client_version", 64, false);
    if (!["Windows", "macOS"].includes(host.os as string) || !["cep", "uxp"].includes(host.backend as string)) throw new Error("host OS/backend is unsupported");
    hash(host.panel_sha256, "panel_sha256"); hash(host.server_commit, "server_commit", 40);
    if (!Array.isArray(host.capability_ids) || host.capability_ids.length > 256 || new Set(host.capability_ids).size !== host.capability_ids.length) throw new Error("capability_ids must be unique and bounded");
    host.capability_ids.forEach(value => { if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error("capability_id is invalid"); });
  }
  return request;
}

async function artifactHash(path: string): Promise<string> {
  const hasher = createHash("sha256");
  for await (const chunk of createReadStream(path)) hasher.update(chunk);
  return hasher.digest("hex");
}

/** Actual exported video/audio pixels, not property readback or a QE still. */
export async function verifyTemporalRenderArtifact(input: unknown, run: TemporalRunner = defaultRunner) {
  const request = validateTemporalRenderRequest(input), before = statSync(request.path);
  if (!before.isFile() || before.size <= 0 || before.size > 1024 * 1024 * 1024) throw new Error("Temporal artifact must be a nonempty regular file no larger than 1 GiB");
  const probe = await run("ffprobe", ["-v", "error", ...LOCAL_INPUT_PROTOCOLS, "-count_frames", "-show_entries", "format=duration:stream=codec_type,nb_read_frames,width,height,sample_rate,channels", "-of", "json", request.path], { timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true });
  const metadata = record(JSON.parse(String(probe.stdout)), "ffprobe metadata"), streams = metadata.streams;
  if (!Array.isArray(streams) || streams.length > 64) throw new Error("Invalid ffprobe stream list");
  const video = streams.find(value => record(value, "stream").codec_type === "video");
  if (!video || !Number.isSafeInteger(Number(video.nb_read_frames)) || Number(video.nb_read_frames) < 2 || Number(video.nb_read_frames) > 14_400) throw new Error("Artifact must decode to 2 through 14,400 video frames; a still is insufficient");
  if (![video.width, video.height].every(value => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 8192)) throw new Error("Video dimensions must be bounded positive integers up to 8192");
  const duration = Number(record(metadata.format, "format").duration);
  boundedNumber(duration, "artifact duration", 0.01, 61);
  const durationPassed = Math.abs(duration - request.duration_seconds) <= (request.duration_tolerance_seconds ?? 0.05);
  const videoEvidence = [];
  for (const sample of request.samples) {
    const region = sample.region;
    if (region && (region.x + region.width > Number(video.width) || region.y + region.height > Number(video.height))) throw new Error("Sample region exceeds decoded video dimensions");
    const filter = region ? `crop=${region.width}:${region.height}:${region.x}:${region.y},scale=32:32:flags=area` : "scale=32:32:flags=area";
    const decoded = await run("ffmpeg", ["-v", "error", "-ss", String(sample.seconds), ...LOCAL_INPUT_PROTOCOLS, "-i", request.path, "-frames:v", "1", "-vf", filter, "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { encoding: "buffer", timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true });
    const pixels = Buffer.isBuffer(decoded.stdout) ? decoded.stdout : Buffer.from(decoded.stdout);
    if (pixels.length !== 32 * 32 * 3) throw new Error("Decoded temporal frame has an unexpected byte count");
    const mean = [0, 0, 0];
    for (let index = 0; index < pixels.length; index += 3) for (let channel = 0; channel < 3; channel++) mean[channel] += pixels[index + channel] / (32 * 32);
    const maximumError = Math.max(...mean.map((value, index) => Math.abs(value - sample.mean_rgb[index])));
    videoEvidence.push({ requestedSeconds: sample.seconds, captureMethod: "actual_artifact_ffmpeg_decode", region: region ?? "whole_frame", resolution: { width: 32, height: 32 }, meanRgb: mean, expectedMeanRgb: sample.mean_rgb, maximumError, tolerance: sample.max_error, passed: maximumError <= sample.max_error, timingBoundary: "ffmpeg_accurate_seek_first_decodable_frame_at_or_after_request" });
  }
  const audioEvidence = [];
  for (const sample of request.audio_samples ?? []) {
    if (!streams.some(value => value.codec_type === "audio")) throw new Error("Audio expectation requires an actual audio stream");
    const decoded = await run("ffmpeg", ["-v", "error", "-ss", String(sample.seconds), ...LOCAL_INPUT_PROTOCOLS, "-i", request.path, "-t", String(sample.duration_seconds), "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"], { encoding: "buffer", timeout: 30_000, maxBuffer: 256 * 1024, windowsHide: true });
    const samples = Buffer.isBuffer(decoded.stdout) ? decoded.stdout : Buffer.from(decoded.stdout);
    if (!samples.length || samples.length % 4 || samples.length < Math.floor(sample.duration_seconds * 48000 * 0.95) * 4) throw new Error("Decoded audio window is empty, truncated or malformed");
    let energy = 0;
    for (let index = 0; index < samples.length; index += 4) {
      const value = samples.readFloatLE(index);
      if (!Number.isFinite(value)) throw new Error("Decoded audio contains non-finite sample values");
      energy += value * value;
    }
    const rms = Math.sqrt(energy / (samples.length / 4));
    audioEvidence.push({ requestedSeconds: sample.seconds, durationSeconds: sample.duration_seconds, decodedSampleCount: samples.length / 4, sampleRate: 48000, channelPolicy: "mono_downmix_analysis", rms, passed: rms >= sample.rms_min && rms <= sample.rms_max });
  }
  const sha256 = await artifactHash(request.path), after = statSync(request.path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error("Temporal artifact changed while evidence was collected");
  return { schemaVersion: "premiere-mcp.temporal-render-evidence.v1", fixture: { id: request.fixture_id, sha256: request.fixture_sha256 }, artifact: { sha256, bytes: after.size, durationSeconds: duration, decodedVideoFrames: Number(video.nb_read_frames), width: video.width, height: video.height }, durationPassed, videoEvidence, audioEvidence, passed: durationPassed && videoEvidence.every(value => value.passed) && audioEvidence.every(value => value.passed), host: request.host ?? null, hostProvenance: request.host ? "caller_declared_not_authenticated_by_artifact" : "not_run", verificationBoundary: "sampled_actual_video_and_optional_decoded_audio_only", undoReopenPlayback: "not_run", hostVerified: false };
}

const number = (description: string, min: number, max: number) => ({ type: "number", minimum: min, maximum: max, description });
const string = (description: string, maximum = 512) => ({ type: "string", maxLength: maximum, description });
export function getTemporalRenderEvidenceTools(_bridgeOptions: BridgeOptions, run: TemporalRunner = defaultRunner) {
  return {
    verify_temporal_render_artifact: {
      description: "Validate actual short exported video at 2–32 times with decoded RGB tolerances and optional decoded-audio RMS windows. Rejects stills and mismatched samples; records fixture/artifact hashes and explicit declared host provenance. This sampled harness does not prove all frames, Undo/reopen, playback, glyphs or destination compatibility.",
      parameters: { type: "object", additionalProperties: false, properties: {
        path: string("Absolute existing caller-selected video artifact (maximum 1 GiB, expected duration at most 60 seconds).", 4096), fixture_id: string("Opaque fixture ID.", 64), fixture_sha256: string("Lowercase SHA-256 of generated fixture/input definition.", 64), duration_seconds: number("Expected actual video duration.", 0.01, 60), duration_tolerance_seconds: number("Allowed duration deviation, default 0.05 seconds.", 0, 1),
        samples: { type: "array", minItems: 2, maxItems: 32, description: "Expected temporal image checks; choose times around transitions and interpolation, with compression-aware tolerances.", items: { type: "object", additionalProperties: false, properties: { seconds: number("Sample time before exclusive artifact end.", 0, 60), mean_rgb: { type: "array", minItems: 3, maxItems: 3, description: "Expected mean RGB after 32x32 area scaling of whole frame or explicit region; not an HDR/legal-range assertion.", items: number("Expected red, green or blue mean.", 0, 255) }, max_error: number("Maximum absolute per-channel RGB error.", 0, 64), region: { type: "object", additionalProperties: false, description: "Optional explicit pixel ROI for spatial motion/effect oracles; must fit decoded video dimensions.", properties: { x: { type: "integer", minimum: 0, maximum: 8192, description: "ROI left pixel." }, y: { type: "integer", minimum: 0, maximum: 8192, description: "ROI top pixel." }, width: { type: "integer", minimum: 1, maximum: 8192, description: "ROI pixel width." }, height: { type: "integer", minimum: 1, maximum: 8192, description: "ROI pixel height." } }, required: ["x", "y", "width", "height"] } }, required: ["seconds", "mean_rgb", "max_error"] } },
        audio_samples: { type: "array", maxItems: 32, description: "Optional actual decoded-audio energy checks; analysis downmixes to mono 48kHz and cannot prove multichannel routing.", items: { type: "object", additionalProperties: false, properties: { seconds: number("Audio window start.", 0, 60), duration_seconds: number("Audio window length.", 0.01, 1), rms_min: number("Minimum RMS amplitude.", 0, 1), rms_max: number("Maximum RMS amplitude.", 0, 1) }, required: ["seconds", "duration_seconds", "rms_min", "rms_max"] } },
        host: { type: "object", additionalProperties: false, description: "Optional caller-declared licensed-host provenance; artifact analysis cannot authenticate these values.", properties: { premiere_build: string("Exact Premiere build.", 64), os: { type: "string", enum: ["Windows", "macOS"], description: "Host operating system." }, locale: string("Premiere locale.", 32), backend: { type: "string", enum: ["cep", "uxp"], description: "Selected connector backend." }, panel_sha256: string("Panel source/build SHA-256.", 64), server_commit: string("Server source Git commit.", 40), client_version: string("MCP client version.", 64), capability_ids: { type: "array", maxItems: 256, uniqueItems: true, description: "Advertised runtime capability IDs.", items: string("Capability ID.", 128) } }, required: ["premiere_build", "os", "locale", "backend", "panel_sha256", "server_commit", "client_version", "capability_ids"] },
      }, required: ["path", "fixture_id", "fixture_sha256", "duration_seconds", "samples"] },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args: TemporalRenderRequest) => {
        try { return { success: true, data: await verifyTemporalRenderArtifact(args, run) }; }
        catch (error) { return { success: false, error: (error as Error).message }; }
      },
    },
  };
}
