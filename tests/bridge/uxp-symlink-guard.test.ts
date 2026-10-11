import { once } from "node:events";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createRequire } from "node:module";
import { MAX_UXP_COMMAND_BYTES, UxpWebSocketBridge } from "../../src/bridge/uxp-websocket-bridge.js";
import { cleanupTempDirs, makePrivateBridgeTempDir, makeTempDir } from "../helpers/temp-dir.js";

const Protocol = createRequire(import.meta.url)("../../uxp-plugin/protocol.cjs");

const TOKEN = "symlink-guard-token-0123456789abcdef";
const bridges: UxpWebSocketBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
  cleanupTempDirs();
});

describe("UXP bridge symlink confinement (#640)", () => {
  it("refuses symlinked path arguments before sending anything to the host", async () => {
    const base = makeTempDir("uxp-link-");
    const outside = join(base, "outside");
    const linked = join(base, "linked");
    mkdirSync(outside);
    symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");

    const bridge = new UxpWebSocketBridge({ token: TOKEN, port: 0, tempDir: makePrivateBridgeTempDir("uxp-lease-") });
    bridges.push(bridge);
    await bridge.start();
    const address = bridge.address();
    const client = new WebSocket(`ws://${address.host}:${address.port}${address.path}?token=${TOKEN}`);
    await once(client, "open");
    const connected = once(bridge, "connected");
    client.send(JSON.stringify({
      protocolVersion: 1,
      type: "hello",
      payload: { backend: "uxp", protocolVersion: 1, commandSchemaVersion: 1, receiptVersion: 1, replayPersistence: "durable_hashed_tombstones", commands: { "media.import": { supported: true } } },
    }));
    await connected;

    let sent = 0;
    client.on("message", () => { sent += 1; });
    await expect(bridge.request("media.import", { filePaths: [join(linked, "clip.mp4")] })).rejects.toMatchObject({
      code: "UXP_PATH_SYMLINK_REFUSED",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toBe(0);
    client.close();
  });
});

describe("UXP bridge command size limit (#642)", () => {
  it("matches the panel protocol limit", () => {
    expect(MAX_UXP_COMMAND_BYTES).toBe(Protocol.MAX_COMMAND_BYTES);
  });

  it("refuses a command over the panel's 64 KiB limit without sending it", async () => {
    const bridge = new UxpWebSocketBridge({ token: TOKEN, port: 0, tempDir: makePrivateBridgeTempDir("uxp-lease-") });
    bridges.push(bridge);
    await bridge.start();
    const address = bridge.address();
    const client = new WebSocket(`ws://${address.host}:${address.port}${address.path}?token=${TOKEN}`);
    await once(client, "open");
    const connected = once(bridge, "connected");
    client.send(JSON.stringify({
      protocolVersion: 1,
      type: "hello",
      payload: { backend: "uxp", protocolVersion: 1, commandSchemaVersion: 1, receiptVersion: 1, replayPersistence: "durable_hashed_tombstones", commands: { "metadata.update": { supported: true } } },
    }));
    await connected;

    let sent = 0;
    client.on("message", () => { sent += 1; });
    await expect(bridge.request("metadata.update", { xml: "x".repeat(70 * 1024) })).rejects.toMatchObject({
      code: "UXP_COMMAND_TOO_LARGE",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toBe(0);
    client.close();
  });
});
