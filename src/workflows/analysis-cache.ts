import { createHash } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { currentInvocation, assertInvocationNotCancelled, measureStage } from "./invocation-context.js";

const entries = new Map<string, { bytes: number; value: unknown }>();
const MAX_BYTES = 8 * 1024 * 1024;
let retainedBytes = 0;
export function analysisCacheDiagnostics() { return { version: 1, entries: entries.size, retainedBytes, maximumEntries: 64, maximumBytes: MAX_BYTES, scope: "process_memory_only; keyed by source path/identity, content hash, revision, options, analysis version" }; }
export function clearAnalysisCache(): void { entries.clear(); retainedBytes = 0; }

export async function cachedFileAnalysis<T>(file: string, options: unknown, revision: string, version: string, analyze: () => Promise<T>): Promise<{ value: T; hit: boolean; cacheable: boolean }> {
  assertInvocationNotCancelled();
  const sourcePath = resolve(file);
  const canonicalPath = realpathSync(sourcePath);
  const before = statSync(file);
  if (!before.isFile()) throw new Error("ANALYSIS_NOT_FILE: cache requires a regular media file");
  // Large media still analyzes normally; hashing it is an explicit optional cost.
  if (before.size > 256 * 1024 * 1024) return { value: await measureStage("analysis", analyze), hit: false, cacheable: false };
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal: currentInvocation()?.signal })) hash.update(chunk);
  const stable = () => { const after = statSync(file); return after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && after.ino === before.ino && after.dev === before.dev; };
  if (!stable()) throw new Error("ANALYSIS_SOURCE_CHANGED: media changed while hashing; inspect it again");
  // Results include source paths and metadata, so equal bytes at another path
  // must not reuse the first source's identity. Keep lexical aliases separate too.
  const key = createHash("sha256").update(JSON.stringify([sourcePath, canonicalPath, before.dev, before.ino, hash.digest("hex"), revision, version, options])).digest("hex");
  const cached = entries.get(key);
  if (cached) { entries.delete(key); entries.set(key, cached); return { value: structuredClone(cached.value) as T, hit: true, cacheable: true }; }
  const value = await measureStage("analysis", analyze);
  if (!stable()) throw new Error("ANALYSIS_SOURCE_CHANGED: media changed during analysis; result was not cached");
  // Failed analyses never become reusable successes.
  const failed = value && typeof value === "object" && "success" in value && (value as { success: unknown }).success === false;
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (!failed && bytes <= MAX_BYTES / 2) {
    const retainedValue = structuredClone(value);
    // Another same-key miss may have finished while this analysis awaited.
    // Replace its accounting once, before enforcing the bounded LRU capacity.
    const previous = entries.get(key);
    if (previous) { retainedBytes -= previous.bytes; entries.delete(key); }
    while (entries.size >= 64 || retainedBytes + bytes > MAX_BYTES) { const oldest = entries.keys().next().value!; retainedBytes -= entries.get(oldest)!.bytes; entries.delete(oldest); }
    entries.set(key, { bytes, value: retainedValue }); retainedBytes += bytes;
  }
  return { value, hit: false, cacheable: !failed && bytes <= MAX_BYTES / 2 };
}
