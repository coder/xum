import { z } from "zod";

export const ProviderModelEntrySchema = z.union([
  z.string().min(1),
  z
    .object({
      id: z.string().min(1),
      contextWindowTokens: z.number().int().positive().optional(),
      mappedToModel: z.string().min(1).optional(),
    })
    .strict(),
]);
