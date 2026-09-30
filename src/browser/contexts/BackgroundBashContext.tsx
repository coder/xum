import type { ReactNode } from "react";
import React, { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { usePopoverError } from "@/browser/hooks/usePopoverError";
import { useBackgroundBashStoreRaw } from "@/browser/stores/BackgroundBashStore";

interface BackgroundBashActions {
  terminate: (processId: string) => void;
  sendToBackground: (toolCallId: string) => void;
  autoBackgroundOnSend: () => void;
}

const BackgroundBashActionsContext = createContext<BackgroundBashActions | undefined>(undefined);
const BackgroundBashErrorContext = createContext<ReturnType<typeof usePopoverError> | undefined>(
  undefined
);

interface BackgroundBashProviderProps {
  workspaceId: string;
  /** Identifies the server connection; the VS Code webview passes it, desktop omits it. */
  connectionKey?: string | null;
  children: ReactNode;
}

export const BackgroundBashProvider: React.FC<BackgroundBashProviderProps> = (props) => {
  const store = useBackgroundBashStoreRaw();
  const error = usePopoverError();
  // An action's failure belongs to the workspace and server connection it was issued in. A
  // provider that stays mounted across workspace or server switches (the VS Code webview's) drops
  // failures that arrive after a switch, so they never show over another workspace's chat.
  const connectionKey = props.connectionKey ?? null;
  const liveScopeRef = useRef({ workspaceId: props.workspaceId, connectionKey });
  useEffect(() => {
    liveScopeRef.current = { workspaceId: props.workspaceId, connectionKey };
  }, [props.workspaceId, connectionKey]);

  const actions = useMemo<BackgroundBashActions>(() => {
    const isLive = (workspaceId: string) =>
      liveScopeRef.current.workspaceId === workspaceId &&
      liveScopeRef.current.connectionKey === connectionKey;
    return {
      terminate: (processId: string) => {
        const workspaceId = props.workspaceId;
        store.terminate(workspaceId, processId).catch((err: Error) => {
          if (!isLive(workspaceId)) return;
          error.showError(processId, err.message);
        });
      },
      sendToBackground: (toolCallId: string) => {
        const workspaceId = props.workspaceId;
        store.sendToBackground(workspaceId, toolCallId).catch((err: Error) => {
          if (!isLive(workspaceId)) return;
          error.showError(`send-to-background-${toolCallId}`, err.message);
        });
      },
      autoBackgroundOnSend: () => {
        store.autoBackgroundOnSend(props.workspaceId);
      },
    };
  }, [connectionKey, error, props.workspaceId, store]);

  return (
    <BackgroundBashActionsContext.Provider value={actions}>
      <BackgroundBashErrorContext.Provider value={error}>
        {props.children}
      </BackgroundBashErrorContext.Provider>
    </BackgroundBashActionsContext.Provider>
  );
};

export function useBackgroundBashActions(): BackgroundBashActions {
  const context = useContext(BackgroundBashActionsContext);
  if (!context) {
    throw new Error("useBackgroundBashActions must be used within BackgroundBashProvider");
  }
  return context;
}

export function useBackgroundBashError(): ReturnType<typeof usePopoverError> {
  const context = useContext(BackgroundBashErrorContext);
  if (!context) {
    throw new Error("useBackgroundBashError must be used within BackgroundBashProvider");
  }
  return context;
}
