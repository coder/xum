import { z } from "zod";
import { SSH_PROTOCOL_SCHEMES } from "@/constants/git";

/**
 * Backup paths must be portable to Git for Windows. This rejects reserved device names,
 * forbidden characters, and trailing dots or spaces for both managed and payload paths.
 */
const WINDOWS_RESERVED_NAMES =
  /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i;
const WINDOWS_INVALID_CHARACTERS = new Set([...'<>:"|?*']);

export function isWindowsUnusableSegment(segment: string): boolean {
  if (WINDOWS_RESERVED_NAMES.test(segment) || /[. ]$/.test(segment)) return true;
  return [...segment].some(
    (character) =>
      WINDOWS_INVALID_CHARACTERS.has(character) || (character.codePointAt(0) ?? 0) < 0x20
  );
}

/**
 * The managed subdirectory scopes every write and every `git clean`, so it must be a
 * real subdirectory. `.`, `..`, absolute paths, and backslashes would let a backup
 * reach outside the directory Xum is allowed to own.
 */
export function isValidBackupPath(value: string): boolean {
  const segments = value.split("/").filter((segment) => segment !== "");
  return (
    segments.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        // Writing into the cache clone's own git directory could install hooks.
        segment.toLowerCase() === ".git" ||
        isWindowsUnusableSegment(segment)
    )
  );
}

const INVALID_GIT_REF_CHARACTERS: ReadonlySet<string> = new Set([
  "~",
  "^",
  ":",
  "?",
  "*",
  "[",
  "\\",
]);

/** Xum prefixes branch names with `refs/heads/`, so callers must provide an unqualified name. */
export function isValidBackupBranch(value: string): boolean {
  if (
    value === "" ||
    value === "HEAD" ||
    value.startsWith("refs/") ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{")
  ) {
    return false;
  }
  if (value.split("/").some((segment) => segment.startsWith(".") || segment.endsWith(".lock"))) {
    return false;
  }
  return ![...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x20 || codePoint === 0x7f || INVALID_GIT_REF_CHARACTERS.has(character);
  });
}

export const CREDENTIAL_URL_PARAMETER_NAMES: ReadonlySet<string> = new Set([
  "accesskey",
  "accesskeyid",
  "accesstoken",
  "apikey",
  "apisecret",
  "apitoken",
  "appkey",
  "appsecret",
  "apptoken",
  "auth",
  "authcode",
  "authkey",
  "authorization",
  "authtoken",
  "awsaccesskeyid",
  "awssecretaccesskey",
  "bearer",
  "bearertoken",
  "clientkey",
  "clientsecret",
  "clienttoken",
  "consumersecret",
  "credential",
  "credentials",
  "idtoken",
  "jwt",
  "oauthcode",
  "passphrase",
  "passwd",
  "password",
  "privatekey",
  "privatetoken",
  "pwd",
  "refreshtoken",
  "secret",
  "secretaccesskey",
  "secretkey",
  "secrettoken",
  "securitytoken",
  "sessionid",
  "sessiontoken",
  "signature",
  "token",
  "xamzcredential",
  "xamzsignature",
]);

/**
 * Signed-URL families qualify the credential word with a header-style provider
 * prefix (`X-Goog-Signature`, `X-Amz-Credential`, `x-oss-security-token`), so an
 * `x`-led name ending in one of these unambiguous words matches without enumerating
 * providers. Descriptive options that merely end in the word
 * (`verify_signature=false`) carry no provider marker and stay accepted.
 */
const PROVIDER_CREDENTIAL_NAME =
  /^x[a-z0-9]*(?:accesskeyid|credential|secretaccesskey|securitytoken|signature)$/;

function parametersContainCredential(
  parameters: URLSearchParams,
  names: ReadonlySet<string>
): boolean {
  for (const [name, value] of parameters) {
    const normalizedName = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (value === "") continue;
    if (names.has(normalizedName)) return true;
    // Header-style spellings prefix the same names with `x` (`x-api-key`,
    // `X-Auth-Token`), so one stripped leading `x` matches the whole class.
    if (normalizedName.startsWith("x") && names.has(normalizedName.slice(1))) return true;
    if (PROVIDER_CREDENTIAL_NAME.test(normalizedName)) return true;
  }
  return false;
}

function fragmentContainsCredential(fragment: string, names: ReadonlySet<string>): boolean {
  if (parametersContainCredential(new URLSearchParams(fragment), names)) return true;
  const queryStart = fragment.indexOf("?");
  return (
    queryStart >= 0 &&
    parametersContainCredential(new URLSearchParams(fragment.slice(queryStart + 1)), names)
  );
}

