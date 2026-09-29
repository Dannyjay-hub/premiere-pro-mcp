/**
 * AME system presets live in folders named "<vendor hex>_<format hex>", e.g.
 * "4E49434B_48323634" = "NICK"/"H264". The format four-character code decides
 * the container, which a preset's name does not reliably say: presets named
 * "H264 ..." in the "MooV" folder write QuickTime .mov files.
 */
const FORMATS: Record<string, { label: string; extension: string }> = {
  H264: { label: "H.264 (MP4)", extension: "mp4" },
  H26B: { label: "H.264 Blu-ray", extension: "m4v" },
  HEVC: { label: "HEVC / H.265 (MP4)", extension: "mp4" },
  MooV: { label: "QuickTime (MOV)", extension: "mov" },
  "MP4 ": { label: "MPEG-4 (3GP)", extension: "3gp" },
  "AAC ": { label: "AAC audio", extension: "aac" },
  WAVE: { label: "Waveform audio (WAV)", extension: "wav" },
  AIFF: { label: "AIFF audio", extension: "aif" },
  "MP3 ": { label: "MP3 audio", extension: "mp3" },
  "PNG ": { label: "PNG image", extension: "png" },
  TIFF: { label: "TIFF image", extension: "tif" },
  JPEG: { label: "JPEG image", extension: "jpg" },
  "DPX ": { label: "DPX image", extension: "dpx" },
  TPIC: { label: "Targa image", extension: "tga" },
  DIBB: { label: "BMP image", extension: "bmp" },
  AVIV: { label: "AVI", extension: "avi" },
  "WMV ": { label: "Windows Media", extension: "wmv" },
  GIFf: { label: "Animated GIF", extension: "gif" },
  "flv ": { label: "FLV", extension: "flv" },
  mpg2: { label: "MPEG-2", extension: "mpg" },
  "dvd ": { label: "MPEG-2 DVD", extension: "m2v" },
  "mbd ": { label: "MPEG-2 Blu-ray", extension: "m2v" },
  "hbd ": { label: "H.264 Blu-ray", extension: "m4v" },
  JMXF: { label: "MXF OP1a", extension: "mxf" },
  PMXF: { label: "MXF OP1a", extension: "mxf" },
  DMXF: { label: "DNxHR/DNxHD MXF OP1a", extension: "mxf" },
  "MXF ": { label: "P2 Movie (MXF)", extension: "mxf" },
  MXFX: { label: "XDCAM HD (MXF)", extension: "mxf" },
  MX10: { label: "AS-10 (MXF)", extension: "mxf" },
  MX11: { label: "AS-11 (MXF)", extension: "mxf" },
  DCP_: { label: "Wraptor DCP", extension: "mxf" },
  "PCM ": { label: "Raw PCM audio", extension: "pcm" },
  oEXR: { label: "OpenEXR image", extension: "exr" },
};

function fourCC(hex: string): string | null {
  if (!/^[0-9a-f]{8}$/i.test(hex)) return null;
  let text = "";
  for (let i = 0; i < 8; i += 2) text += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return /^[\x20-\x7e]{4}$/.test(text) ? text : null;
}

export interface PresetFormat {
  formatCode: string | null;
  formatLabel: string;
  extension: string | null;
}

/** Describe an AME preset folder name such as "4E49434B_48323634". */
export function describePresetFolder(folder: string): PresetFormat {
  const match = /^([0-9a-f]{8})_([0-9a-f]{8})$/i.exec(folder);
  const code = match ? fourCC(match[2]) : null;
  if (!code) return { formatCode: null, formatLabel: folder, extension: null };
  const known = FORMATS[code];
  return { formatCode: code, formatLabel: known?.label ?? code.trim(), extension: known?.extension ?? null };
}
