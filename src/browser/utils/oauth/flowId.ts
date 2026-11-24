/**
 * A caller-generated OAuth flow ID. The frontend knows it before the start RPC returns, so
 * Cancel can reach a flow that is still starting. It doubles as the OAuth `state` (CSRF
 * token), so it must be unguessable: derived from getRandomValues, which (unlike
 * Crypto.randomUUID) is available outside secure contexts too. Xum's browser UI can be served
 * from a plain-HTTP remote origin, where randomUUID is undefined.
 */
export function createOAuthFlowId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
