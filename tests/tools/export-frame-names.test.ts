import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { getHelpersSource } from "../../src/bridge/script-builder.js";

const TICKS = 254016000000;

/**
 * Minimal ExtendScript File stand-in over an in-memory directory, and a QE
 * exporter that mimics Premiere 25.2: it cuts the output name at the first
 * dot, so "shot-12.5s" is written as "shot-12.png".
 */
function run(requestedPath: string) {
  const files = new Map<string, number>();
  class File {
    fsName: string;
    constructor(path: string) { this.fsName = path; }
    get name() { return encodeURI(this.fsName.substring(this.fsName.lastIndexOf("/") + 1)); }
    get exists() { return files.has(this.fsName); }
    get length() { return files.get(this.fsName) ?? 0; }
    get parent() { return null; }
    remove() { files.delete(this.fsName); return true; }
    rename(name: string) {
      const target = this.fsName.substring(0, this.fsName.lastIndexOf("/") + 1) + name;
      files.set(target, files.get(this.fsName) ?? 0);
      files.delete(this.fsName);
      this.fsName = target;
      return true;
    }
  }
  const qeSeq = {
    name: "Sweep",
    exportFramePNG(_timecode: string, base: string) {
      const slash = base.lastIndexOf("/");
      const name = base.substring(slash + 1);
      const cut = name.indexOf(".") >= 0 ? name.substring(0, name.indexOf(".")) : name;
      files.set(base.substring(0, slash + 1) + cut + ".png", 1024);
      return true;
    },
  };
  const seq = {
    timebase: String(TICKS / 25),
    videoDisplayFormat: 101,
    getPlayerPosition: () => ({ ticks: "0" }),
  };
  const Time = function (this: { ticks: string; getFormatted: () => string }) {
    this.ticks = "0";
    this.getFormatted = () => "00:00:12:12";
  };
  const context = { app: { enableQE: () => {}, project: { activeSequence: seq } }, qe: { project: { getActiveSequence: () => qeSeq } }, File, Time };
  const result = runInNewContext(`${getHelpersSource()}\n__exportStillFrame(${JSON.stringify(requestedPath)}, "${Math.round(12.5 * TICKS)}")`, context);
  return { result, files: [...files.keys()] };
}

describe("export_frame file names", () => {
  it("writes exactly the requested name when it contains dots, via the QE fast path", () => {
    const { result, files } = run("/Users/me/frames/shot-12.5s.png");
    expect(result).toMatchObject({ ok: true, method: "qe", path: "/Users/me/frames/shot-12.5s.png" });
    expect(files).toEqual(["/Users/me/frames/shot-12.5s.png"]);
  });

  it("still works for plain names", () => {
    const { result, files } = run("/Users/me/frames/plain.png");
    expect(result).toMatchObject({ ok: true, method: "qe" });
    expect(files).toEqual(["/Users/me/frames/plain.png"]);
  });
});

describe("export_sequence extension and default preset", () => {
  it("prefers AME's H.264 (MP4) folder over the QuickTime folder for the default preset", () => {
    const presets = [
      { name: "H264 Match Source - High bitrate", path: "/ame/3F3F3F3F_4D6F6F56/H264 Match Source - High bitrate.epr", format: "3F3F3F3F_4D6F6F56" },
      { name: "Match Source - High bitrate", path: "/ame/4E49434B_48323634/Match Source - High bitrate.epr", format: "4E49434B_48323634" },
    ];
    const chosen = runInNewContext(`${getHelpersSource()}\n__collectAllPresets = function () { return presets; };\n__findH264Preset();`, { presets });
    expect(chosen).toBe("/ame/4E49434B_48323634/Match Source - High bitrate.epr");
  });
});
