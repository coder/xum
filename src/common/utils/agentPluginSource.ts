/**
 * Clone URL without scheme and `.git` ("github.com/foo/grill"), so a monorepo
 * folder appended to it reads as a path, not as an invalid `….git/pstack` URL.
 * Shared by Settings and the description of a generated plugin.json.
 */
export function displayRepoUrl(url: string): string {
  return url
    .replace(/^https:\/\//, "")
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/\.git$/, "");
}

/**
 * True for a path or `file://` URL: a repository only this machine can reach. The check is the
 * same on every platform (a backup written on Linux is read on Windows): a leading `/` or `\`
 * covers POSIX paths, Windows rooted paths, UNC shares and NT-namespace spellings such as
 * `/??/UNC/host/share`, which Git for Windows can turn into an SMB open.
 */
function isLocalGitUrl(url: string): boolean {
  return /^file:\/\//i.test(url) || /^[~\\/]/.test(url) || /^[a-zA-Z]:[\\/]/.test(url);
}

/** The host of a scheme URL (`ssh://`, `https://`, …) or of an SCP form (`user@host:path`). */
function gitUrlHost(url: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      return new URL(url).hostname;
    } catch {
      return undefined;
    }
  }
  return /^(?:[^@/]+@)?(\[[^\]]+\]|[^:/]+):/.exec(url)?.[1];
}

// 127.0.0.0/8, and its IPv4-mapped IPv6 form after WHATWG normalization (::ffff:7f00:1).
const LOOPBACK_ADDRESS_PATTERN = /^(?:127\.|::ffff:7f)/;
// 0.0.0.0 and :: reach this machine on Linux and macOS.
const LOOPBACK_ADDRESSES = new Set(["0.0.0.0", "::1", "::", "::ffff:0:0"]);

/** localhost, 127.0.0.0/8, 0.0.0.0 and the IPv6 loopback, in any spelling git accepts. */
function isLoopbackHost(rawHost: string): boolean {
  const host = rawHost
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  let normalized: string;
  try {
    // WHATWG parsing normalizes IPv4 spellings (127.1, 2130706433, 0x7f000001) and IPv6.
    normalized = new URL(`http://${host.includes(":") ? `[${host}]` : host}/`).hostname;
  } catch {
    return false;
  }
  normalized = normalized.replace(/^\[|\]$/g, "");
  return LOOPBACK_ADDRESS_PATTERN.test(normalized) || LOOPBACK_ADDRESSES.has(normalized);
}

/**
 * True for a repository on this machine: a path, a file:// URL, or a URL whose host is this
 * machine (git would reach it with the user's own SSH keys). Fails closed: a remote-looking URL
 * whose host Xum cannot read counts as this machine.
 */
export function pointsAtThisMachine(url: string): boolean {
  if (isLocalGitUrl(url)) return true;
  const host = gitUrlHost(url);
  return host === undefined || isLoopbackHost(host);
}
