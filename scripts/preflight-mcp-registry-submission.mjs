import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const readJson = (relativePath) =>
  JSON.parse(readFileSync(join(root, relativePath), "utf8"));

const packageJson = readJson("package.json");
const manifest = readJson("registry/server.json");
const npmPackage = manifest.packages?.[0];

function fail(message) {
  console.error(`MCP Registry submission preflight failed: ${message}`);
  process.exitCode = 1;
}

// Keep bounded retries for transient npm/registry failures. Look up this
// exact server rather than depending on the registry-wide search service.
const FETCH_TIMEOUT_MS = 90_000;
const FETCH_ATTEMPTS = 3;

async function fetchWithRetry(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.status < 500 || attempt >= FETCH_ATTEMPTS) return response;
      console.warn(`${url} answered ${response.status} (attempt ${attempt}/${FETCH_ATTEMPTS}); retrying.`);
    } catch (error) {
      if (attempt >= FETCH_ATTEMPTS) throw error;
      console.warn(`${url} failed (${error instanceof Error ? error.message : String(error)}; attempt ${attempt}/${FETCH_ATTEMPTS}); retrying.`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000 * attempt));
  }
}

if (!npmPackage || manifest.name !== packageJson.mcpName) {
  fail("local registry metadata does not match package.json; run validate:mcp-registry-metadata first.");
} else if (
  manifest.version !== packageJson.version ||
  npmPackage.identifier !== packageJson.name ||
  npmPackage.version !== packageJson.version ||
  npmPackage.transport?.type !== "stdio"
) {
  fail("local registry package, version, or transport metadata is not publishable.");
} else {
  const npmUrl = `https://registry.npmjs.org/${encodeURIComponent(packageJson.name)}/${encodeURIComponent(packageJson.version)}`;
  const registryUrl = `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(manifest.name)}/versions/latest`;

  try {
    const [npmResponse, registryResponse] = await Promise.all([
      fetchWithRetry(npmUrl),
      fetchWithRetry(registryUrl),
    ]);

    if (!npmResponse.ok) {
      fail(`published npm artifact was not found (${npmResponse.status}).`);
    } else if (!registryResponse.ok && registryResponse.status !== 404) {
      fail(`official registry lookup failed (${registryResponse.status}).`);
    } else {
      const missing = registryResponse.status === 404;
      const [publishedPackage, registryBody] = await Promise.all([
        npmResponse.json(),
        missing ? Promise.resolve(null) : registryResponse.json(),
      ]);
      const existing = registryBody?.server ?? registryBody;

      if (
        publishedPackage.version !== packageJson.version ||
        publishedPackage.mcpName !== packageJson.mcpName
      ) {
        fail("published npm artifact does not expose the expected version and mcpName metadata.");
      } else if (!missing && (
        !existing || existing.name !== manifest.name ||
        typeof existing.version !== "string" || !existing.version.trim()
      )) {
        fail("official registry lookup returned unexpected server identity or version metadata.");
      } else {
        console.log(
          `Published npm artifact verified: ${packageJson.name}@${packageJson.version} (${packageJson.mcpName}).`,
        );
        console.log(
          !missing
            ? `Official MCP Registry latest record is ${manifest.name}@${existing.version}; inspect it before publishing another immutable version.`
            : `Official MCP Registry has no matching record for ${manifest.name}; metadata is ready for the owner-authorized publisher login.`,
        );
      }
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
