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
 * True when git reads `url` as a path on this machine: a `file://` URL, or what `url_is_local_not_ssh`
 * (connect.c) calls local, no colon or a slash before the first one. Git for Windows also reads a
 * drive (`C:\repo`, `C:/repo`) and a rooted backslash path (`\\server\share`, `\\?\C:\repo`) as a
 * path. Git on Linux and macOS reads `C:/repo` as ssh to the host `C`, and `~h:org/repo` or
 * `\h:org/repo` as ssh to `~h` or `\h`.
 */
function gitReadsAsPath(url: string, platform: NodeJS.Platform): boolean {
  if (/^file:\/\//i.test(url)) return true;
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  if (colon === -1 || (slash !== -1 && slash < colon)) return true;
  return platform === "win32" && /^(?:[a-zA-Z]:[\\/]|\\)/.test(url);
}

// The spellings in which git, OpenSSH and WHATWG `URL` read one host: `scheme://[user@]host[:port]/…`
// and the scp form `[user@]host:path`, with only plain characters. Anything else has a host that Xum
// cannot be sure of, such as `ssh://evil.example:+22/x` (OpenSSH takes the port, `URL` refuses it) or
// `ssh://localhost#@evil.example/x` (`URL` reads localhost, git hands `localhost#@evil.example` to ssh,
// which splits at the last `@`). A later `@[` is refused too: git then reads the host up to the next `]`
// (`localhost:c@[fe80::1]:x` signs in to fe80::1). An allowlist, so no spelling gets around it.
const SCHEME_URL_HOST =
  /^[a-z][a-z0-9+.-]*:\/\/(?:[\w.-]+@)?([\w.-]+|\[[\da-f:.]+\])(?::\d+)?(?:\/|$)(?![\s\S]*@\[)/i;
const SCP_URL_HOST = /^(?:[\w.-]+@)?([\w.-]+|\[[\da-f:.]+\]):(?![\s\S]*@\[)/i;

/**
 * `pointsAtThisMachine` for a check that grants rights instead of refusing a source: a marketplace
 * on this machine may name local paths and ssh sources. It answers yes only when git on `platform`
 * (`process.platform`: common code cannot read it) reads `url` as a path or reaches a loopback host
 * that Xum can read. `pointsAtThisMachine` leans the other way, which is right when a source is left
 * out: it counts a first character and a colon as a drive (Git for Windows does), and a URL that
 * Xum cannot read as this machine. Here a doubt grants nothing.
 */
export function surelyOnThisMachine(url: string, platform: NodeJS.Platform): boolean {
  if (gitReadsAsPath(url, platform)) return true;
  const host = (url.includes("://") ? SCHEME_URL_HOST : SCP_URL_HOST).exec(url)?.[1];
  return host !== undefined && isLoopbackHost(host);
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

const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/;

/** Escapes of escapes (`%2567`) are decoded this many times, and a text still escaped after that is refused. */
const MAX_ESCAPE_PASSES = 4;

/**
 * `text` with its percent escapes decoded one level per entry, until the text stops changing: the
 * forms a reader that decodes once, twice or more would see (`%2567` gives `%67`, then `g`).
 * Undefined when an escape cannot be decoded (a cut-short multi-byte sequence, bytes that are not
 * UTF-8) or when the text is still escaped after `MAX_ESCAPE_PASSES` passes: nothing says how a
 * reader would read it, so the callers treat it as suspect. A `%` that starts no escape is text.
 */
export function percentDecodedForms(text: string): string[] | undefined {
  const forms: string[] = [];
  let current = text;
  while (PERCENT_ESCAPE.test(current)) {
    if (forms.length === MAX_ESCAPE_PASSES) return undefined;
    try {
      current = decodeURIComponent(current);
    } catch {
      return undefined;
    }
    forms.push(current);
  }
  return forms;
}

function spellsUnreservedAsEscape(text: string): boolean {
  for (const [, hex] of text.matchAll(/%([0-9A-Fa-f]{2})/g)) {
    if (/^[A-Za-z0-9._~-]$/.test(String.fromCharCode(Number.parseInt(hex ?? "", 16)))) return true;
  }
  return false;
}

/**
 * True when `url` spells an unreserved character (ALPHA, DIGIT, `-`, `.`, `_`, `~`) as a percent
 * escape, at any level of decoding (`%2567` is `%67`, which is `g`), or has an escape that cannot
 * be decoded. RFC 3986 section 2.3 says a producer must not escape those characters, and every
 * secret token is built from them: the publish-time scan reads the list as written, so `%67hp_...`
 * would pass it. An escape of any other character (`%20` in `My%20Project`, `%2520` for the same
 * space escaped twice) is the only spelling it has, so it stays.
 */
export function hasEscapedUnreservedCharacter(url: string): boolean {
  const forms = percentDecodedForms(url);
  return forms === undefined || [url, ...forms].some(spellsUnreservedAsEscape);
}

// The path of an scp URL may start with one slash (`host:/srv/repo`); `//` and a second colon
// (`ext::payload`, a transport helper) are not an scp path.
const SSH_URL_PATTERN =
  /^ssh:\/\/(?:[^@/?#\s]+@)?(\[[^\]\s]+\]|[^:/?#\s@[\]]+)(?::\d+)?(\/[^?#\s]+)$/i;
const SCP_URL_PATTERN =
  /^(?:[^@/\s:]+@)?(\[[^\]\s]+\]|[A-Za-z0-9._-]{2,}):(?!:|\/\/)\/?([^\s/]\S*)$/;

/**
 * The https URL of the same host and path as an `ssh://[user@]host[:port]/path` or scp-style
 * `[user@]host:path` source, or undefined for any other source (an https one included). The user
 * and the port belong to ssh, so they are dropped. A one-character host is never an scp host
 * here: Git for Windows reads it as a drive (`isLocalGitUrl`).
 */
export function httpsFormOfSshUrl(url: string): string | undefined {
  if (SSH_URL_PATTERN.test(url)) return url.replace(SSH_URL_PATTERN, "https://$1$2");
  if (SCP_URL_PATTERN.test(url)) return url.replace(SCP_URL_PATTERN, "https://$1/$2");
  return undefined;
}

/**
 * A plain https URL: a host name or IPv4 address, an optional port, and a path of unreserved
 * characters, with no user, query, fragment, escape, backslash or bracket. An allowlist, because a
 * URL that other parsers read differently, such as `https://github.com\@attacker.example/x`
 * (WHATWG sees github.com, while git and libcurl connect to attacker.example), would show the user
 * one host and fetch from another. An allowlist cannot be spelled around.
 *
 * It reads the URL as written. A host name that DNS points at this machine (for example
 * `localtest.me` or `ip6-localhost`) still passes, because Xum cannot look the name up before git
 * does (DNS rebinding): the limit `assertMarketplaceMayName` states for a remote marketplace's
 * sources. A review of such a row contacts that host over https with no SSH key, but with any
 * credential that git or `~/.netrc` holds for that host name (a netrc `default` entry matches every
 * host): the same as for a remote marketplace's https sources and for a URL typed into Settings →
 * Plugins. The preview starts only after the user selects Review and install (or its shortcut), and
 * for each next plugin after the user installs or skips the one before. Nothing installs without the
 * user's consent.
 */
export const PLAIN_HTTPS_URL =
  /^https:\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?::[0-9]{1,5})?\/[A-Za-z0-9._~/-]+$/;

/**
 * The one URL a review of a backed-up plugin previews, or undefined (the user adds that plugin by
 * hand in Settings → Plugins). The card, the producer of the review queue and the queue's consumer
 * all ask this, so they cannot disagree. It is the source itself when it is https, else the https
 * form of an ssh source (`httpsFormOfSshUrl`), and it must be a plain https URL
 * (`PLAIN_HTTPS_URL`) that does not point at this machine.
 *
 * SECURITY: the list is repository-controlled. A preview of an ssh or scp source makes git sign in
 * with the user's SSH agent to whatever host the list names, before any consent to that plugin
 * (a remote marketplace may name only https sources for the same reason), so a review previews
 * the https form, which uses no SSH key, only a credential that git or `~/.netrc` holds for that
 * host (see `PLAIN_HTTPS_URL` for the limit). The preview is at the pinned commit, and a commit id
 * names its content, so a repository that serves it serves the same code.
 */
export function reviewUrlOf(url: string): string | undefined {
  const candidate = url.startsWith("https://") ? url : httpsFormOfSshUrl(url);
  if (candidate === undefined || !PLAIN_HTTPS_URL.test(candidate)) return undefined;
  return pointsAtThisMachine(candidate) ? undefined : candidate;
}
