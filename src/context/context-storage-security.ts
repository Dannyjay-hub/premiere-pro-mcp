import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import {
  ensurePrivateBridgeDirectory,
  inspectWindowsBridgeDirectoryAcl,
  isWindowsCapabilitySid,
} from "../bridge/file-bridge.js";

/** Reuse IPC ownership/ancestor checks, adding confidentiality to Windows ACLs. */
export function ensurePrivateContextDirectory(directory: string): void {
  ensurePrivateBridgeDirectory(directory, process.platform, process.getuid?.(), (name, initialize) =>
    inspectWindowsBridgeDirectoryAcl(name, initialize, { readAccess: true }));
}

function validateFile(stats: Stats): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error("Context storage requires a regular file with no links");
  }
  if (process.platform !== "win32" && (stats.uid !== process.getuid?.() || (stats.mode & 0o022) !== 0)) {
    throw new Error("Context file has unsafe ownership or write permissions");
  }
}

/** Open only files inside a validated private directory; never follow a link. */
export async function openPrivateContextFile(file: string, create = false) {
  try {
    validateFile(await lstat(file));
    if (process.platform === "win32") {
      const acl = inspectWindowsBridgeDirectoryAcl(file, false, { readAccess: true, file: true });
      if (acl.ownerSid !== acl.currentUserSid || !acl.ownerSid || acl.unsafeWriteAces.some((ace) => !isWindowsCapabilitySid(ace.sid))) {
        throw new Error("Context file has an unsafe Windows ACL");
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
    // Exclusive creation prevents a pre-created file or link from being adopted.
    return open(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
  }
  const handle = await open(file, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    validateFile(await handle.stat());
    if (process.platform !== "win32") await handle.chmod(0o600);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
