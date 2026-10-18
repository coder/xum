/**
 * The oldest Node major `xum server` supports (#6968). The `ai` and `@ai-sdk/*` runtime
 * dependencies declare engines.node ">=22", and backend code calls Promise.withResolvers (Node 22)
 * without a polyfill, so an older Node starts and then fails later with a TypeError. package.json
 * engines.node must stay `>=${MIN_NODE_MAJOR}` (nodeVersion.test.ts checks it).
 */
export const MIN_NODE_MAJOR = 22;

/**
 * The one-line warning for a Node older than MIN_NODE_MAJOR, or undefined. Electron (the desktop
 * app) bundles its own, newer Node, and Bun reports a high Node version, so both never warn. Never
 * throws: a version it cannot parse gives undefined.
 */
export function nodeVersionWarning(
  versions: Record<string, string | undefined>
): string | undefined {
  if ("electron" in versions || "bun" in versions) return undefined;
  const nodeVersion = versions.node;
  const major = Number(/^(\d+)\./.exec(nodeVersion ?? "")?.[1]);
  if (!Number.isInteger(major) || major >= MIN_NODE_MAJOR) return undefined;
  return `xum: Node ${nodeVersion} is not supported. xum server needs Node ${MIN_NODE_MAJOR} or newer. Some features fail on older versions.`;
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
