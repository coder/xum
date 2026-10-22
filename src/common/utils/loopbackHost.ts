/**
 * Check if a host string is a literal loopback address.
 *
 * Only matches literal IPv4/IPv6 loopback addresses and "localhost".
 * Hostnames that happen to start with "127." (e.g., "127.example.com") are
 * NOT treated as loopback — this matters for auth-token generation policy.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();

  // Strip IPv6 brackets if present (e.g., "[::1]" → "::1").
  const bare =
    normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;

  return bare === "localhost" || bare === "::1" || isIpv4Loopback(bare);
}

// Match 127.x.y.z only for literal IPv4 addresses (4 numeric octets, 0-255).
// This prevents hostnames like "127.example.com" from being misclassified.
function isIpv4Loopback(host: string): boolean {
  const parts = host.split(".");
  return (
    parts[0] === "127" &&
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  );
}
