import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getTemporalRenderEvidenceTools, validateTemporalRenderRequest, verifyTemporalRenderArtifact, type TemporalRunner } from "../../src/tools/temporal-render-evidence.js";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

afterAll(cleanupTempDirs);
const fixture = () => { const path = join(makeTempDir("temporal-artifact-"), "video.mp4"); writeFileSync(path, "actual artifact bytes"); return path; };
const expectation = (path = fixture()) => ({ path, fixture_id: "color-transition", fixture_sha256: "a".repeat(64), duration_seconds: 3, samples: [{ seconds: 0.25, mean_rgb: [255, 0, 0], max_error: 0 }, { seconds: 2.5, mean_rgb: [0, 0, 255], max_error: 0 }], audio_samples: [{ seconds: 0.25, duration_seconds: 0.1, rms_min: 0.07, rms_max: 0.11 }] });
const host = { premiere_build: "26.3.0", os: "macOS", locale: "en_US", backend: "uxp", panel_sha256: "b".repeat(64), server_commit: "c".repeat(40), client_version: "1.0", capability_ids: ["interchange.export"] };
function pixels(color: number[]) { const buffer = Buffer.alloc(32 * 32 * 3); for (let index = 0; index < buffer.length; index++) buffer[index] = color[index % 3]; return buffer; }
const validProbe = { format: { duration: "3" }, streams: [{ codec_type: "video", width: 320, height: 180, nb_read_frames: "72" }, { codec_type: "audio", sample_rate: "48000", channels: 1 }] };
function runner(probe = validProbe): TemporalRunner {
  return vi.fn(async (program, args) => {
    if (program === "ffprobe") return { stdout: JSON.stringify(probe) };
    if (args.includes("rawvideo")) return { stdout: pixels(args[3] === "0.25" ? [255, 0, 0] : [0, 0, 255]) };
    const samples = Buffer.alloc(4800 * 4); for (let index = 0; index < samples.length; index += 4) samples.writeFloatLE(0.09, index);
    return { stdout: samples };
  });
}

