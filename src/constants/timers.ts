/**
 * Longest delay `setTimeout` honors (the signed 32-bit millisecond maximum, about 24.8 days).
 * Longer delays fire at once, so waits beyond it must be chunked.
 */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

// Generous relative to the expected cost (each source is roughly one local
// IPC round trip resolved in parallel), tight enough that a wedged source
// degrades to "decorations pop in late" instead of "chat looks broken".
// The transcript's wait for the lazy tool cards (toolCardsStore) uses the same bound.
export const CHAT_VIEW_DATA_READY_TIMEOUT_MS = 2_000;
