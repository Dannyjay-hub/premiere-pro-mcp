#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const number = "(?:0|[1-9]\\d*)";
const prerelease = `(?:${number}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
const releaseTag = new RegExp(
  `^v${number}\\.${number}\\.${number}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

export function planReleaseNames(releases) {
  // Validate the entire inventory before changing any release.
  for (const release of releases) {
    if (!Number.isSafeInteger(release.id) || release.id <= 0 || !releaseTag.test(release.tag_name)) {
      throw new Error(`Invalid release identity: ${release.tag_name}`);
    }
  }
  return releases.filter((release) => release.name !== release.tag_name);
}

export function normalizeReleaseNames(releases, { apply = false, updateRelease, readRelease, log = console.log } = {}) {
  const changes = planReleaseNames(releases);
  for (const release of changes) {
    log(`${apply ? "Normalize" : "Would normalize"}: ${release.name} -> ${release.tag_name}`);
    if (apply) {
      updateRelease(release.id, { name: release.tag_name });
      const actual = readRelease(release.id);
      if (actual.name !== release.tag_name || actual.tag_name !== release.tag_name) {
        throw new Error(`Release title readback failed for ${release.tag_name}`);
      }
    }
  }
  log(`${releases.length} releases checked; ${changes.length} ${apply ? "normalized and verified" : "need normalization"}.`);
  return changes.length;
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--apply", "--check"].includes(arg)) || (args.includes("--apply") && args.includes("--check"))) {
    throw new Error("Usage: node scripts/normalize-release-names.mjs [--check | --apply]");
  }
  const repository = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error("Set GH_REPO to owner/repository before auditing release names.");
  }
  const releaseId = process.env.RELEASE_ID;
  if (releaseId && !/^[1-9]\d*$/.test(releaseId)) {
    throw new Error("RELEASE_ID must be a positive integer.");
  }
  const endpoint = `repos/${repository}/releases`;
  const api = (...apiArgs) => JSON.parse(execFileSync("gh", ["api", ...apiArgs], { encoding: "utf8" }));
  const releases = releaseId
    ? [api(`${endpoint}/${releaseId}`)]
    : api(endpoint, "--paginate", "--slurp").flat();
  const changed = normalizeReleaseNames(releases, {
    apply: args.includes("--apply"),
    updateRelease: (id, fields) => api(`${endpoint}/${id}`, "--method", "PATCH", "-f", `name=${fields.name}`),
    readRelease: (id) => api(`${endpoint}/${id}`),
  });
  if (args.includes("--check") && changed > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
