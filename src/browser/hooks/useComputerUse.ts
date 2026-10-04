import { useEffect, useState } from "react";

import { useAPI } from "@/browser/contexts/API";
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

  const run = async (request: () => Promise<ComputerUseStatus>) => {
    setError(null);
    try {
      setStatus(await request());
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  return {
    status,
    enabledHere: workspaceId != null && status?.ownerWorkspaceId === workspaceId,
    error,
    setEnabled: async (enabled) => {
      if (!api || workspaceId == null) return;
      await run(() => api.computerUse.setEnabled({ workspaceId, enabled }));
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