export function hasCredentialUrlParameters(
  rawUrl: string,
  names: ReadonlySet<string> = CREDENTIAL_URL_PARAMETER_NAMES
): boolean {
  const fragmentStart = rawUrl.indexOf("#");
  const beforeFragment = fragmentStart >= 0 ? rawUrl.slice(0, fragmentStart) : rawUrl;
  const queryStart = beforeFragment.indexOf("?");
  const query = queryStart >= 0 ? beforeFragment.slice(queryStart + 1) : "";
  const fragment = fragmentStart >= 0 ? rawUrl.slice(fragmentStart + 1) : "";
  return (
    parametersContainCredential(new URLSearchParams(query), names) ||
    fragmentContainsCredential(fragment, names)
  );
}

/** Slashless spellings like `https:user:pw@host` are read as URLs so credentials cannot slip through. */
const SLASHLESS_NON_SSH_SCHEMES = /^(?:https?|ftps?|git)$/;

function isSshTransportScheme(scheme: string): boolean {
  return SSH_PROTOCOL_SCHEMES.has(`${scheme}:`);
}

function rawAuthorityHasCredentials(repoUrl: string): boolean {
  const match = /^([a-z][a-z0-9+.-]*):([\\/]*)([^\\/?#]*)/i.exec(repoUrl);
  if (match == null) return false;
  const scheme = match[1].toLowerCase();
  const isUrlScheme = SLASHLESS_NON_SSH_SCHEMES.test(scheme) || isSshTransportScheme(scheme);
  if (match[2] === "" && !isUrlScheme) return false;
  const authority = decodeDelimitersOnce(match[3]);
  const userInfoEnd = authority.lastIndexOf("@");
  if (userInfoEnd < 0) return false;
  const userInfo = authority.slice(0, userInfoEnd);
  return !isSshTransportScheme(scheme) || userInfo.includes(":");
}

/**
 * Git decodes the authority before handing it to ssh, so a delimiter acts the same encoded or
 * literal: `ssh://user:pw%40host/r` arrives as `user:pw@host`, putting `user:pw` in ssh's user
 * field. Resolving them here first means the split above sees what ssh will.
 *
 * One pass, like git, so `%2540` becomes the text `%40` rather than a delimiter. Per triplet
 * rather than `decodeURIComponent`, which throws on the whole string over one malformed escape
 * while git still decodes the valid ones. Encoded UTF-8 bytes all sit above the ASCII
 * delimiters, so decoding bytewise cannot invent one.
 */
export function decodeDelimitersOnce(authority: string): string {
  return authority.replaceAll(/%([0-9a-f]{2})/gi, (_whole, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
}

/**
 * Repository URLs are persisted in config and cache git metadata, so userinfo credentials and
 * known credential parameters are rejected. SSH usernames are routing data; scp-like remotes have
 * no password field and remain allowed.
 */
export function hasUrlCredentials(repoUrl: string): boolean {
  if (hasCredentialUrlParameters(repoUrl) || rawAuthorityHasCredentials(repoUrl)) return true;
  try {
    const url = new URL(repoUrl);
    return url.password !== "" || (!SSH_PROTOCOL_SCHEMES.has(url.protocol) && url.username !== "");
  } catch {
    return false;
  }
}

/**
 * The persisted schema extends the IPC input schema so config.json cannot hold a value
 * the `getSettings` response rejects, leaving the Backup screen unable to load saved settings.
 */
export const SettingsBackupInputSchema = z.object({
  repoUrl: z
    .string()
    .trim()
    .min(1, { message: "Enter a repository URL" })
    .refine((value) => !hasUrlCredentials(value), {
      message: "Remove the credential embedded in the repository URL",
    }),
  branch: z
    .string()
    .trim()
    .min(1, { message: "Enter a valid Git branch name" })
    .refine(isValidBackupBranch, {
      message: "Enter a valid Git branch name",
    }),
  path: z
    .string()
    .trim()
    .min(1, { message: "Enter a subdirectory inside the repository" })
    .refine(isValidBackupPath, { message: "Enter a subdirectory inside the repository" }),
});

export const SettingsBackupSchema = SettingsBackupInputSchema.extend({
  lastPushedCommit: z.string().optional(),
  lastRestoredCommit: z.string().optional(),
});

export type SettingsBackupInput = z.infer<typeof SettingsBackupInputSchema>;
export type SettingsBackup = z.infer<typeof SettingsBackupSchema>;
