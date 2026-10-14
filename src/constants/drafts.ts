/**
 * Composer draft limits and identifiers shared by the backend DraftService and the renderer.
 *
 * Drafts (text + attachments, provider attachments as base64 data URLs) used to live in renderer
 * localStorage and exhausted its quota; they now live on the backend.
 */

/**
 * Largest accepted draft, measured as the UTF-8 byte length of the JSON `{ text, attachments }`
 * (bytes, not UTF-16 code units: non-ASCII text takes up to 3 bytes per code unit on the wire).
 *
 * Kept below the smallest transport limit an update travels through: server-mode HTTP parses
 * `/orpc` bodies with `express.json({ limit: "50mb" })` (src/node/orpc/server.ts), the WebSocket
 * server accepts ws's default 100 MiB, and Electron's MessagePort has no practical limit. 40 MiB
 * leaves headroom for the request envelope below the 50 MB HTTP cap.
 */
export const MAX_DRAFT_JSON_BYTES = 40 * 1024 * 1024;

/** Creation draft ids become file names on the backend, so they are restricted to a safe set. */
export const DRAFT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Draft id of a project's default creation composer (the project page opened without a draft
 * id). Generated draft ids are UUIDs, so this fixed id never collides with a listed draft, and the
 * backend never lists it.
 */
export const DEFAULT_CREATION_DRAFT_ID = "default";

/**
 * Longest the app waits for the drafts subscription's first snapshot (and the legacy import)
 * before composers may render anyway; hydration continues in the background.
 */
export const DRAFT_STORE_READY_TIMEOUT_MS = 10_000;
