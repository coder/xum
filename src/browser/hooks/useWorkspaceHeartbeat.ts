import { useCallback, useEffect, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { useWorkspaceActions } from "@/browser/contexts/WorkspaceContext";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import {
  HEARTBEAT_DEFAULT_CONTEXT_MODE,
  HEARTBEAT_DEFAULT_INTERVAL_MS,
} from "@/constants/heartbeat";

type WorkspaceHeartbeatSettings = NonNullable<FrontendWorkspaceMetadata["heartbeat"]>;

interface HeartbeatGlobalDefaults {
  intervalMs: number;
}

export type HeartbeatFormSettings = WorkspaceHeartbeatSettings;

interface UseWorkspaceHeartbeatParams {
  workspaceId: string | null;
}

export interface UseWorkspaceHeartbeatResult {
  settings: HeartbeatFormSettings;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  save: (next: HeartbeatFormSettings) => Promise<boolean>;
  /** Global default prompt from config, for use as placeholder text. */
  globalDefaultPrompt: string | undefined;
}

function normalizeHeartbeatDefaultMessage(message?: string): string | undefined {
  const trimmedMessage = message?.trim();
  return trimmedMessage ?? undefined;
}

function getDefaultHeartbeatSettings(
  globalDefaults?: HeartbeatGlobalDefaults
): HeartbeatFormSettings {
  // Only seed the interval from global defaults. The message is intentionally left
  // empty so saving without editing does not persist the global prompt as a
  // workspace-level override (the backend handles prompt fallback at execution time).
  return {
    enabled: false,
    intervalMs: globalDefaults?.intervalMs ?? HEARTBEAT_DEFAULT_INTERVAL_MS,
    contextMode: HEARTBEAT_DEFAULT_CONTEXT_MODE,
  };
}

function normalizeHeartbeatSettings(
  heartbeat: WorkspaceHeartbeatSettings | null,
  globalDefaults?: HeartbeatGlobalDefaults
): HeartbeatFormSettings {
  if (!heartbeat) {
    return getDefaultHeartbeatSettings(globalDefaults);
  }

  const message = normalizeHeartbeatDefaultMessage(heartbeat.message);
  const contextMode = heartbeat.contextMode ?? HEARTBEAT_DEFAULT_CONTEXT_MODE;
  return {
    enabled: heartbeat.enabled,
    intervalMs: heartbeat.intervalMs,
    contextMode,
    ...(message ? { message } : {}),
    // Keep trigger/whenBusy sparse (no client-side defaulting) so the modal can distinguish
    // "unset (read-time default)" from an explicit choice.
    ...(heartbeat.trigger != null ? { trigger: heartbeat.trigger } : {}),
    ...(heartbeat.whenBusy != null ? { whenBusy: heartbeat.whenBusy } : {}),
  };
}

function getHeartbeatErrorMessage(error: unknown, fallbackMessage: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallbackMessage;
}

export function useWorkspaceHeartbeat(
  params: UseWorkspaceHeartbeatParams
): UseWorkspaceHeartbeatResult {
  const { workspaceId } = params;
  const { api } = useAPI();
  const { setWorkspaceMetadata } = useWorkspaceActions();
  const [settings, setSettings] = useState<HeartbeatFormSettings>(() =>
    getDefaultHeartbeatSettings()
  );
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [globalDefaultPrompt, setGlobalDefaultPrompt] = useState<string | undefined>(undefined);

  // Guards for out-of-order async responses (e.g., rapid toggles or workspace switches).
  const currentWorkspaceIdRef = useRef<string | null>(workspaceId);
  currentWorkspaceIdRef.current = workspaceId;
  const latestSaveRequestIdRef = useRef(0);

  useEffect(() => {
    setSettings(getDefaultHeartbeatSettings());
    setIsLoading(true);
    setIsSaving(false);
    setError(null);
    setGlobalDefaultPrompt(undefined);

    if (!workspaceId) {
      setIsLoading(false);
      return;
    }

    if (!api) {
      return;
    }

    let cancelled = false;
    void Promise.all([
      api.workspace.heartbeat.get({ workspaceId }),
      api.config.getConfig().catch(() => null),
    ])
      .then(([heartbeat, config]) => {
        if (cancelled) return;
        if (currentWorkspaceIdRef.current !== workspaceId) return;

        const globalDefaults = config
          ? {
              intervalMs: config.heartbeatDefaultIntervalMs ?? HEARTBEAT_DEFAULT_INTERVAL_MS,
            }
          : undefined;

        setSettings(normalizeHeartbeatSettings(heartbeat, globalDefaults));
        setGlobalDefaultPrompt(config?.heartbeatDefaultPrompt?.trim() ?? undefined);
        setError(null);
        setIsLoading(false);
      })
      .catch((loadError) => {
        if (cancelled) return;
        if (currentWorkspaceIdRef.current !== workspaceId) return;

        setGlobalDefaultPrompt(undefined);
        setError(
          getHeartbeatErrorMessage(loadError, "Failed to load workspace heartbeat settings")
        );
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [api, workspaceId]);

  const save = useCallback(
    async (next: HeartbeatFormSettings): Promise<boolean> => {
      setIsSaving(true);
      setError(null);

      if (!workspaceId || !api) {
        setError("Workspace heartbeat settings are unavailable");
        setIsSaving(false);
        return false;
      }

      const requestId = ++latestSaveRequestIdRef.current;
      const workspaceIdAtCall = workspaceId;

      try {
        const result = await api.workspace.heartbeat.set({
          workspaceId: workspaceIdAtCall,
          ...next,
        });

        if (!result.success) {
          throw new Error(result.error ?? "Failed to save workspace heartbeat settings");
        }

        if (latestSaveRequestIdRef.current !== requestId) {
          return true;
        }

        if (currentWorkspaceIdRef.current !== workspaceIdAtCall) {
          return true;
        }

        const normalizedSettings = normalizeHeartbeatSettings(next);
        setWorkspaceMetadata((prev) => {
          const existingMetadata = prev.get(workspaceIdAtCall);
          if (!existingMetadata) {
            return prev;
          }

          const updated = new Map(prev);
          updated.set(workspaceIdAtCall, {
            ...existingMetadata,
            heartbeat: normalizedSettings,
          });
          return updated;
        });
        setSettings(normalizedSettings);
        setIsSaving(false);
        return true;
      } catch (saveError) {
        if (latestSaveRequestIdRef.current !== requestId) {
          return false;
        }

        if (currentWorkspaceIdRef.current !== workspaceIdAtCall) {
          return false;
        }

        setError(
          getHeartbeatErrorMessage(saveError, "Failed to save workspace heartbeat settings")
        );
        setIsSaving(false);
        return false;
      }
    },
    [api, setWorkspaceMetadata, workspaceId]
  );

  return { settings, isLoading, isSaving, error, save, globalDefaultPrompt };
}
