import { z } from "zod";
import { dialogueReviewSchema, quoteReviewSchema, textReviewSchema, syncReviewSchema, brollReviewSchema,
  reviewDialogue, reviewQuotes, reviewText, reviewSync, reviewBroll } from "../ai/editorial-review.js";

function tool(schema: z.ZodType, description: string, run: (input: unknown) => unknown) {
  return {
    description,
    parameters: z.toJSONSchema(schema, { io: "input" }),
    operationalCapability: {
      backend: "local" as const, backends: ["local" as const], status: "supported" as const,
      minimumPremiereVersion: null, authority: "inspect" as const,
      verificationBoundary: "static_metadata_only" as const, hostVerificationRequired: false,
      notes: ["Bounded review of caller-supplied evidence only; no persistence, providers, file access or host calls.", "Review revisions are not host apply tokens and do not prove live evidence freshness."],
    },
    handler: async (args: unknown) => {
      try {
        if (Buffer.byteLength(JSON.stringify(args) ?? "", "utf8") > 5 * 1024 * 1024) throw new Error("Review input exceeds 5 MiB");
        return { success: true, data: run(args) };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

export function getEditorialReviewTools() {
  return {
    review_dialogue_candidates: tool(dialogueReviewSchema, "Review revision-bound dialogue candidates with surrounding words, silence padding, explicit keep/reject decisions and unioned source-time removal duration. Recomputed review revisions reject stale selections. Local-only; no timeline mapping, transcription or mutation.", reviewDialogue),
    review_quote_paper_edit: tool(quoteReviewSchema, "Review a transcript quote library, explicitly order approved quotes, and return running timings and a formula-neutralized CSV paper edit inline. Local-only; no files, provider calls or multi-source timeline assembly.", reviewQuotes),
    review_text_changes: tool(textReviewSchema, "Preview literal replacements or supplied copy changes for inspected MOGRT text and supplied caption artifacts. Preserve original text and evidence revisions with explicit approve/reject decisions. Does not translate, access native graphics/caption text or apply changes.", reviewText),
    review_sync_evidence: tool(syncReviewSchema, "Review caller-supplied camera/recorder offset estimates for independent-method agreement, confidence and conflicting alternatives. All matches require selection; conflicting matches cannot be approved. Does not analyze audio, calibrate confidence or synchronize Premiere.", reviewSync),
    review_broll_placements: tool(brollReviewSchema, "Review caller-proposed owned-footage B-roll picks with matched quote, reason, alternatives, source/sequence revisions and explicit decisions. Reject overlapping approved placements. Does not infer visual content, search stock, inspect track occupancy or insert clips.", reviewBroll),
  };
}
