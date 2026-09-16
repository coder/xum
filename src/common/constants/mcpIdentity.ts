/**
 * Bounds for server-reported MCP identity (`Implementation` metadata) as it
 * is displayed, persisted per tool call, and returned from connection tests.
 *
 * Identity is self-reported and display-only, so every field is capped: the
 * schema (`MCPServerIdentitySchema` & co.) rejects values above these limits,
 * and the normalizer (`normalizeServerIdentity`) truncates raw server input
 * to fit them. Character limits count UTF-16 code units (what zod's string
 * `max` measures); `displaySnapshotMaxBytes` is the aggregate UTF-8 size of
 * the JSON-serialized per-call snapshot — required fields at their maximum
 * (3-byte BMP characters, longest ASCII origin) always fit beneath it, only
 * optional fields ever need trimming.
 */
export const MCP_IDENTITY_LIMITS = {
  nameMaxChars: 80,
  versionMaxChars: 60,
  titleMaxChars: 80,
  descriptionMaxChars: 300,
  websiteUrlMaxChars: 512,
  /** Configured server key as shown next to the identity. */
  connectionKeyMaxChars: 80,
  /** `https://` + 253-char hostname + `:65535` fits; origins are ASCII, so bytes == chars. */
  originMaxBytes: 270,
  /** UTF-8 bytes of `JSON.stringify(MCPToolCallDisplay)`; persisted on every MCP tool part. */
  displaySnapshotMaxBytes: 2_048,
  /** Icon candidates kept from `Implementation.icons` (resolution happens elsewhere). */
  iconCandidatesMax: 8,
  iconHttpsSrcMaxChars: 2_048,
  /** Encoded `data:` URL length; the decoded payload is bounded again by the icon pipeline. */
  iconDataSrcMaxChars: 700 * 1024,
} as const;
