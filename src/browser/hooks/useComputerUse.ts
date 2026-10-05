import { useEffect, useState } from "react";

import { useAPI } from "@/browser/contexts/API";
import { createCustomEvent, CUSTOM_EVENTS } from "@/common/constants/events";
import type {
  ComputerUsePermissionKind,
  ComputerUseStatus,
} from "@/common/orpc/schemas/computerUse";
import { getErrorMessage } from "@/common/utils/errors";

export interface ComputerUseState {
  /** Null until the backend answers (and outside the desktop app, until it reports unsupported). */
  status: ComputerUseStatus | null;
  /** True when the given workspace owns computer use. */
  enabledHere: boolean;
  /** Last rejected request (for example a non-local workspace); cleared by the next request. */
  error: string | null;
  setEnabled: (enabled: boolean) => Promise<void>;
  /** For the shortcut and palette: only the agent picker renders `error`, so failures become a toast. */
  toggle: () => Promise<void>;
  requestPermission: (kind: ComputerUsePermissionKind) => Promise<void>;
  /** Re-reads status; permissions change outside the app, so callers refresh on demand. */
  refresh: () => void;
}

export function useComputerUse(workspaceId: string | null): ComputerUseState {
  const { api } = useAPI();
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Backend-pushed status: ownership can change from any window or the global stop shortcut.
  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    const follow = async () => {
      try {
        const stream = await api.computerUse.subscribe(undefined, { signal: controller.signal });
        for await (const next of stream) {
          if (controller.signal.aborted) break;
          setStatus(next);
        }
      } catch {
        // A lost connection resubscribes when `api` changes.
      }
    };
    follow().catch(() => undefined);
    return () => controller.abort();
  }, [api]);

  const run = async (request: () => Promise<ComputerUseStatus>): Promise<string | null> => {
    setError(null);
    try {
      setStatus(await request());
      return null;
    } catch (err) {
      const message = getErrorMessage(err);
      setError(message);
      return message;
    }
  };

  const enabledHere = workspaceId != null && status?.ownerWorkspaceId === workspaceId;
  const requestEnabled = async (enabled: boolean): Promise<string | null> => {
    if (!api || workspaceId == null) return null;
    return await run(() => api.computerUse.setEnabled({ workspaceId, enabled }));
  };

  return {
    status,
    enabledHere,
    error,
    setEnabled: async (enabled) => {
      await requestEnabled(enabled);
    },
    toggle: async () => {
      const failure = await requestEnabled(!enabledHere);
      if (failure != null) {
        window.dispatchEvent(
          createCustomEvent(CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST, {
            type: "error",
            title: "Computer use",
            message: failure,
          })
        );
      }
    },
    requestPermission: async (kind) => {
      if (!api) return;
      await run(() => api.computerUse.requestPermission({ kind }));
    },
    refresh: () => {
      if (!api) return;
      const read = async () => setStatus(await api.computerUse.getStatus());
      read().catch(() => undefined);
    },
  };
}
