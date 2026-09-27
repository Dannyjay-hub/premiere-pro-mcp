import { beforeEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { getHelpersSource } from "../../src/bridge/script-builder.js";
import type { BridgeOptions } from "../../src/bridge/file-bridge.js";

vi.mock("../../src/bridge/file-bridge.js", () => ({
  sendCommand: vi.fn().mockResolvedValue({ success: true, data: {} }),
  sendRawCommand: vi.fn().mockResolvedValue({ success: true, data: {} }),
  getTempDir: vi.fn().mockReturnValue("/tmp/test"),
  cleanupTempDir: vi.fn(),
}));

import { sendCommand } from "../../src/bridge/file-bridge.js";
import { getTrackTargetingTools } from "../../src/tools/track-targeting.js";
import { getMediaTools } from "../../src/tools/media.js";
import { getUtilityTools } from "../../src/tools/utility.js";

const mockedSendCommand = vi.mocked(sendCommand);
const bridgeOptions: BridgeOptions = { tempDir: "/tmp/project-items", timeoutMs: 5000 };
type Result = { success: boolean; error?: string; data?: Record<string, unknown> };
beforeEach(() => vi.clearAllMocks());

/** Project with a root bin holding a used clip (on a timeline) and an unused Bars item. */
function project(options: { startTimeWritable?: boolean } = {}) {
  let startTicks = 0;
  type Node = { nodeId: string; name: string; type: number; children?: { numItems: number; [i: number]: Node }; parent?: Node };
  const makeBin = (nodeId: string, name: string): Node => ({ nodeId, name, type: 2, children: { numItems: 0 } });
  const root = makeBin("root", "Project");
  const add = (bin: Node, child: Node) => { const kids = bin.children!; kids[kids.numItems] = child; kids.numItems++; child.parent = bin; };
  const remove = (bin: Node, child: Node) => {
    const kids = bin.children!; const list: Node[] = [];
    for (let i = 0; i < kids.numItems; i++) if (kids[i] !== child) list.push(kids[i]);
    for (let i = 0; i < kids.numItems; i++) delete kids[i];
    list.forEach((n, i) => { kids[i] = n; }); kids.numItems = list.length;
  };
  const used = { nodeId: "used", name: "Interview A.mp4", type: 1, startTime: () => ({ seconds: startTicks / 254016000000 }), setStartTime: (t: string) => { if (options.startTimeWritable !== false) startTicks = parseFloat(t); } } as Node & Record<string, unknown>;
  const bars = { nodeId: "bars", name: "Bars 1080p", type: 1 } as Node & Record<string, unknown>;
  for (const item of [used, bars]) {
    add(root, item);
    (item as Record<string, unknown>).moveBin = (bin: Node) => { remove(item.parent!, item); add(bin, item); };
  }
  (root as Record<string, unknown>).createBin = (name: string) => {
    const bin = makeBin(`bin-${name}`, name) as Node & Record<string, unknown>;
    bin.deleteBin = () => remove(root, bin);
    add(root, bin);
    return bin;
  };
  const timelineClip = { projectItem: used, name: used.name };
  const seq = { name: "Edit", videoTracks: { numTracks: 1, 0: { clips: { numItems: 1, 0: timelineClip } } }, audioTracks: { numTracks: 0 }, projectItem: { nodeId: "seqitem" } };
  mockedSendCommand.mockImplementation(async (script: string) => JSON.parse(String(runInNewContext(`${getHelpersSource()}\n${script}`, {
    app: { project: { rootItem: root, sequences: { numSequences: 1, 0: seq }, activeSequence: seq } },
    Time: function Time(this: { ticks: string; seconds: number }) { let s = 0; Object.defineProperty(this, "seconds", { get: () => s, set: (v: number) => { s = v; } }); Object.defineProperty(this, "ticks", { get: () => String(Math.round(s * 254016000000)) }); },
  }))));
  const names = () => { const out: string[] = []; for (let i = 0; i < root.children!.numItems; i++) out.push(root.children![i].name); return out; };
  return { names };
}

describe("set_poster_frame", () => {
  it("fails without touching Premiere (it used to reset the frame rate to ~0 fps)", async () => {
    const result = await getTrackTargetingTools(bridgeOptions).set_poster_frame.handler({ item_id: "used", time_seconds: 26 }) as Result;
    expect(result.success).toBe(false);
    expect(mockedSendCommand).not.toHaveBeenCalled();
  });
});

describe("start time", () => {
  it("set_start_time and set_clip_start_time verify the readback", async () => {
    project();
    await expect(getMediaTools(bridgeOptions).set_start_time.handler({ item_id: "used", start_seconds: 3600 })).resolves.toMatchObject({ success: true, data: { verified: true, startSeconds: 3600 } });
    await expect(getTrackTargetingTools(bridgeOptions).set_clip_start_time.handler({ item_id: "used", start_seconds: 10 })).resolves.toMatchObject({ success: true, data: { verified: true } });
  });

  it("reports failure when Premiere ignores the write", async () => {
    project({ startTimeWritable: false });
    await expect(getMediaTools(bridgeOptions).set_start_time.handler({ item_id: "used", start_seconds: 3600 })).resolves.toMatchObject({ success: false });
  });
});

describe("delete_project_item for clip items", () => {
  it("deletes an unused item through a temporary bin and leaves no bin behind", async () => {
    const { names } = project();
    await expect(getUtilityTools(bridgeOptions).delete_project_item.handler({ item_id: "bars" })).resolves.toMatchObject({ success: true, data: { deleted: true, verified: true } });
    expect(names()).toEqual(["Interview A.mp4"]);
  });

  it("refuses an item that is used on a timeline", async () => {
    const { names } = project();
    const result = await getUtilityTools(bridgeOptions).delete_project_item.handler({ item_id: "used" }) as Result;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/used by 1 timeline clip\(s\) in Edit/);
    expect(names()).toEqual(["Interview A.mp4", "Bars 1080p"]);
  });
});
