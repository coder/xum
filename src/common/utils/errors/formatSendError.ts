/**
 * Centralized error message formatting for SendMessageError types
 * Used by both RetryBarrier and ChatInputToasts
 */

import { PROVIDER_DISPLAY_NAMES, type ProviderName } from "@/common/constants/providers";
import type { SendMessageError } from "@/common/types/errors";
import { EDIT_HISTORY_CHANGED_MESSAGE } from "@/constants/transcriptBarrier";

const getProviderDisplayName = (provider: string): string =>
  PROVIDER_DISPLAY_NAMES[provider as ProviderName] ?? provider;

/** Shared wording for a send a message.send prompt hook refused. */
export function formatPluginBlockedMessage(plugin: string, reason: string): string {
  return `Plugin ${plugin} blocked this message: ${reason}`;
}

export interface FormattedError {
  message: string;
  resolutionHint?: string; // e.g., "Open Settings → Providers and add an API key"
}

export interface CredentialSetupCopy extends Required<FormattedError> {
  title: string;
}

/**
 * Setup copy for `api_key_not_found` on providers where "add an API key" would
 * point users at the wrong setting. Google Vertex AI authenticates with Google
 * Cloud credentials by default (an API key only selects express mode), so it
 * needs a Project instead. Returns undefined for API-key providers.
 */
export function getCredentialSetupCopy(provider: string): CredentialSetupCopy | undefined {
  if (provider !== "google-vertex") {
    return undefined;
  }
  const displayName = getProviderDisplayName(provider);
  return {
    title: `${displayName} Not Configured`,
    message: `${displayName} is not configured.`,
    resolutionHint:
      `Open Settings → Providers and set a Project for ${displayName} (authenticated with ` +
      `Google Cloud credentials or a valid service account key file, saved in Settings or named ` +
      `by GOOGLE_APPLICATION_CREDENTIALS), or an express mode API key.`,
  };
}

/**
 * Format a SendMessageError into a user-friendly message
 * Returns both the message and an optional command suggestion
 */
export function formatSendMessageError(error: SendMessageError): FormattedError {
  switch (error.type) {
    case "api_key_not_found": {
      const setupCopy = getCredentialSetupCopy(error.provider);
      if (setupCopy) {
        return { message: setupCopy.message, resolutionHint: setupCopy.resolutionHint };
      }
      const displayName = getProviderDisplayName(error.provider);
      return {
        message: `API key not found for ${displayName}.`,
        resolutionHint: `Open Settings → Providers and add an API key for ${displayName}.`,
      };
    }

    case "oauth_not_connected": {
      const displayName = getProviderDisplayName(error.provider);
      return {
        message: `OAuth not connected for ${displayName}.`,
        resolutionHint: `Open Settings → Providers and connect your ${displayName} account.`,
      };
    }

    case "provider_disabled": {
      const displayName = getProviderDisplayName(error.provider);
      return {
        message: `Provider ${displayName} is disabled.`,
        resolutionHint: `Open Settings → Providers and enable ${displayName}.`,
      };
    }

    case "provider_not_supported": {
      const displayName = getProviderDisplayName(error.provider);
      return {
        message: `Provider ${displayName} is not supported yet.`,
      };
    }

    case "model_not_available": {
      const displayName = getProviderDisplayName(error.provider);
      return {
        message: `Model ${error.modelId} is not available for ${displayName}.`,
        resolutionHint: `Open Settings → Providers and refresh available models for ${displayName}.`,
      };
    }

    case "invalid_model_string":
      return {
        message: error.message,
      };

    case "incompatible_workspace":
      return {
        message: error.message,
      };

    case "runtime_not_ready":
      return {
        message: error.message,
      };

    case "runtime_start_failed":
      return {
        message: error.message,
      };

    case "task_checkout_unsanitized":
      return {
        message: error.message,
      };

    case "context_budget_blocked":
      return { message: error.message };

    case "context_budget_exceeded":
      return {
        message: `Estimated request for ${error.model} exceeds its usable context budget of ${error.hardCeiling} tokens.`,
        resolutionHint: "Shorten the request or choose a larger-context model.",
      };

    case "history-changed":
      return { message: EDIT_HISTORY_CHANGED_MESSAGE };

    case "plan_review_feedback_edit_blocked":
    case "session_tape_replay":
      return { message: error.message };

    case "plugin_blocked":
      return { message: formatPluginBlockedMessage(error.plugin, error.reason) };

    case "unknown": {
      const raw = typeof error.raw === "string" ? error.raw.trim() : "";
      return {
        message: raw || "An unexpected error occurred",
      };
    }
  }
}
