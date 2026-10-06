/**
 * Restart-stable identity for the bash AI proxy: the listener port and the workspace keys.
 *
 * Why: a bash command bakes ANTHROPIC_BASE_URL and the key into its environment when it starts.
 * A background process (a bug bash, a long test run) that outlives a Xum restart must still
 * reach the proxy and still be accepted. So nothing here is random per process:
 * - Ports come from a fixed candidate list hashed from a seed (the Xum root dir), so the same
 *   root asks for the same port again after a restart. A busy candidate moves to the next one,
 *   and different roots (other users, dev sandboxes) ask for different ports.
 * - A key is `xum-proxy-<workspaceId>-<HMAC(secret, workspaceId)>`. The secret is created once
 *   in the Xum root (proxyState.ts), so a key verifies again after a restart without any key
 *   store. Deleting the state file rotates every key.
 */
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const BASH_AI_PROXY_KEY_PREFIX = "xum-proxy-";
/** Unauthenticated health endpoint: `?nonce=<hex>` gets healthAnswer(). */
export const BASH_AI_PROXY_HEALTH_PATH = "/__xum/health";

// Below the Linux ephemeral range (32768+), so outgoing connections do not take these ports.
const PORT_RANGE_START = 20000;
const PORT_RANGE_SIZE = 12000;
const HMAC_HEX_LENGTH = 64;

/** Deterministic, distinct ports for `seed`; try them in order. */
export function candidatePorts(seed: string, count: number): number[] {
  assert(seed.length > 0, "candidatePorts requires a seed");
  assert(count > 0 && count <= PORT_RANGE_SIZE, "candidatePorts count out of range");
  const ports: number[] = [];
  for (let i = 0; ports.length < count; i++) {
    const digest = createHash("sha256").update(`${seed}\0${i}`).digest();
    const port = PORT_RANGE_START + (digest.readUInt32BE(0) % PORT_RANGE_SIZE);
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}

// Distinct labels keep a key MAC and a health answer from ever being the same value.
function mac(secret: string, label: "key" | "health", value: string): string {
  return createHmac("sha256", secret).update(`bash-ai-proxy:${label}:${value}`).digest("hex");
}

export function deriveProxyKey(secret: string, workspaceId: string): string {
  assert(workspaceId.length > 0, "deriveProxyKey requires a workspaceId");
  return `${BASH_AI_PROXY_KEY_PREFIX}${workspaceId}-${mac(secret, "key", workspaceId)}`;
}

/** The workspace a key names, or undefined if its MAC does not verify. */
export function verifyProxyKey(secret: string, key: string): string | undefined {
  if (!key.startsWith(BASH_AI_PROXY_KEY_PREFIX)) return undefined;
  const body = key.slice(BASH_AI_PROXY_KEY_PREFIX.length);
  const dash = body.lastIndexOf("-");
  if (dash <= 0) return undefined;
  const workspaceId = body.slice(0, dash);
  const given = body.slice(dash + 1);
  // Hex only: a non-ASCII header would give timingSafeEqual buffers of different lengths.
  if (!new RegExp(`^[0-9a-f]{${HMAC_HEX_LENGTH}}$`).test(given)) return undefined;
  const expected = mac(secret, "key", workspaceId);
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected)) ? workspaceId : undefined;
}

/** A fresh challenge for one health probe. */
export function newHealthNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * What the health endpoint answers for `nonce`. Challenge and response: it proves the listener
 * holds this Xum root's secret right now, so a stranger who recorded an earlier answer and binds
 * a forwarded port on a shared host cannot pass. It reveals nothing about the keys.
 */
export function healthAnswer(secret: string, nonce: string): string {
  return `xum-bash-ai-proxy ${mac(secret, "health", nonce)}`;
}

export function isHealthNonce(value: string | null): value is string {
  return value !== null && /^[0-9a-f]{32}$/.test(value);
}
