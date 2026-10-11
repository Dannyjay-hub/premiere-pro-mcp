import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const directory = process.argv[2];
if (!directory || !isAbsolute(directory) || process.argv.length !== 3) throw new Error("Usage: node scripts/create-temporal-render-fixture.mjs <new absolute output directory>");
if (existsSync(directory)) throw new Error("Output directory must be new; fixture generator never overwrites files");
mkdirSync(directory, { mode: 0o700 });
const path = join(directory, "red-dissolve-blue.mp4");
const definition = { schemaVersion: "premiere-mcp.generated-temporal-source.v1", duration: 3, frameRate: { numerator: 24, denominator: 1 }, frameSize: { width: 320, height: 180 }, colors: ["red", "blue"], transition: { type: "dissolve", start: 1, duration: 1 }, audio: { type: "sine", frequency: 1000, sampleRate: 48000 }, generatedBy: "ffmpeg_local_fixture_not_a_Premiere_export" };
execFileSync("ffmpeg", ["-v", "error", "-n", "-f", "lavfi", "-i", "color=c=red:s=320x180:r=24:d=2", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=24:d=2", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=3", "-filter_complex", "[0:v][1:v]xfade=transition=fade:duration=1:offset=1,format=yuv420p[v]", "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-crf", "12", "-c:a", "aac", "-t", "3", path], { timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024 });
const definitionHash = createHash("sha256").update(JSON.stringify(definition)).digest("hex");
const expectation = { path, fixture_id: "generated-red-dissolve-blue-v1", fixture_sha256: definitionHash, duration_seconds: 3, duration_tolerance_seconds: 0.1, samples: [{ seconds: 0.25, mean_rgb: [253, 0, 0], max_error: 4 }, { seconds: 1.5, mean_rgb: [126, 0, 126], max_error: 6 }, { seconds: 2.5, mean_rgb: [0, 0, 254], max_error: 4 }], audio_samples: [{ seconds: 0.25, duration_seconds: 0.1, rms_min: 0.07, rms_max: 0.11 }, { seconds: 2.25, duration_seconds: 0.1, rms_min: 0.07, rms_max: 0.11 }] };
writeFileSync(join(directory, "fixture.json"), JSON.stringify({ definition, expectation }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ fixture: definitionHash, artifact: createHash("sha256").update(readFileSync(path)).digest("hex"), hostEvidence: "not_run", outputDirectory: directory }, null, 2));
