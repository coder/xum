import { useEffect } from "react";

import type { ChatInputProps } from "./types";

/**
 * #6038: tells the creation page whether its composer can send right now, so actions that send
 * through the composer (the "Run /init" banner) stay off while it cannot, instead of being
 * refused silently. The state lives in the composer (the branch list it loads), so the page learns
 * it from this report; an effect is the sync point because the state changes on load, not on an
 * event the page sees.
 */
export function useReportCreationSendBlocked(blocked: boolean, props: ChatInputProps): void {
  // Only the creation variant reports; a workspace composer has no such page.
  const report = props.variant === "creation" ? props.onCreationSendBlockedChange : undefined;
  useEffect(() => {
    report?.(blocked);
  }, [blocked, report]);
}
