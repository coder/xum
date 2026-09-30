import { useCallback } from "react";
import {
  trackWorkspaceCreated,
  trackWorkspaceSwitched,
  trackMessageSent,
  trackStatsTabOpened,
  trackStreamCompleted,
  trackProviderConfigured,
  trackCommandUsed,
  trackVoiceTranscription,
  trackErrorOccurred,
  trackExperimentOverridden,
} from "@/common/telemetry";
import type {
  ErrorContext,
  TelemetryRuntimeType,
  TelemetryThinkingLevel,
  TelemetryCommandType,
} from "@/common/telemetry/payload";

/**
 * Hook for clean telemetry integration in React components
 *
 * Provides stable callback references for telemetry tracking.
 * All numeric values are automatically rounded for privacy.
 *
 * Usage:
 *
 * ```tsx
 * const telemetry = useTelemetry();
 *
 * telemetry.workspaceSwitched(fromId, toId);
 * telemetry.workspaceCreated(workspaceId, runtimeType);
 * telemetry.messageSent(workspaceId, model, agentId, messageLength, runtimeType, thinkingLevel);
 * telemetry.streamCompleted(model, wasInterrupted, durationSecs, outputTokens);
 * telemetry.providerConfigured(provider, keyType);
 * telemetry.commandUsed(commandType);
 * telemetry.voiceTranscription(audioDurationSecs, success);
 * telemetry.errorOccurred(errorType, context);
 * telemetry.experimentOverridden(experimentId, userChoice);
 * ```
 */
export function useTelemetry() {
  const workspaceSwitched = useCallback((fromWorkspaceId: string, toWorkspaceId: string) => {
    trackWorkspaceSwitched(fromWorkspaceId, toWorkspaceId);
  }, []);

  const workspaceCreated = useCallback((workspaceId: string, runtimeType: TelemetryRuntimeType) => {
    trackWorkspaceCreated(workspaceId, runtimeType);
  }, []);

  const messageSent = useCallback(
    (
      workspaceId: string,
      model: string,
      agentId: string,
      messageLength: number,
      runtimeType: TelemetryRuntimeType,
      thinkingLevel: TelemetryThinkingLevel
    ) => {
      trackMessageSent(workspaceId, model, agentId, messageLength, runtimeType, thinkingLevel);
    },
    []
  );

  const statsTabOpened = useCallback(
    (viewMode: "session" | "last-request", showModeBreakdown: boolean) => {
      trackStatsTabOpened(viewMode, showModeBreakdown);
    },
    []
  );
  const streamCompleted = useCallback(
    (model: string, wasInterrupted: boolean, durationSecs: number, outputTokens: number) => {
      trackStreamCompleted(model, wasInterrupted, durationSecs, outputTokens);
    },
    []
  );

  const providerConfigured = useCallback((provider: string, keyType: string) => {
    trackProviderConfigured(provider, keyType);
  }, []);

  const commandUsed = useCallback((command: TelemetryCommandType) => {
    trackCommandUsed(command);
  }, []);

  const voiceTranscription = useCallback((audioDurationSecs: number, success: boolean) => {
    trackVoiceTranscription(audioDurationSecs, success);
  }, []);

  const errorOccurred = useCallback((errorType: string, context: ErrorContext) => {
    trackErrorOccurred(errorType, context);
  }, []);

  const experimentOverridden = useCallback((experimentId: string, userChoice: boolean) => {
    trackExperimentOverridden(experimentId, userChoice);
  }, []);

  return {
    workspaceSwitched,
    workspaceCreated,
    messageSent,
    statsTabOpened,
    streamCompleted,
    providerConfigured,
    commandUsed,
    voiceTranscription,
    errorOccurred,
    experimentOverridden,
  };
}
