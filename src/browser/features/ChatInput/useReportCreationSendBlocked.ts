import { useEffect } from "react";

import type { ChatInputProps } from "./types";

/**
 * Why the creation composer's Send is off right now, apart from an empty draft (the banner brings
 * its own text). These are the same terms canSend checks.
 */
export interface CreationSendBlockers {
  /** The composer is disabled, or its initial staging is locked. */
  disabled: boolean;
  /** A send is already in flight. */
  sendInFlight: boolean;
  /** Attachments are still being processed. */
  processingAttachments: boolean;
  /** Coder presets are loading (a send could bypass preset validation). */
  coderPresetsLoading: boolean;
  /** The branch list is loading or failed, for a runtime that needs a trunk (#6033, #6055). */
  branchesNotLoaded: boolean;
}

/**
 * #6038, #6423: tells the creation page whether its composer can send right now, so actions that
 * send through the composer (the "Run /init" banner) stay off whenever Send is off, instead of
 * being refused silently. The state lives in the composer, so the page learns it from this
 * report; an effect is the sync point because the state changes on loads and sends the page does
 * not see.
 */
export function useReportCreationSendBlocked(
  blockers: CreationSendBlockers,
  props: ChatInputProps
): void {
  // Only the creation variant reports; a workspace composer has no such page.
  const report = props.variant === "creation" ? props.onCreationSendBlockedChange : undefined;
  const blocked = Object.values(blockers).some(Boolean);
  useEffect(() => {
    report?.(blocked);
  }, [blocked, report]);
}
