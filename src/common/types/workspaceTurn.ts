import { z } from "zod";

export const WorkspaceTurnFinalMessageRefSchema = z
  .object({
    messageId: z.string().min(1),
    model: z.string().optional(),
    agentId: z.string().optional(),
    finishReason: z.string().optional(),
    usageSummary: z
      .object({
        inputTokens: z.number().optional(),
        outputTokens: z.number().optional(),
        totalTokens: z.number().optional(),
      })
      .strict()
      .optional(),
    partCount: z.number().int().min(0).optional(),
    textCharCount: z.number().int().min(0).optional(),
  })
  .strict();

export type WorkspaceTurnFinalMessageRef = z.infer<typeof WorkspaceTurnFinalMessageRefSchema>;
