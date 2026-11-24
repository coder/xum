/**
 * Longest delay `setTimeout` honors (the signed 32-bit millisecond maximum, about 24.8 days).
 * Longer delays fire at once, so waits beyond it must be chunked.
 */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
