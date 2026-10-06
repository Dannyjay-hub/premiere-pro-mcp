import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created: string[] = [];

/** Create a fresh directory under the OS temp directory and remember it for cleanupTempDirs. */
export function makeTempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  created.push(directory);
  return directory;
}

/** Remove every directory made by makeTempDir. Register with afterAll in each test file that uses it. */
export function cleanupTempDirs(): void {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
}
