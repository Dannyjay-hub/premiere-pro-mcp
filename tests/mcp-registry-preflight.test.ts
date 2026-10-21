import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
const script = pathToFileURL(join(process.cwd(), "scripts/preflight-mcp-registry-submission.mjs")).href;
const latestUrl = `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(pkg.mcpName)}/versions/latest`;

type Fixture = {
  npmStatus?: number;
  npmVersion?: string;
  registryStatus?: number;
  registryName?: string;
  registryVersion?: string | null;
  transientRegistryFailure?: boolean;
};

function run(fixture: Fixture = {}) {
  const code = `
    const fixture = ${JSON.stringify(fixture)};
    const pkg = ${JSON.stringify({ name: pkg.name, version: pkg.version, mcpName: pkg.mcpName })};
    const latestUrl = ${JSON.stringify(latestUrl)};
    const requests = [];
    let registryCalls = 0;
    globalThis.setTimeout = (callback) => { queueMicrotask(callback); return 0; };
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      if (String(url).startsWith('https://registry.npmjs.org/')) {
        return new Response(JSON.stringify({ version: fixture.npmVersion ?? pkg.version, mcpName: pkg.mcpName }), { status: fixture.npmStatus ?? 200 });
      }
      if (String(url) === latestUrl) {
        registryCalls++;
        const status = fixture.transientRegistryFailure && registryCalls === 1 ? 503 : fixture.registryStatus ?? 200;
        return new Response(JSON.stringify({ server: { name: fixture.registryName ?? pkg.mcpName, version: fixture.registryVersion === undefined ? '1.0.0' : fixture.registryVersion } }), { status });
      }
      return new Response('{}', { status: 400 });
    };
    process.on('exit', () => console.log('REQUESTS=' + JSON.stringify(requests)));
    await import(${JSON.stringify(script)});
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 5_000 });
}

describe("MCP Registry submission preflight", () => {
  it("uses the exact server lookup and succeeds without the broad search service", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(latestUrl);
    expect(result.stdout).not.toContain("?search=");
    expect(result.stdout).toContain("Published npm artifact verified");
  });

  it("permits a new server only when the exact lookup returns 404", () => {
    const result = run({ registryStatus: 404 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("no matching record");
  });

  it.each([403, 500])("rejects unavailable or forbidden registry responses (%s)", (registryStatus) => {
    const result = run({ registryStatus });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("preflight failed");
  });

  it("rejects a different server identity", () => {
    const result = run({ registryName: "io.github.someone-else/premiere-pro" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("preflight failed");
  });

  it("rejects malformed existing-record metadata", () => {
    const result = run({ registryVersion: null });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("preflight failed");
  });

  it.each([{ npmStatus: 404 }, { npmVersion: "0.0.0" }])("retains published npm identity/version gates (%j)", (fixture) => {
    const result = run(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("preflight failed");
  });

  it("retains bounded recovery for a transient registry server failure", () => {
    const result = run({ transientRegistryFailure: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split(latestUrl).length - 1).toBe(2);
  });
});
