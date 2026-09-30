/**
 * Telemetry tracking functions
 *
 * These functions provide a clean API for tracking telemetry events.
 * Callers pass raw values; rounding and formatting happen internally.
 * This ensures consistent privacy-preserving transformations.
 */

import { trackEvent } from "./client";
import { roundToBase2 } from "./utils";
import type {
  TelemetryRuntimeType,
  TelemetryThinkingLevel,
  TelemetryCommandType,
  FrontendPlatformInfo,
} from "./payload";

/**
 * Get frontend platform information for telemetry.
 * Uses browser APIs (navigator) which are safe to send and widely shared.
 */
function getFrontendPlatform(): FrontendPlatformInfo {
  if (typeof navigator === "undefined") {
    return { userAgent: "unknown", platform: "unknown" };
  }
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
  };
}

// =============================================================================
// Tracking Functions
// =============================================================================

/**
 * Track workspace creation
 */
export function trackWorkspaceCreated(
  workspaceId: string,
  runtimeType: TelemetryRuntimeType
): void {
  trackEvent({
    event: "workspace_created",
    properties: {
      workspaceId,
      runtimeType,
      frontendPlatform: getFrontendPlatform(),
    },
  });
}

/**
 * Track workspace switch
 */
export function trackWorkspaceSwitched(fromWorkspaceId: string, toWorkspaceId: string): void {
  trackEvent({
    event: "workspace_switched",
    properties: { fromWorkspaceId, toWorkspaceId },
  });
}

/**
 * Track message sent
 * @param messageLength - Raw character count (will be rounded to base-2)
 */
export function trackMessageSent(
  workspaceId: string,
  model: string,
  agentId: string,
  messageLength: number,
  runtimeType: TelemetryRuntimeType,
  thinkingLevel: TelemetryThinkingLevel
): void {
  trackEvent({
    event: "message_sent",
    properties: {
      workspaceId,
      model,
      agentId,
      message_length_b2: roundToBase2(messageLength),
      runtimeType,
      frontendPlatform: getFrontendPlatform(),
      thinkingLevel,
    },
  });
}

/**
 * Track stats tab opening.
 */
export function trackStatsTabOpened(
  viewMode: "session" | "last-request",
  showModeBreakdown: boolean
): void {
  trackEvent({
    event: "stats_tab_opened",
    properties: { viewMode, showModeBreakdown },
  });
}

/**
 * Track stream completion
 * @param durationSecs - Raw duration in seconds (will be rounded to base-2)
 * @param outputTokens - Raw token count (will be rounded to base-2)
 */
export function trackStreamCompleted(
  model: string,
  wasInterrupted: boolean,
  durationSecs: number,
  outputTokens: number
): void {
  trackEvent({
    event: "stream_completed",
    properties: {
      model,
      wasInterrupted,
      duration_b2: roundToBase2(durationSecs),
      output_tokens_b2: roundToBase2(outputTokens),
    },
  });
}

/**
 * Track provider configuration (not the key value, just that it was configured)
 */
export function trackProviderConfigured(provider: string, keyType: string): void {
  trackEvent({
    event: "provider_configured",
    properties: { provider, keyType },
  });
}

/**
 * Track slash command usage
 */
export function trackCommandUsed(command: TelemetryCommandType): void {
  trackEvent({
    event: "command_used",
    properties: { command },
  });
}

/**
 * Track voice transcription
 * @param audioDurationSecs - Raw duration in seconds (will be rounded to base-2)
 */
export function trackVoiceTranscription(audioDurationSecs: number, success: boolean): void {
  trackEvent({
    event: "voice_transcription",
    properties: {
      audio_duration_b2: roundToBase2(audioDurationSecs),
      success,
    },
  });
}

/**
 * Track error occurrence
 */
export function trackErrorOccurred(
  errorType: string,
  context:
    | "workspace-creation"
    | "workspace-deletion"
    | "workspace-switch"
    | "message-send"
    | "message-stream"
    | "project-add"
    | "project-remove"
    | "git-operation"
): void {
  trackEvent({
    event: "error_occurred",
    properties: { errorType, context },
  });
}

/**
 * Track experiment override - when a user manually toggles an experiment
 */
export function trackExperimentOverridden(experimentId: string, userChoice: boolean): void {
  trackEvent({
    event: "experiment_overridden",
    properties: { experimentId, userChoice },
  });
}
