import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/npm-publish.yml", import.meta.url), "utf8");
const step = workflow.split("      - name: Publish to npm\n")[1].split("      #")[0];
const script = step.split("        run: |\n")[1].split("\n").map((line) => line.replace(/^          /, "")).join("\n");

describe("npm publication input boundary", () => {
  it("passes tag input as data rather than generated shell code", () => {
    expect(script).not.toContain("${{ inputs.tag }}");
    expect(step).toContain("NPM_DIST_TAG: ${{ inputs.tag }}");
  });

  it.skipIf(process.platform === "win32")("accepts bounded tags and rejects shell syntax without invoking npm", () => {
    for (const tag of ["latest", "beta", "rc-1", "next_preview"]) {
      const result = spawnSync("bash", ["-c", `npm() { printf 'MOCK_PUBLISH:%s\\n' "$*"; };\n${script}`], { encoding: "utf8", env: { ...process.env, NPM_DIST_TAG: tag } });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`--tag ${tag}`);
    }
    for (const tag of ["$(printf SHELL_EXECUTED)", "latest\"; printf SHELL_EXECUTED; #", "--help", "1.2.3", "a".repeat(65), "beta\nlatest", ""]) {
      const result = spawnSync("bash", ["-c", `npm() { printf 'MOCK_PUBLISH:%s\\n' "$*"; };\n${script}`], { encoding: "utf8", env: { ...process.env, NPM_DIST_TAG: tag } });
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("MOCK_PUBLISH");
      expect(result.stdout).not.toContain("SHELL_EXECUTED");
    }
  });
});
