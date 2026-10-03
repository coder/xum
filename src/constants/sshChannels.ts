/**
 * Upper bound for a channel open with no caller deadline. A pending open holds a pool slot
 * (reserveChannel), so the idle timer no longer ends a client whose server never answers the
 * open; before the slot, the idle close (IDLE_TIMEOUT_MS) bounded such opens by accident. Keep
 * it longer than the idle window so a slow but live open still succeeds.
 */
export const SSH2_CHANNEL_OPEN_TIMEOUT_MS = 2 * 60 * 1000;
