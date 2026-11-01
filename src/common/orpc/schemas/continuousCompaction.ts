import { z } from "zod";
import type { MuxMessage } from "@/common/types/message";
import {
  MuxMessageSchema,
  MuxTextPartSchema,
  MuxReasoningPartSchema,
  MuxToolPartSchema,
  MuxFilePartSchema,
} from "./message";
import { ThinkingLevelSchema } from "@/common/types/thinking";

// Preserve request-bearing extension fields (e.g. SDK text state and reasoning signatures).
// The normal IPC schema deliberately strips them; a write-ahead record must not.
const metadata: z.ZodType<MuxMessage["metadata"]> = MuxMessageSchema.shape.metadata
  .unwrap()
  .passthrough()
  .optional();
const row: z.ZodType<MuxMessage> = MuxMessageSchema.extend({
  metadata,
  parts: z.array(
    z.union([
      MuxTextPartSchema.passthrough(),
      MuxReasoningPartSchema.passthrough(),
      ...MuxToolPartSchema.options.map((part) => part.passthrough()),
      MuxFilePartSchema.passthrough(),
    ])
  ),
}).passthrough();
/** The journal is the write-ahead record for a request-only prefix swap, not a history boundary. */
export const ContinuousCompactionJournalSchema = z
  .object({
    version: z.literal(1),
    // Legacy journals are valid until a durable publication generation is advanced.
    publicationGeneration: z.string().optional(),
    boundary: row,
    staticCopies: z.array(row),
    liveTailCopySpec: z.object({
      sourceMessageId: z.string().min(1),
      sourceHistorySequence: z.number().int().nonnegative(),
      copyId: z.string().min(1),
      partIndex: z.number().int().nonnegative(),
      metadataTemplate: metadata,
    }),
    // Unused since the boundary row carries the header. Older builds require the key, so new
    // journals write an empty list and stay readable after a downgrade.
    postCompactionAttachments: z.array(z.json()).optional(),
    // JSON wire prefix when representable; otherwise the pinned pipeline inputs below rebuild it.
    prefix: z.array(z.json()).optional(),
    // Preserve the initial request too: a fallback can rebuild system/tool context.
    fallbackPrefixes: z
      .array(
        z.object({
          modelString: z.string(),
          prefix: z.array(z.json()),
          providerOptions: z.json().optional(),
          system: z.json().optional(),
        })
      )
      .optional(),
    prefixSourceRows: z.array(row),
    systemPrefix: z.array(z.json()),
    cacheEnabled: z.boolean(),
    sourceFingerprint: z.string(),
    preparation: z.object({
      effectiveAgentId: z.string(),
      toolNamesForSentinel: z.array(z.string()),
      effectiveThinkingLevel: ThinkingLevelSchema,
      modelString: z.string(),
      providerForMessages: z.string(),
      anthropicCacheTtl: z.enum(["5m", "1h"]).optional(),
      deferLoadingToolNames: z.array(z.string()).optional(),
    }),
    requestProviderOptions: z.json().optional(),
    providerFamily: z.string(),
    parentModel: z.string(),
    summaryModel: z.string(),
    headFingerprint: z.string(),
    headEnd: z.object({ id: z.string(), sequence: z.number().int().nonnegative() }),
    headPartIndex: z.number().int().nonnegative().optional(),
    epoch: z.number().int().nonnegative(),
    boundarySequence: z.number().int().nonnegative().optional(),
    streamMessageId: z.string(),
    streamHistorySequence: z.number().int().nonnegative(),
    stepNumber: z.number().int().nonnegative(),
    firstTailToolCallId: z.string().min(1),
  })
  .refine(
    (journal) => {
      const ids = [
        journal.boundary.id,
        ...journal.staticCopies.map((copy) => copy.id),
        journal.liveTailCopySpec.copyId,
      ];
      return (
        journal.boundary.role === "assistant" &&
        journal.boundary.metadata?.compactionBoundary === true &&
        journal.boundary.metadata.compactionEpoch === journal.epoch + 1 &&
        journal.streamMessageId === journal.liveTailCopySpec.sourceMessageId &&
        journal.streamHistorySequence === journal.liveTailCopySpec.sourceHistorySequence &&
        new Set(ids).size === ids.length &&
        [journal.boundary, ...journal.staticCopies].every(
          (row) => row.metadata?.historySequence == null
        )
      );
    },
    { message: "Inconsistent continuous compaction journal identities" }
  );
export type ContinuousCompactionJournal = z.infer<typeof ContinuousCompactionJournalSchema>;
