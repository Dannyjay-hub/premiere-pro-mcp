import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * Read-only access to settings that Premiere's scripting API cannot report but
 * that are saved in the .prproj file (gzipped XML).
 */

const MAX_PROJECT_FILE_BYTES = 512 * 1024 * 1024;
const MAX_PROJECT_XML_BYTES = 1024 * 1024 * 1024;

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

export function readProjectXml(projectPath: string): string {
  if (statSync(projectPath).size > MAX_PROJECT_FILE_BYTES) throw new Error("Project file is too large to read");
  const raw = readFileSync(projectPath);
  const xml = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw, { maxOutputLength: MAX_PROJECT_XML_BYTES }) : raw;
  return xml.toString("utf8");
}

/**
 * Scratch disk locations saved in a project. "SameAsProject" resolves to the
 * project's folder; other values are the saved paths.
 */
export function readScratchDisks(projectPath: string): Record<string, ScratchDiskLocation> {
  const xml = readProjectXml(projectPath);
  const block = /<ScratchDiskSettings\b[^>]*>([\s\S]*?)<\/ScratchDiskSettings>/.exec(xml);
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
