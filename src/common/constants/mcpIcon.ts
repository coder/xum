/** Untrusted MCP artwork is bounded before fetching, decoding, caching, and rendering. */
export const MCP_ICON_LIMITS = {
  bodyMaxBytes: 512 * 1024,
  svgMaxBytes: 256 * 1024,
  pngMaxBytes: 32 * 1024,
  pngDataUrlMaxChars: 48_000,
  outputSize: 64,
  inputMaxPixels: 16_000_000,
  deadlineMs: 8_000,
  agentCloseTimeoutMs: 1_000,
  decodeTimeoutSeconds: 3,
  concurrentJobs: 2,
  queuedJobs: 8,
  svgMaxDepth: 16,
  svgMaxNodes: 1_000,
  svgAttributeMaxChars: 32_768,
  svgCoordinateMaxExclusive: 1_000_000,
  registryMaxEntries: 200,
  registryMaxBytes: 2 * 1024 * 1024,
  successTtlMs: 24 * 60 * 60 * 1000,
  failureTtlMs: 10 * 60 * 1000,
} as const;

export const MCP_ICON_PNG_PREFIX = "data:image/png;base64,";
export const MCP_ICON_PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
