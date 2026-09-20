import * as net from "node:net";

/**
 * Pure SSRF target validators shared by outbound fetchers (web_fetch, MCP icon
 * fetching). Hostnames and addresses that resolve to loopback, private,
 * link-local, multicast, or well-known internal service names are blocked.
 * Moved verbatim from web_fetch.ts so every network path applies one rule set.
 */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "host.docker.internal",
  "gateway.docker.internal",
  "kubernetes.default.svc",
]);

export function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim();
  const withoutBrackets =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return withoutBrackets.replace(/\.$/, "").toLowerCase();
}

function parseIpv4Octets(address: string): number[] | null {
  if (net.isIP(address) !== 4) {
    return null;
  }

  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (
    octets.length !== 4 ||
    octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }

  return octets;
}

function normalizeIpv6Address(address: string): string {
  let normalized = address.trim().toLowerCase();
  const zoneIndex = normalized.indexOf("%");
  if (zoneIndex !== -1) {
    normalized = normalized.slice(0, zoneIndex);
  }
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  return normalized;
}

function parseIpv6Segments(address: string): number[] | null {
  let normalized = normalizeIpv6Address(address);
  if (net.isIP(normalized) !== 6) {
    return null;
  }

  if (normalized.includes(".")) {
    const lastColonIndex = normalized.lastIndexOf(":");
    if (lastColonIndex === -1) {
      return null;
    }

    const ipv4Octets = parseIpv4Octets(normalized.slice(lastColonIndex + 1));
    if (!ipv4Octets) {
      return null;
    }

    normalized = `${normalized.slice(0, lastColonIndex)}:${((ipv4Octets[0] << 8) | ipv4Octets[1]).toString(16)}:${((ipv4Octets[2] << 8) | ipv4Octets[3]).toString(16)}`;
  }

  const pieces = normalized.split("::");
  if (pieces.length > 2) {
    return null;
  }

  const head = pieces[0] ? pieces[0].split(":") : [];
  const tail = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
  if (pieces.length === 1 && head.length !== 8) {
    return null;
  }

  const missingSegmentCount = 8 - head.length - tail.length;
  if (missingSegmentCount < 0) {
    return null;
  }

  const rawSegments =
    pieces.length === 2
      ? [...head, ...Array.from({ length: missingSegmentCount }, () => "0"), ...tail]
      : head;
  if (rawSegments.length !== 8) {
    return null;
  }

  const segments: number[] = [];
  for (const segment of rawSegments) {
    if (!/^[0-9a-f]{1,4}$/i.test(segment)) {
      return null;
    }
    segments.push(Number.parseInt(segment, 16));
  }

  return segments;
}

// URL parsing canonicalizes dotted IPv4 tails (for example ::127.0.0.1 becomes ::7f00:1),
// so block checks need to recognize both deprecated IPv4-compatible ::/96 and
// IPv4-mapped ::ffff:0:0/96 forms from their normalized IPv6 segments.
function ipv4FromEmbeddedIpv6Segments(segments: number[]): string | null {
  if (
    segments.length !== 8 ||
    !segments.slice(0, 5).every((segment) => segment === 0) ||
    (segments[5] !== 0 && segments[5] !== 0xffff)
  ) {
    return null;
  }

  return [segments[6] >> 8, segments[6] & 0xff, segments[7] >> 8, segments[7] & 0xff].join(".");
}

function isBlockedIpv4Address(address: string): boolean {
  const octets = parseIpv4Octets(address);
  if (!octets) {
    return false;
  }

  const [first, second] = octets;
  if (first === 0 || first === 10 || first === 127) {
    return true;
  }
  if (first === 100 && second >= 64 && second <= 127) {
    return true;
  }
  if (first === 169 && second === 254) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  if (first === 198 && (second === 18 || second === 19)) {
    return true;
  }
  if (first >= 224) {
    return true;
  }

  return false;
}

function isBlockedIpv6Address(address: string): boolean {
  const segments = parseIpv6Segments(address);
  if (!segments) {
    return false;
  }

  const embeddedIpv4 = ipv4FromEmbeddedIpv6Segments(segments);
  if (embeddedIpv4) {
    return isBlockedIpAddress(embeddedIpv4);
  }

  if (segments.every((segment) => segment === 0)) {
    return true;
  }
  if (segments.slice(0, 7).every((segment) => segment === 0) && segments[7] === 1) {
    return true;
  }

  const firstSegment = segments[0];
  if ((firstSegment & 0xfe00) === 0xfc00) {
    return true;
  }
  if ((firstSegment & 0xffc0) === 0xfe80) {
    return true;
  }
  if ((firstSegment & 0xffc0) === 0xfec0) {
    return true;
  }
  if ((firstSegment & 0xff00) === 0xff00) {
    return true;
  }

  return false;
}

export function isBlockedIpAddress(address: string): boolean {
  return isBlockedIpv4Address(address) || isBlockedIpv6Address(address);
}

export function isBlockedHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    return true;
  }

  return (
    BLOCKED_HOSTNAMES.has(normalized) ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  );
}
