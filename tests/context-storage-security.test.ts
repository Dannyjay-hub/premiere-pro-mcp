import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectContextRepository, type ProjectContextDocument } from "../src/context/project-context-store.js";
import { openPrivateContextFile } from "../src/context/context-storage-security.js";

const directories: string[] = [];
const posix = process.platform !== "win32";
const sqlite = Number(process.versions.node.split(".")[0]) >= 22;
const document: ProjectContextDocument = {
  schemaVersion: 1, projectId: "synthetic", projectName: "Synthetic context",
  revision: "1", sourceRevision: "1", timelineRevision: "1", updatedAt: new Date().toISOString(), records: [],
};
const filename = `${createHash("sha256").update(document.projectId).digest("hex")}.json`;
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function directory() {
  const result = await mkdtemp(path.join(tmpdir(), "ppmcp-private-context-"));
  directories.push(result);
  return posix ? result : path.join(result, "private");
}

describe("private project context storage", () => {
  it.runIf(posix)("tightens existing read-only group access and privately creates SQLite", async () => {
    const dir = await directory();
    await chmod(dir, 0o755);
    const repository = new ProjectContextRepository({ directory: dir, backend: sqlite ? "sqlite" : "json" });
    try {
      await repository.put(document);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      const file = path.join(dir, sqlite ? "project-context.sqlite" : filename);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await repository.get(document.projectId)).toEqual(document);
    } finally { await repository.close(); }
  });

  it.runIf(posix)("refuses an existing writable directory and unsafe ancestors", async () => {
    const dir = await directory();
    await chmod(dir, 0o777);
    await expect(new ProjectContextRepository({ directory: dir, backend: "json" }).put(document)).rejects.toThrow("writable by other users");
    await expect(new ProjectContextRepository({ directory: path.join(dir, "child"), backend: "json" }).put(document)).rejects.toThrow("replaceable ancestor");
    await chmod(dir, 0o700);
  });

  it.runIf(posix)("rejects linked directories, files, and hard-linked targets without changing targets", async () => {
    const dir = await directory();
    const target = path.join(dir, "target");
    await mkdir(target, { mode: 0o700 });
    const alias = path.join(dir, "alias");
    await symlink(target, alias);
    await expect(new ProjectContextRepository({ directory: alias, backend: "json" }).put(document)).rejects.toThrow("symbolic link");
    const other = path.join(dir, "outside.txt");
    await writeFile(other, "synthetic target", { mode: 0o600 });
    const file = path.join(target, filename);
    await symlink(other, file);
    const repository = new ProjectContextRepository({ directory: target, backend: "json" });
    await expect(repository.get(document.projectId)).rejects.toThrow("no links");
    await expect(repository.put(document)).rejects.toThrow("no links");
    await rm(file);
    await link(other, file);
    await expect(repository.put(document)).rejects.toThrow("no links");
    expect(await readFile(other, "utf8")).toBe("synthetic target");
  });

  it("uses distinct staging files for concurrent writes and ignores old predictable staging links", async () => {
    const dir = await directory();
    const repository = new ProjectContextRepository({ directory: dir, backend: "json" });
    if (posix) {
      const target = path.join(dir, "target.txt");
      await writeFile(target, "synthetic target", { mode: 0o600 });
      await symlink(target, path.join(dir, `${filename}.${process.pid}.tmp`));
    }
    await Promise.all([repository.put(document), repository.put({ ...document, revision: "2" })]);
    expect((await repository.get(document.projectId))?.revision).toMatch(/^[12]$/);
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toHaveLength(posix ? 1 : 0);
    if (posix) expect(await readFile(path.join(dir, "target.txt"), "utf8")).toBe("synthetic target");
  });

  it.runIf(posix)("rejects writable files and tightens safe readable files", async () => {
    const dir = await directory();
    const file = path.join(dir, "context.json");
    await writeFile(file, "{}", { mode: 0o666 });
    await chmod(file, 0o666);
    await expect(openPrivateContextFile(file)).rejects.toThrow("unsafe ownership or write permissions");
    await chmod(file, 0o644);
    await (await openPrivateContextFile(file)).close();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await expect(openPrivateContextFile(dir)).rejects.toThrow("regular file");
    await expect(openPrivateContextFile(path.join(dir, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(posix && sqlite)("does not downgrade to JSON when SQLite or its sidecar is a link", async () => {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const dir = await directory();
      const target = path.join(dir, "target");
      await writeFile(target, "synthetic target", { mode: 0o600 });
      await symlink(target, path.join(dir, `project-context.sqlite${suffix}`));
      await expect(new ProjectContextRepository({ directory: dir, backend: "auto" }).put(document)).rejects.toThrow("no links");
      expect(await readFile(target, "utf8")).toBe("synthetic target");
      expect(await readdir(dir)).not.toContain(filename);
    }
  });

  it.runIf(posix)("rechecks directory permissions after backend initialization", async () => {
    const dir = await directory();
    const repository = new ProjectContextRepository({ directory: dir, backend: "json" });
    await repository.put(document);
    await chmod(dir, 0o777);
    await expect(repository.get(document.projectId)).rejects.toThrow("writable by other users");
    await chmod(dir, 0o700);
  });
});
