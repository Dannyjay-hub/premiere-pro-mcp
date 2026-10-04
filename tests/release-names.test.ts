import { describe, expect, it, vi } from "vitest";
import { normalizeReleaseNames, planReleaseNames } from "../scripts/normalize-release-names.mjs";

const release = (tag = "v1.19.0", name = "Premiere Pro MCP v1.19.0") => ({
  id: 123, tag_name: tag, name, body: "Release summary", prerelease: false,
});

describe("release name normalization", () => {
  it("previews drift without writing and leaves canonical names alone", () => {
    const updateRelease = vi.fn();
    const readRelease = vi.fn();
    expect(normalizeReleaseNames([release(), release("v1.18.1", "v1.18.1")], {
      updateRelease, readRelease, log: vi.fn(),
    })).toBe(1);
    expect(updateRelease).not.toHaveBeenCalled();
    expect(readRelease).not.toHaveBeenCalled();
  });

  it("updates only names and independently verifies the title and tag", () => {
    const original = release();
    const updateRelease = vi.fn();
    const readRelease = vi.fn(() => ({ ...original, name: original.tag_name }));
    expect(normalizeReleaseNames([original], {
      apply: true, updateRelease, readRelease, log: vi.fn(),
    })).toBe(1);
    expect(updateRelease).toHaveBeenCalledExactlyOnceWith(123, { name: "v1.19.0" });
    expect(readRelease).toHaveBeenCalledExactlyOnceWith(123);
    expect(original).toEqual(release());
  });

  it("is idempotent after a successful repair", () => {
    const updateRelease = vi.fn();
    normalizeReleaseNames([release("v1.19.0", "v1.19.0")], {
      apply: true, updateRelease, log: vi.fn(),
    });
    expect(updateRelease).not.toHaveBeenCalled();
  });

  it("supports SemVer prerelease and build suffixes", () => {
    for (const tag of ["v0.1.0", "v2.0.0-rc.1", "v2.0.0-beta.0+build.01", "v2.0.0+build.1"]) {
      expect(planReleaseNames([release(tag)])).toHaveLength(1);
    }
  });

  it("rejects an invalid inventory before any write", () => {
    for (const tag of ["1.19.0", "V1.19.0", "v1.19", "v01.19.0", "v1.19.0-01", "v1.19.0 — summary", "v1.19.0\n"]) {
      const updateRelease = vi.fn();
      expect(() => normalizeReleaseNames([release(), release(tag)], {
        apply: true, updateRelease, log: vi.fn(),
      })).toThrow("Invalid release identity");
      expect(updateRelease).not.toHaveBeenCalled();
    }
    expect(() => planReleaseNames([{ ...release(), id: 0 }])).toThrow("Invalid release identity");
  });

  it("fails on stale titles, changed tags, or API failures", () => {
    for (const actual of [release(), release("v2.0.0", "v1.19.0")]) {
      expect(() => normalizeReleaseNames([release()], {
        apply: true, updateRelease: vi.fn(), readRelease: () => actual, log: vi.fn(),
      })).toThrow("readback failed");
    }
    expect(() => normalizeReleaseNames([release()], {
      apply: true, updateRelease: () => { throw new Error("API denied"); }, log: vi.fn(),
    })).toThrow("API denied");
  });
});
