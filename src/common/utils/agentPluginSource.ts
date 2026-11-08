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
 * `/??/UNC/host/share` and `\\?\C:\repo.git`, which Git for Windows can turn into an SMB open.
 *
 * A first character and a colon read as a drive, `C:\repo.git` and the drive-relative `C:repo.git`
 * alike: Git for Windows decides so for any one character, not only a letter
 * (`url_is_local_not_ssh` in connect.c with `win32_has_dos_drive_prefix`). An scp URL whose host
 * has one character and no user (`h:org/repo.git`) reads the same there, so it counts as local
 * too. One with a user (`git@h:org/repo.git`) does not start with a drive, and stays remote.
 */
function isLocalGitUrl(url: string): boolean {
  return /^file:\/\//i.test(url) || /^[~\\/]/.test(url) || /^.:/su.test(url);
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

/**
 * Validate and normalize a repo-relative plugin folder (`a/b/c`). Throws a
 * user-facing error for anything that could leave the repository or be read
 * as a pattern: absolute paths, `.`/`..`/empty segments, `.git`, control
 * characters, and sparse-checkout/glob specials (`* ? [ ] \ ! #`). Applied
 * to parsed shorthand and again at the installer boundary, because registry
 * entries and direct API sources never pass through the parser.
 */
export function normalizeAgentPluginSubpath(raw: string): string {
  let subpath = raw.trim();
  if (subpath.endsWith("/")) {
    subpath = subpath.slice(0, -1);
  }
  if (subpath.length === 0) {
    throw new Error("The plugin subpath must not be empty.");
  }
  // `/abs`, `~/home`, and Windows drive letters (`C:`).
  if (/^(?:[/~]|[a-zA-Z]:)/.test(subpath)) {
    throw new Error(
      `'${subpath}' is an absolute path. The plugin subpath must be relative to the repository root.`
    );
  }
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(subpath)) {
    throw new Error("The plugin subpath must not contain control characters.");
  }
  if (/[*?[\]\\!#]/.test(subpath)) {
    throw new Error(
      `'${subpath}' contains a character that is not allowed in a plugin subpath (* ? [ ] \\ ! #).`
    );
  }
  for (const segment of subpath.split("/")) {
    assertValidSubpathSegment(subpath, segment);
  }
  return subpath;
}

function assertValidSubpathSegment(subpath: string, segment: string): void {
  if (segment.length === 0 || segment === "." || segment === "..") {
    throw new Error(
      `'${subpath}' is not a valid plugin subpath. Use a folder path inside the repository, like path/to/plugin (no empty, '.' or '..' parts).`
    );
  }
  if (segment.toLowerCase() === ".git") {
    throw new Error(`'${subpath}' points into the .git folder, which is not a plugin folder.`);
  }
  if (segment !== segment.trim()) {
    throw new Error(
      `'${subpath}' has a path part that starts or ends with whitespace, which is not allowed in a plugin subpath.`
    );
  }
}

/**
 * True when `subpath` is already the form `normalizeAgentPluginSubpath` returns for it. The
 * installer takes only that form (`assertNormalizedSubpath` in installService.ts), so a stored
 * source that is not in it cannot be previewed or installed.
 */
export function isNormalizedAgentPluginSubpath(subpath: string): boolean {
  try {
    return normalizeAgentPluginSubpath(subpath) === subpath;
  } catch {
    return false;
  }
}

/**
 * True for a 7 to 39 digit hex ref: git reads it as a short commit id, which a shallow fetch cannot
 * resolve, so the installer refuses it as a branch or tag name (`resolveRemoteRef`).
 */
export function isAbbreviatedCommitSha(ref: string): boolean {
  return /^[0-9a-f]{7,39}$/i.test(ref);
}

/**
 * True when `url` spells an unreserved character (ALPHA, DIGIT, `-`, `.`, `_`, `~`) as a percent
 * escape. RFC 3986 section 2.3 says a producer must not do that, and every secret token is built
 * from those characters: the publish-time scan reads the list as written, so `%67hp_...` would
 * pass it. An escape of any other character (`%20` in `My%20Project`) is the only spelling it
 * has, so it stays.
 */
export function hasEscapedUnreservedCharacter(url: string): boolean {
  for (const [, hex] of url.matchAll(/%([0-9A-Fa-f]{2})/g)) {
    if (/^[A-Za-z0-9._~-]$/.test(String.fromCharCode(Number.parseInt(hex ?? "", 16)))) return true;
  }
  return false;
}

const SSH_URL_PATTERN =
  /^ssh:\/\/(?:[^@/?#\s]+@)?(\[[^\]\s]+\]|[^:/?#\s@[\]]+)(?::\d+)?(\/[^?#\s]+)$/i;
const SCP_URL_PATTERN = /^(?:[^@/\s:]+@)?(\[[^\]\s]+\]|[A-Za-z0-9._-]{2,}):(?!:|\/\/)(\S+)$/;

/**
 * The https URL of the same host and path as an `ssh://[user@]host[:port]/path` or scp-style
 * `[user@]host:path` source, or undefined for any other source (an https one included). The user
 * and the port belong to ssh, so they are dropped. A one-character host is never an scp host
 * here: Git for Windows reads it as a drive (`isLocalGitUrl`).
 */
export function httpsFormOfSshUrl(url: string): string | undefined {
  const ssh = SSH_URL_PATTERN.exec(url);
  if (ssh?.[1] !== undefined && ssh[2] !== undefined) return `https://${ssh[1]}${ssh[2]}`;
  const scp = SCP_URL_PATTERN.exec(url);
  const path = scp?.[2]?.replace(/^\/+/, "");
  return scp?.[1] !== undefined && path ? `https://${scp[1]}/${path}` : undefined;
}

/**
 * The URL a review of a backed-up plugin previews: the source itself when it is https, else the
 * https form of an ssh source, else undefined (the user adds that plugin by hand).
 *
 * SECURITY: a preview of an ssh or scp source makes git sign in with the user's SSH agent to
 * whatever host the list names, before any consent to that plugin, and the list is
 * repository-controlled. So a review never previews one: it previews the https form, which signs
 * in with nothing but the credentials git holds for that host. The preview is at the pinned
 * commit, and a commit id names its content, so a repository that serves it serves the same code.
 */
export function reviewUrlOf(url: string): string | undefined {
  return url.startsWith("https://") ? url : httpsFormOfSshUrl(url);
}
