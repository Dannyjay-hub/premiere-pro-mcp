import { closeSync, createReadStream, openSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";

/**
 * Read-only access to settings that Premiere's scripting API cannot report but
 * that are saved in the .prproj file (gzipped XML).
 */

const MAX_PROJECT_FILE_BYTES = 512 * 1024 * 1024;
// The XML is streamed and reading stops once the wanted section closes, so
// neither the file nor its decompressed XML is held in memory at once.
const MAX_SCANNED_XML_BYTES = 256 * 1024 * 1024;
const MAX_SECTION_BYTES = 1024 * 1024;

/** ScratchDiskSettings element names mapped to stable result keys. */
const SCRATCH_DISK_ELEMENTS: Record<string, string> = {
  CapturedVideoLocation0: "capturedVideo",
  CapturedAudioLocation0: "capturedAudio",
  VideoPreviewLocation0: "videoPreviews",
  AudioPreviewLocation0: "audioPreviews",
  AutoSaveLocation0: "autoSave",
  CCLibrariesLocation0: "ccLibraries",
  CapsuleMediaLocation0: "motionGraphicsTemplateMedia",
  TransferMediaLocation0: "transferMedia",
  DVDEncodingLocation0: "dvdEncoding",
};

export interface ScratchDiskLocation {
  setting: string;
  path: string;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function isGzipped(path: string): boolean {
  const head = Buffer.alloc(2);
  const fd = openSync(path, "r");
  try {
    return readSync(fd, head, 0, 2, 0) === 2 && head[0] === 0x1f && head[1] === 0x8b;
  } finally {
    closeSync(fd);
  }
}

/**
 * Stream a saved project's XML (gzipped or plain) and return its first
 * <tag ...>...</tag> section, or null when the file has none. Stops reading as
 * soon as the section closes.
 */
export async function readProjectSection(projectPath: string, tag: string): Promise<string | null> {
  if (statSync(projectPath).size > MAX_PROJECT_FILE_BYTES) throw new Error("Project file is too large to read");
  const file = createReadStream(projectPath);
  const stream = isGzipped(projectPath) ? file.pipe(createGunzip()) : file;
  const decoder = new StringDecoder("utf8");
  const opening = new RegExp(`<${tag}[\\s>]`);
  const closing = `</${tag}>`;
  let scanned = 0;
  let pending = "";
  let section: string | null = null;
  try {
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      scanned += bytes.length;
      if (scanned > MAX_SCANNED_XML_BYTES) throw new Error(`No complete ${tag} section in the first ${MAX_SCANNED_XML_BYTES} bytes of the project XML`);
      const text = decoder.write(bytes);
      if (section === null) {
        pending += text;
        const start = pending.search(opening);
        if (start < 0) {
          pending = pending.slice(-(tag.length + 2));
          continue;
        }
        section = pending.slice(start);
        pending = "";
      } else {
        section += text;
      }
      const end = section.indexOf(closing);
      if (end >= 0) return section.slice(0, end + closing.length);
      if (section.length > MAX_SECTION_BYTES) throw new Error(`The project's ${tag} section is larger than ${MAX_SECTION_BYTES} bytes`);
    }
    return null;
  } finally {
    file.destroy();
    if (stream !== file) stream.destroy();
  }
}

/**
 * Scratch disk locations saved in a project. "SameAsProject" resolves to the
 * project's folder; other values are the saved paths.
 */
export async function readScratchDisks(projectPath: string): Promise<Record<string, ScratchDiskLocation>> {
  const xml = await readProjectSection(projectPath, "ScratchDiskSettings");
  const block = xml === null ? null : /<ScratchDiskSettings\b[^>]*>([\s\S]*?)<\/ScratchDiskSettings>/.exec(xml);
  if (!block) throw new Error("The saved project has no ScratchDiskSettings");
  const projectFolder = dirname(projectPath);
  const disks: Record<string, ScratchDiskLocation> = {};
  for (const match of block[1].matchAll(/<([A-Za-z]+Location0)>([^<]*)<\/\1>/g)) {
    const key = SCRATCH_DISK_ELEMENTS[match[1]] ?? match[1];
    const setting = decodeXmlText(match[2].trim());
    disks[key] = { setting, path: setting === "SameAsProject" ? projectFolder : setting };
  }
  return disks;
}
