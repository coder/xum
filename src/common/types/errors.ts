/**
 * Strongly-typed error types for send message operations.
 * This discriminated union allows the frontend to handle different error cases appropriately.
 */

import type z from "zod";
import type {
  NameGenerationErrorSchema,
  PlanReviewErrorSchema,
  SendMessageErrorSchema,
  StreamErrorTypeSchema,
} from "../orpc/schemas";

/**
 * Discriminated union for all possible sendMessage errors.
 *
 * The frontend is responsible for language and messaging for api_key_not_found,
 * oauth_not_connected, provider_disabled, provider_not_supported, and
 * model_not_available errors.
 * Other error types include details needed for display.
 */
export type SendMessageError = z.infer<typeof SendMessageErrorSchema>;

/**
 * Stream error types - categorizes errors during AI streaming
 * Used across backend (StreamManager) and frontend (StreamErrorMessage)
 */
export type StreamErrorType = z.infer<typeof StreamErrorTypeSchema>;

export type NameGenerationError = z.infer<typeof NameGenerationErrorSchema>;

/** Typed failures of the workspace.planReview.* endpoints. */
export type PlanReviewError = z.infer<typeof PlanReviewErrorSchema>;
