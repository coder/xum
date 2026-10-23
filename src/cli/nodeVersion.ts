/**
 * The oldest Node major `xum server` supports (#6968). The `ai` and `@ai-sdk/*` runtime
 * dependencies declare engines.node ">=22", and backend code calls Promise.withResolvers (Node 22)
 * without a polyfill, so an older Node starts and then fails later with a TypeError.
 */
export const MIN_NODE_MAJOR = 22;

/**
 * The first release of each Node line that fixes CVE-2026-111497 ("Node2Shell"), an out-of-bounds
 * write in Node's bundled Brotli decoder that lets crafted Brotli data run code. Lines 23 and 25
 * never got the fix; lines after the last entry include it. package.json engines.node is derived
 * from this table (nodeVersion.test.ts checks it), and the Docker build fails on an affected Node.
 */
export const BROTLI_FIXED_NODE_RELEASES = [
  [22, 23, 4],
  [24, 22, 1],
  [26, 12, 1],
] as const;

type NodeRelease = readonly [number, number, number];

function parseRelease(version: string): NodeRelease | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareReleases(a: NodeRelease, b: NodeRelease): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function hasBrotliFix(release: NodeRelease): boolean {
  const newestLine = BROTLI_FIXED_NODE_RELEASES[BROTLI_FIXED_NODE_RELEASES.length - 1];
  if (release[0] > newestLine[0]) return true;
  const fixed = BROTLI_FIXED_NODE_RELEASES.find((fixedRelease) => fixedRelease[0] === release[0]);
  return fixed !== undefined && compareReleases(release, fixed) >= 0;
}

/**
 * The one-line warning for a Node older than MIN_NODE_MAJOR or affected by CVE-2026-111497, or
 * undefined. Electron (the desktop app) bundles its own Node, and Bun reports a high Node version,
 * so both never warn. Never throws: a version it cannot parse gives undefined.
 */
export function nodeVersionWarning(
  versions: Record<string, string | undefined>
): string | undefined {
  if ("electron" in versions || "bun" in versions) return undefined;
  const nodeVersion = versions.node;
  if (nodeVersion === undefined) return undefined;
  const major = Number(/^(\d+)\./.exec(nodeVersion)?.[1]);
  if (!Number.isInteger(major)) return undefined;
  if (major < MIN_NODE_MAJOR) {
    return `xum: Node ${nodeVersion} is not supported. xum server needs Node ${MIN_NODE_MAJOR} or newer. Some features fail on older versions.`;
  }
  const release = parseRelease(nodeVersion);
  if (release === undefined || hasBrotliFix(release)) return undefined;
  const fixedReleases = BROTLI_FIXED_NODE_RELEASES.map((fixed) => fixed.join(".")).join(", ");
  return `xum: Node ${nodeVersion} is affected by CVE-2026-111497: crafted Brotli data can run code. Upgrade to Node ${fixedReleases} or a later release of the same line.`;
}

/**
 * Print the warning to stderr only, never stdout: `xum api` and other commands write
 * machine-readable output to stdout. Never exits: the user can still run what works.
 */
export function warnIfUnsupportedNode(
  versions: Record<string, string | undefined> = process.versions
): void {
  const warning = nodeVersionWarning(versions);
  if (warning !== undefined) console.error(warning);
}
