/**
 * Shown when a send/edit/clear/reset is refused because the visible transcript is not yet a
 * verified copy of the backend history (replay still in flight or failed). Shared by the
 * composer toast, palette/slash errors and plan-proposal buttons.
 */
export const TRANSCRIPT_NOT_CAUGHT_UP_MESSAGE =
  "Transcript is still loading — wait until it is up to date before sending or editing.";

/** Plain banner text while a failed history replay keeps retrying. */
export const TRANSCRIPT_REPLAY_FAILED_BANNER = "Transcript could not be loaded — retrying";
