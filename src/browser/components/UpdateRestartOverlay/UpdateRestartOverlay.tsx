import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useAPI } from "@/browser/contexts/API";
import { LoadingScreen } from "@/browser/components/LoadingScreen/LoadingScreen";

/**
 * Full-viewport cover shown from the moment an update install is confirmed (status
 * "restarting") until the relaunched backend reports a different status. It replaces the old
 * UI immediately, while the desktop app is still quitting or the server is tearing down.
 */
export function UpdateRestartOverlay() {
  const { api } = useAPI();
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    // Deliberately no reset when api is null: the client passes through "reconnecting" with
    // api === null while the server restarts, and the overlay must stay up until the relaunched
    // server's first status event (idle/unsupported) replaces it.
    if (!api) {
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;

    (async () => {
      try {
        const iterator = await api.update.onStatus(undefined, { signal });
        for await (const status of iterator) {
          if (signal.aborted) {
            break;
          }
          setRestarting(status.type === "restarting");
        }
      } catch (error) {
        if (!signal.aborted) {
          console.error("Update status stream error:", error);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [api]);

  if (!restarting) {
    return null;
  }

  // Portaled to <body>, outside the app root: an open Radix modal (the About dialog is the usual
  // install trigger) marks the app root aria-hidden and locks body pointer events, so rendering
  // inside it would hide the status from assistive technology; pointer-events-auto keeps clicks
  // from falling through the cover. Stacked above dialogs, toasts, and menus so nothing from the
  // old UI peeks through.
  return createPortal(
    <div
      className="bg-surface-primary pointer-events-auto fixed inset-0 z-[10002]"
      data-testid="update-restart-overlay"
    >
      <LoadingScreen statusText="Restarting Xum…" />
    </div>,
    document.body
  );
}
