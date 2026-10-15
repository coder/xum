import React, { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";

import { cn } from "@/common/lib/utils";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { WINDOWS_TOOLCHAIN_BANNER_DISMISSED_KEY } from "@/common/constants/storage";

const DISMISS_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Banner shown on Windows when the default shell appears to be WSL.
 * Users can dismiss it, but it will re-appear after 30 days.
 */
export function WindowsToolchainBanner(props: {
  /**
   * The app shell's sidebar toggle bar spacer, while the fixed bar sits over this banner (left
   * sidebar collapsed), so the warning starts after the bar instead of under it.
   */
  toggleBarSpacer?: React.ReactNode;
}) {
  const [dismissedAt, setDismissedAt] = usePersistedState<number | null>(
    WINDOWS_TOOLCHAIN_BANNER_DISMISSED_KEY,
    null
  );

  const [isWslShell, setIsWslShell] = useState<boolean | null>(() => {
    if (window.api?.platform && window.api.platform !== "win32") {
      return false;
    }

    // Prefer the sync preload signal if present.
    if (window.api?.isWindowsWslShell === true) return true;
    if (window.api?.isWindowsWslShell === false) return false;

    return null;
  });

  useEffect(() => {
    if (isWslShell !== null) return;

    let cancelled = false;

    (async () => {
      try {
        const result = await window.api?.getIsWindowsWslShell?.();
        if (!cancelled) setIsWslShell(result === true);
      } catch {
        if (!cancelled) setIsWslShell(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isWslShell]);

  const now = Date.now();
  const isDismissed = dismissedAt !== null && now < dismissedAt + DISMISS_DURATION_MS;

  if (isWslShell !== true || isDismissed) return null;

  return (
    <div
      className={cn(
        "bg-warning/10 border-warning/30 text-warning flex items-center justify-between gap-3 border-b px-4 py-2 text-sm",
        props.toggleBarSpacer != null && "pl-0"
      )}
    >
      <div className="flex items-center gap-2">
        {props.toggleBarSpacer}
        <AlertTriangle className="text-warning size-4 shrink-0" />
        <span>
          Your default shell appears to be WSL. Xum requires Git for Windows (Git Bash) on Windows
          for reliable git + path handling.
          <a
            href="https://mux.coder.com/install#windows"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:no-underline"
          >
            Install Git for Windows
          </a>{" "}
          and restart Xum.
        </span>
      </div>
      <button
        type="button"
        onClick={() => setDismissedAt(now)}
        className="hover:text-warning/80 shrink-0 p-1 transition-colors"
        aria-label="Dismiss Windows toolchain warning"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
