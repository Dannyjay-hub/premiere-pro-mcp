import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readEnvValue } from "../src/env-config.js";
import { createLazyUxpStart, nonDiscoverMethodSeen } from "../src/uxp-lazy-start.js";
import { UxpWebSocketBridge } from "../src/bridge/uxp-websocket-bridge.js";

describe("readEnvValue (issue #828 bug 1)", () => {
  it("treats unset, blank and unsubstituted user_config placeholders as unset", () => {
    expect(readEnvValue(undefined)).toBeUndefined();
    expect(readEnvValue("")).toBeUndefined();
    expect(readEnvValue("  \n")).toBeUndefined();
    expect(readEnvValue("${user_config.premiere_mcp_protocol_mode}")).toBeUndefined();
    expect(readEnvValue("${user_config.premiere_uxp_token}\n")).toBeUndefined();
  });

  it("keeps real values, trimmed", () => {
    expect(readEnvValue("legacy")).toBe("legacy");
    expect(readEnvValue(" 0123456789abcdef0123\n")).toBe("0123456789abcdef0123");
    expect(readEnvValue("${other}")).toBe("${other}");
  });
});

describe("nonDiscoverMethodSeen", () => {
  it("ignores server/discover and detects any other method", () => {
    expect(nonDiscoverMethodSeen('{"jsonrpc":"2.0","id":1,"method":"server/discover"}\n')).toBe(false);
    expect(nonDiscoverMethodSeen('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n')).toBe(true);
    expect(nonDiscoverMethodSeen('{"method" : "tools/list"}')).toBe(true);
  });
});

describe("createLazyUxpStart (issue #828 bug 2)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const inUse = (error: unknown) => (error as { code?: string })?.code === "EADDRINUSE";

  it("never binds for a discover-only probe", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const lazy = createLazyUxpStart({ start, isPortInUse: inUse });
    lazy.observe('{"jsonrpc":"2.0","id":1,"method":"server/discover"}\n');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(start).not.toHaveBeenCalled();
    lazy.stop();
  });

  it("binds once on the first real request, even when the method name is split across chunks", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const onStarted = vi.fn();
    const lazy = createLazyUxpStart({ start, isPortInUse: inUse, onStarted });
    lazy.observe('{"jsonrpc":"2.0","id":1,"meth');
    expect(start).not.toHaveBeenCalled();
    lazy.observe('od":"initialize","params":{}}\n');
    lazy.observe('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenCalledTimes(1);
    expect(onStarted).toHaveBeenCalledTimes(1);
    lazy.stop();
  });

  it("retries while the port is busy and reports busy once", async () => {
    const busy = Object.assign(new Error("in use"), { code: "EADDRINUSE" });
    const start = vi.fn().mockRejectedValueOnce(busy).mockRejectedValueOnce(busy).mockResolvedValue(undefined);
    const onBusy = vi.fn();
    const onStarted = vi.fn();
    const lazy = createLazyUxpStart({ start, isPortInUse: inUse, retryMs: 1000, onBusy, onStarted });
    lazy.observe('{"method":"initialize"}');
    await vi.advanceTimersByTimeAsync(0);
    expect(onBusy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(start).toHaveBeenCalledTimes(3);
    expect(onBusy).toHaveBeenCalledTimes(1);
    expect(onStarted).toHaveBeenCalledTimes(1);
    lazy.stop();
  });

  it("reports other failures without retrying, and stop() cancels pending retries", async () => {
    const onError = vi.fn();
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const a = createLazyUxpStart({ start: failing, isPortInUse: inUse, onError });
    a.observe('{"method":"initialize"}');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    const busy = Object.assign(new Error("in use"), { code: "EADDRINUSE" });
    const start = vi.fn().mockRejectedValue(busy);
    const b = createLazyUxpStart({ start, isPortInUse: inUse, retryMs: 1000 });
    b.observe('{"method":"initialize"}');
    await vi.advanceTimersByTimeAsync(0);
    b.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe("UXP bridge token trimming", () => {
  it("accepts a token with a trailing newline", () => {
    expect(() => new UxpWebSocketBridge({ token: "0123456789abcdef0123\n" })).not.toThrow();
  });

  it("still rejects a short token after trimming", () => {
    expect(() => new UxpWebSocketBridge({ token: "short-token \n" })).toThrow(/at least 16/);
  });
});
