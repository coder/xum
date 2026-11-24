// This cap applies to both model attachments and display-only fallback files so
// chat history never persists unexpectedly large base64 payloads.
//
// Kept in its own module so light consumers (the artifacts read path, which the
// `xum api` ESM bundle reaches through the oRPC router) do not pull in the image
// resize code and its `node:module` import, which collides with the bundle banner.
export const MAX_ATTACH_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
