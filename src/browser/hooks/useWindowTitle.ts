import { useEffect } from "react";
import type { APIClient } from "@/browser/contexts/API";

/**
 * Shows `title` as the window title: document.title in browser mode, and the backend sets it
 * for Electron. A new client (a reconnect) sets it again, so a title the backend missed while
 * offline is not lost.
 */
export function useWindowTitle(api: APIClient | null, title: string): void {
  useEffect(() => {
    document.title = title;
    // Best-effort: offline the kept client's call fails at once (ConnectionLostError), and an
    // unhandled rejection is noise. The next client runs this effect again.
    api?.window
      .setTitle({ title })
      .catch((error: unknown) => console.debug("[useWindowTitle] Window title not set:", error));
  }, [api, title]);
}
