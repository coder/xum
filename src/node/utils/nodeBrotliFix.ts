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

/** Whether a Node version has the CVE-2026-111497 fix, or undefined when it cannot be parsed. */
export function nodeHasBrotliFix(version: string): boolean | undefined {
  const release = parseRelease(version);
  if (release === undefined) return undefined;
  const newestLine = BROTLI_FIXED_NODE_RELEASES[BROTLI_FIXED_NODE_RELEASES.length - 1];
  if (release[0] > newestLine[0]) return true;
  const fixed = BROTLI_FIXED_NODE_RELEASES.find((fixedRelease) => fixedRelease[0] === release[0]);
  return fixed !== undefined && compareReleases(release, fixed) >= 0;
}
