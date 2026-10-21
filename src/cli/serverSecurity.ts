import { randomBytes } from "crypto";
import { isLoopbackHost } from "@/common/utils/loopbackHost";

export { isLoopbackHost } from "@/common/utils/loopbackHost";

export interface ResolvedAuthToken {
  /** The token to use (undefined = no auth required). */
  token: string | undefined;
  /** Whether this token was auto-generated (vs. explicitly provided). */
  generated: boolean;
}

/**
 * Resolve the effective auth token for the server.
 *
 * Policy:
 * - If an explicit token or env var is provided, use it.
 * - If the host is loopback and no token is provided, allow unauthenticated (local dev).
 * - If the host is non-loopback and no token is provided, generate a secure ephemeral token.
 */
export function resolveServerAuthToken(
  host: string,
  explicitToken?: string,
  envToken?: string
): ResolvedAuthToken {
  const explicit = explicitToken?.trim();
  const env = envToken?.trim();
  const provided = explicit && explicit.length > 0 ? explicit : env && env.length > 0 ? env : null;
  if (provided != null) return { token: provided, generated: false };
  if (isLoopbackHost(host)) return { token: undefined, generated: false };
  const token = randomBytes(32).toString("hex");
  return { token, generated: true };
}
