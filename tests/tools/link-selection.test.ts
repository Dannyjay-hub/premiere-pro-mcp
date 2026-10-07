import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/bridge/file-bridge.js", () => ({
  sendCommand: vi.fn().mockResolvedValue({ success: true, data: {} }),
}));

import { sendCommand } from "../../src/bridge/file-bridge.js";
import { getHelpersSource } from "../../src/bridge/script-builder.js";
import { getAdvancedTools } from "../../src/tools/advanced.js";

const mockedSendCommand = vi.mocked(sendCommand);
const advanced = getAdvancedTools({ tempDir: "/tmp/link-selection", timeoutMs: 1000 });

type Result = { success: boolean; error?: string; data?: Record<string, unknown> };

beforeEach(() => vi.clearAllMocks());

/**
 * Live 26.5.2: getLinkedItems() returns null for an unlinked clip and the whole
 * group (including the clip) for a linked one. unlinkSelection() returns false
 * and changes nothing unless every clip of each selected group is selected.
 */
function host(options: { linked?: string[][]; selected: string[]; linkIgnored?: boolean; unlinkIgnored?: boolean }) {
  const groups = new Map<string, Set<string>>();
  for (const group of options.linked ?? []) {
    const set = new Set(group);
    for (const id of group) groups.set(id, set);
  }
  const clips = ["v1", "a1", "v2", "a2"].map((nodeId) => ({
    nodeId,
    name: `clip ${nodeId}`,
    getLinkedItems: () => {
      const group = groups.get(nodeId);
      if (!group) return null;
      const list: Record<string | number, unknown> = { numItems: group.size };
      [...group].forEach((id, index) => { list[index] = { nodeId: id }; });
      return list;
    },
  }));
  const selection = () => clips.filter((clip) => options.selected.includes(clip.nodeId));
  const seq = {
    getSelection: () => selection(),
    unlinkSelection: () => {
      if (options.unlinkIgnored) return true;
      const ids = new Set(options.selected);
      for (const id of options.selected) {
        const group = groups.get(id);
        if (group && [...group].some((member) => !ids.has(member))) return false;
      }
      for (const id of options.selected) groups.delete(id);
      return true;
    },
    linkSelection: () => {
      if (options.linkIgnored) return false;
      const set = new Set(options.selected);
      for (const id of options.selected) groups.set(id, set);
      return true;
    },
  };
  mockedSendCommand.mockImplementation(async (script: string) => {
    expect(script).not.toMatch(/\b(let|const)\s|=>/);
    return JSON.parse(String(runInNewContext(`${getHelpersSource()}\n${script}`, { app: { project: { activeSequence: seq } } })));
  });
  return { groups };
}

describe("unlink_selection", () => {
  it("unlinks a fully selected group and reads the links back", async () => {
    const { groups } = host({ linked: [["v1", "a1"]], selected: ["v1", "a1"] });
    const result = await advanced.unlink_selection.handler() as Result;
    expect(result).toMatchObject({ success: true, data: { unlinked: true, verified: true, outcome: "verified", hostReturned: true } });
    expect(groups.size).toBe(0);
  });

  it("refuses a selection missing a linked partner before calling Premiere", async () => {
    const { groups } = host({ linked: [["v1", "a1"]], selected: ["v1"] });
    const result = await advanced.unlink_selection.handler() as Result;
    expect(result.success).toBe(false);
    expect(result.error).toContain("Also select the linked partner clip(s) a1");
    expect(result.error).toContain("Nothing was changed");
    expect(groups.get("v1")?.has("a1")).toBe(true);
  });

  it("reports a selection that is already unlinked without claiming a change", async () => {
    host({ selected: ["v2", "a2"] });
    await expect(advanced.unlink_selection.handler()).resolves.toMatchObject({ success: true, data: { unlinked: false, alreadyUnlinked: true, verified: true } });
  });

  it("fails when Premiere leaves the clips linked", async () => {
    host({ linked: [["v1", "a1"]], selected: ["v1", "a1"], unlinkIgnored: true });
    const result = await advanced.unlink_selection.handler() as Result;
    expect(result).toMatchObject({ success: false, data: { outcome: "failed", verified: false, stillLinked: ["v1", "a1"] } });
  });

  it("refuses an empty selection", async () => {
    host({ selected: [] });
    await expect(advanced.unlink_selection.handler()).resolves.toMatchObject({ success: false, error: expect.stringContaining("No clips are selected") });
  });
});

describe("link_selection", () => {
  it("links the selected clips and verifies every clip links to the others", async () => {
    host({ selected: ["v2", "a2"] });
    await expect(advanced.link_selection.handler()).resolves.toMatchObject({ success: true, data: { linked: true, verified: true, outcome: "verified", hostReturned: true } });
  });

  it("fails when Premiere does not link them", async () => {
    host({ selected: ["v2", "a2"], linkIgnored: true });
    const result = await advanced.link_selection.handler() as Result;
    expect(result).toMatchObject({ success: false, data: { outcome: "failed", verified: false, hostReturned: false, notLinked: ["v2", "a2"] } });
  });

  it("needs at least two selected clips", async () => {
    host({ selected: ["v2"] });
    await expect(advanced.link_selection.handler()).resolves.toMatchObject({ success: false, error: expect.stringContaining("at least two") });
  });
});
