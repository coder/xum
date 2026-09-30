/**
 * Shown when a send/edit/clear/reset is refused because the visible transcript is not yet a
 * verified copy of the backend history (replay still in flight or failed). Shared by the
 * composer toast, palette/slash errors and plan-proposal buttons.
 */
export const TRANSCRIPT_NOT_CAUGHT_UP_MESSAGE =
  "Transcript is still loading — wait until it is up to date before sending or editing.";

/** Plain banner text while a failed history replay keeps retrying. */
export const TRANSCRIPT_REPLAY_FAILED_BANNER = "Transcript could not be loaded — retrying";

/**
 * Shown when the backend refused an edit because the rows it would delete changed after the
 * client captured its evidence (`history-changed`). Recovery is an explicit review + re-send.
 */
export const EDIT_HISTORY_CHANGED_MESSAGE =
  "History changed — review the transcript, then send again.";

/** Edit refused before it starts: the client does not hold the row, so it cannot fence the edit. */
export const EDIT_NOT_HELD_MESSAGE =
  "This message is not in the loaded transcript, so it cannot be edited yet.";

/** Conflict recovery re-read history to its start and the edited message is gone. */
export const EDIT_TARGET_GONE_MESSAGE =
  "The edited message no longer exists. Your text was kept as a new draft.";

/** Composer action after a failed conflict-recovery refresh; starts a new refresh request. */
export const EDIT_RETRY_REFRESH_LABEL = "Retry refresh";
