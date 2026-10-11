import { cachedFileAnalysis } from "../workflows/analysis-cache.js";

type Definition = { parameters: { properties?: Record<string, unknown>; [key: string]: unknown }; handler: (args: any) => Promise<{ success: boolean; data?: unknown; error?: string }> };
const eligible = new Set(["inspect_media_streams", "detect_audio_transients", "detect_motion_peaks", "read_video_scopes", "analyze_video_interlacing", "detect_active_picture_bounds"]);
export function withMediaAnalysisCache<T extends Record<string, Definition>>(tools: T): T {
  for (const [name, tool] of Object.entries(tools)) {
    if (!eligible.has(name)) continue;
    tool.parameters.properties = { ...tool.parameters.properties,
      use_cache: { type: "boolean", description: "Opt in to bounded process-memory caching keyed by source path/identity, media content SHA-256, exact options, revision, and analysis version. Files over 256 MiB analyze uncached. Default false." },
      analysis_revision: { type: "string", maxLength: 128, description: "Optional project/timeline revision to isolate otherwise-identical analysis inputs." },
    };
    const handler = tool.handler;
    tool.handler = async (input: Record<string, unknown>) => {
      const { use_cache, analysis_revision, ...args } = input;
      if (use_cache !== true || typeof args.media_path !== "string") return handler(args);
      try {
        const { media_path, ...options } = args;
        const cached = await cachedFileAnalysis(media_path, options, typeof analysis_revision === "string" ? analysis_revision : "source_only", `media-analysis-v1:${name}`, () => handler(args));
        const data = cached.value.data;
        return { ...cached.value, ...(data && typeof data === "object" && !Array.isArray(data) ? { data: { ...data, analysisCache: { hit: cached.hit, cacheable: cached.cacheable } } } : {}) };
      } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
    };
  }
  return tools;
}
