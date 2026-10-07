import { useSyncExternalStore } from "react";

export interface TerminalDialogSession {
  workspaceId: string;
  sessionId: string;
  initialTitle?: string;
}

let shownSession: TerminalDialogSession | null = null;
const listeners = new Set<() => void>();

function setShownSession(next: TerminalDialogSession | null): void {
  shownSession = next;
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Show a terminal session in the in-app TerminalDialog. Returns false while it shows another
 * session: replacing that one would leave its shell running with nothing attached.
 */
export function showTerminalDialog(session: TerminalDialogSession): boolean {
  if (shownSession != null) {
    return false;
  }
  setShownSession(session);
  return true;
}

/** Hide the dialog if it still shows this session, so a late call for an old one is a no-op. */
export function hideTerminalDialog(sessionId: string): void {
  if (shownSession?.sessionId !== sessionId) {
    return;
  }
  setShownSession(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getShownSession(): TerminalDialogSession | null {
  return shownSession;
}

export function useTerminalDialogSession(): TerminalDialogSession | null {
  return useSyncExternalStore(subscribe, getShownSession);
}
