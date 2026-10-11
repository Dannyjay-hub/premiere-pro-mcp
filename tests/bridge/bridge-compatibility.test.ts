import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getBridgeCompatibility } from "../../src/bridge/file-bridge.js";
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
describe("CEP command/receipt compatibility diagnostics", () => {
  it("keeps legacy transport compatibility distinct from versioned contract support", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cep-compatibility-")); directories.push(tempDir);
    const options = { tempDir }, path = join(tempDir, "bridge-heartbeat.json");
    expect(getBridgeCompatibility(options)).toEqual({ compatible: true, boundary: "legacy_transport", commandSchemaVersion: null, receiptVersion: null });
    writeFileSync(path, JSON.stringify({ protocolVersion: 1, state: "running" }));
    expect(getBridgeCompatibility(options).boundary).toBe("legacy_transport");
    writeFileSync(path, JSON.stringify({ protocolVersion: 1, commandSchemaVersion: 1, receiptVersion: 1 }));
    expect(getBridgeCompatibility(options)).toMatchObject({ compatible: true, boundary: "versioned_command_and_receipt_schema", commandSchemaVersion: 1, receiptVersion: 1 });
    for (const value of [{ commandSchemaVersion: 2, receiptVersion: 1 }, { commandSchemaVersion: 1, receiptVersion: 2 }, { commandSchemaVersion: "1", receiptVersion: 1 }]) {
      writeFileSync(path, JSON.stringify({ protocolVersion: 1, ...value })); expect(getBridgeCompatibility(options).compatible).toBe(false);
    }
    writeFileSync(path, "{broken"); expect(getBridgeCompatibility(options)).toMatchObject({ compatible: false, boundary: "unreadable_heartbeat" });
    writeFileSync(path, "x".repeat(4097)); expect(getBridgeCompatibility(options)).toMatchObject({ compatible: false, boundary: "invalid_heartbeat" });
  });
});
