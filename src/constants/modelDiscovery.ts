// Discovery is interactive and read-only; bound the entire catalog, not each page.
export const MODEL_DISCOVERY_LIMITS = {
  timeoutMs: 10_000,
  pages: 10,
  items: 10_000,
  bytes: 2 * 1024 * 1024,
} as const;