describe("actual temporal video/audio evidence contract", () => {
  it("decodes multiple times and audio with fixture/artifact hashes but does not authenticate host provenance", async () => {
    const run = runner();
    const result = await verifyTemporalRenderArtifact({ ...expectation(), host }, run);
    expect(result).toMatchObject({ passed: true, artifact: { decodedVideoFrames: 72 }, hostProvenance: "caller_declared_not_authenticated_by_artifact", undoReopenPlayback: "not_run", hostVerified: false });
    expect(result.videoEvidence.map(value => value.meanRgb)).toEqual([[255, 0, 0], [0, 0, 255]]);
    expect(result.audioEvidence[0]).toMatchObject({ passed: true, sampleRate: 48000, decodedSampleCount: 4800 });
    expect(run).toHaveBeenCalledWith("ffprobe", expect.any(Array), expect.objectContaining({ timeout: 60000 }));
    expect(run).toHaveBeenCalledWith("ffmpeg", expect.arrayContaining(["rawvideo", "pipe:1"]), expect.objectContaining({ encoding: "buffer" }));
    expect(run).toHaveBeenCalledWith("ffprobe", expect.arrayContaining(["-protocol_whitelist", "file,pipe", "-format_whitelist"]), expect.any(Object));
    const withoutHost = await verifyTemporalRenderArtifact({ ...expectation(), audio_samples: [] }, runner());
    expect(withoutHost.hostProvenance).toBe("not_run");
  });
  it("fails measured color, duration and audio expectations while retaining evidence", async () => {
    const expected = expectation();
    expected.samples[0].mean_rgb = [0, 255, 0]; expected.audio_samples[0].rms_max = 0.08;
    const measured = await verifyTemporalRenderArtifact(expected, runner({ ...validProbe, format: { duration: "3.5" } }));
    expect(measured).toMatchObject({ passed: false, durationPassed: false, videoEvidence: [{ passed: false }, { passed: true }], audioEvidence: [{ passed: false }] });
  });
  it("checks explicit bounded pixel regions for spatial motion oracles", async () => {
    const request = { ...expectation(), samples: expectation().samples.map(value => ({ ...value, region: { x: 4, y: 8, width: 16, height: 16 } })) };
    const run = runner();
    expect((await verifyTemporalRenderArtifact(request, run)).passed).toBe(true);
    expect(run).toHaveBeenCalledWith("ffmpeg", expect.arrayContaining(["crop=16:16:4:8,scale=32:32:flags=area"]), expect.any(Object));
    request.samples[0].region.x = 319;
    await expect(verifyTemporalRenderArtifact(request, runner())).rejects.toThrow("exceeds");
    request.samples[0].region.x = -1;
    expect(() => validateTemporalRenderRequest(request)).toThrow("integer pixel");
  });
  it("rejects still images, missing audio, malformed decoder bytes and changed artifacts", async () => {
    await expect(verifyTemporalRenderArtifact(expectation(), runner({ ...validProbe, streams: [{ ...validProbe.streams[0], nb_read_frames: "1" }] }))).rejects.toThrow("still");
    await expect(verifyTemporalRenderArtifact(expectation(), runner({ ...validProbe, streams: [validProbe.streams[0]] }))).rejects.toThrow("actual audio");
    await expect(verifyTemporalRenderArtifact(expectation(), async (program) => program === "ffprobe" ? { stdout: JSON.stringify(validProbe) } : { stdout: Buffer.alloc(1) })).rejects.toThrow("byte count");
    const expected = expectation();
    const base = runner();
    await expect(verifyTemporalRenderArtifact(expected, async (...args) => { const result = await base(...args); if (args[0] === "ffmpeg") writeFileSync(expected.path, "changed"); return result; })).rejects.toThrow("changed");
    const badAudio = runner();
    await expect(verifyTemporalRenderArtifact(expectation(), async (...args) => args[1].includes("f32le") ? { stdout: Buffer.alloc(1) } : badAudio(...args))).rejects.toThrow("audio window");
    const nonfinite = Buffer.alloc(4800 * 4); nonfinite.writeFloatLE(NaN, 0);
    await expect(verifyTemporalRenderArtifact(expectation(), async (...args) => args[1].includes("f32le") ? { stdout: nonfinite } : badAudio(...args))).rejects.toThrow("non-finite");
  });
  it.each([
    [{ path: "relative.mp4" }, /absolute/], [{ fixture_sha256: "invalid" }, /hash/], [{ duration_seconds: 61 }, /duration_seconds/], [{ duration_tolerance_seconds: -1 }, /tolerance/], [{ samples: [] }, /2 through 32/], [{ samples: [{ seconds: 0, mean_rgb: [0, 0, 0], max_error: 0 }, { seconds: 0, mean_rgb: [0, 0, 0], max_error: 0 }] }, /unique/], [{ samples: [{ seconds: 0, mean_rgb: [0, 0], max_error: 0 }, { seconds: 1, mean_rgb: [0, 0, 0], max_error: 0 }] }, /three/], [{ audio_samples: [{ seconds: 2.95, duration_seconds: 0.1, rms_min: 0, rms_max: 1 }] }, /exceeds/], [{ audio_samples: [{ seconds: 0, duration_seconds: 0.1, rms_min: 1, rms_max: 0 }] }, /rms_max/], [{ host: { ...host, backend: "qe" } }, /backend/], [{ host: { ...host, capability_ids: ["x", "x"] } }, /unique/], [{ host: { ...host, capability_ids: ["C:\\secret"] } }, /capability_id/],
  ])("rejects malformed fixture expectations before invoking decoders", (change, error) => expect(() => validateTemporalRenderRequest({ ...expectation(), ...change })).toThrow(error));
  it("tool reports decoder failures without a success receipt", async () => {
    const run = vi.fn().mockRejectedValue(new Error("ffprobe missing"));
    expect(await getTemporalRenderEvidenceTools({ tempDir: "/tmp/temporal" }, run).verify_temporal_render_artifact.handler(expectation())).toMatchObject({ success: false, error: "ffprobe missing" });
    expect(await getTemporalRenderEvidenceTools({ tempDir: "/tmp/temporal" }, runner()).verify_temporal_render_artifact.handler(expectation())).toMatchObject({ success: true, data: { passed: true, hostVerified: false } });
  });
});

let haveDecoders = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); execFileSync("ffprobe", ["-version"], { stdio: "ignore" }); } catch { haveDecoders = false; }
it.skipIf(!haveDecoders)("validates a generated actual dissolve video and decoded tone; this is local decoder proof, not Premiere proof", async () => {
  const parent = makeTempDir("actual-temporal-fixture-");
  const directory = join(parent, "new-fixture");
  execFileSync(process.execPath, [join(process.cwd(), "scripts/create-temporal-render-fixture.mjs"), directory], { timeout: 60000, maxBuffer: 1024 * 1024 });
  const generated = JSON.parse(readFileSync(join(directory, "fixture.json"), "utf8"));
  const result = await verifyTemporalRenderArtifact(generated.expectation);
  expect(result).toMatchObject({ passed: true, hostProvenance: "not_run", artifact: { decodedVideoFrames: 72 }, audioEvidence: [{ passed: true }, { passed: true }] });
  const bad = { ...generated.expectation, samples: generated.expectation.samples.map((sample: unknown) => ({ ...(sample as object), mean_rgb: [0, 255, 0] })) };
  expect((await verifyTemporalRenderArtifact(bad)).passed).toBe(false);
}, 60000);
