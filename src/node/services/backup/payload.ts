import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as jsonc from "jsonc-parser";
import {
  UserPreferencesSchema,
  type UserPreferences,
} from "@/common/config/schemas/userPreferences";
import {
  CREDENTIAL_URL_PARAMETER_NAMES,
  decodeDelimitersOnce,
  hasCredentialUrlParameters,
  isWindowsUnusableSegment,
} from "@/common/config/schemas/settingsBackup";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { isErrnoWithCode } from "@/node/utils/fs";
import type { BackupCommandApproval } from "@/common/orpc/schemas/backup";

export const BACKUP_SCHEMA_VERSION = 1;
export const BACKUP_MANIFEST_FILE = "manifest.json";
/**
 * A payload is read wholly into memory on both sides, and the repository side is written by
 * whoever can push to the branch, so an oversized entry would crash the main process during
 * a plain Preview. Settings are text, so these bounds are far above any real backup.
 */
export const MAX_BACKUP_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_BACKUP_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_BACKUP_FILE_COUNT = 4096;
/** The manifest byte cap bounds parsing; these limits bound derived MCP redaction work. */
export const MAX_BACKUP_MCP_REDACTIONS = 256;
export const MAX_BACKUP_MCP_REDACTION_PATH_SEGMENTS = 64;
export const MAX_BACKUP_MCP_REDACTION_SEGMENTS = 2048;
/** Bounds traversal work and the directory tree Preview or Restore may inspect or create. */
export const MAX_BACKUP_PATH_DEPTH = 24;
export const MAX_BACKUP_DIRECTORY_COUNT = 4096;
export const REDACTED_BACKUP_VALUE = "__MUX_BACKUP_REDACTED__";

const FORBIDDEN_BASENAMES = new Set(
  [
    "providers.jsonc",
    "secrets.json",
    "mcp-oauth.json",
    "server.lock",
    "serverAuthSessions.json",
    "AGENTS.local.md",
    "memory-meta.json",
  ].map((name) => name.toLowerCase())
);

/** Case-insensitive: a differently-cased name resolves to the same file on Windows and macOS. */
function isForbiddenBasename(name: string): boolean {
  return FORBIDDEN_BASENAMES.has(name.toLowerCase());
}

/**
 * No hidden file is portable settings content, and the recursive collections (`skills/`,
 * `memory/global/`) would otherwise sweep up whatever a directory happens to contain. The
 * names that show up there are credential and tooling files: `.env` and its variants,
 * `.netrc`, `.npmrc`, and the `.git` directory of a skill installed by cloning, which holds
 * an object database and remote URLs with credentials. The secret scanner is not a safety
 * net for these, because a value like `PASSWORD=hunter2` matches none of its patterns.
 *
 * Applied to every path segment, so a hidden directory is not backed up either, and shared
 * with payload validation so a backup cannot deliver one back.
 */
function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}
/**
 * Formats issued only as live credentials. A match aborts the export outright, with no
 * user override: redaction is the primary mechanism, so a surviving match means either a
 * shape redaction does not classify (a token passed as a command argument) or a redaction
 * defect, and neither is something a backup should publish.
 */
const CREDENTIAL_TOKEN_PATTERNS = [
  // GitHub issued prefixes: personal, OAuth, App user, installation, refresh tokens.
  /\bgh[opusr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bglsa_[A-Za-z0-9_]{20,}\b/,
  // GitLab issued prefixes: personal, deploy, runner, service-account, trigger,
  // CI job, OAuth app, feature-flag, incoming-mail, and cluster-agent tokens.
  /\bgl(?:pat|dt|rt|soat|ptt|cbt|oas|ffct|imt|agent)-[A-Za-z0-9_-]{20,}\b/,
  /\blin_api_[A-Za-z0-9]{16,}\b/,
  /\bntn_[A-Za-z0-9]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  // Slack workspace (xox?-) and app-level (xapp-) issued tokens.
  /\bx(?:ox[baprs]|app)-[A-Za-z0-9-]{10,}\b/,
] as const;

/**
 * The digit requirement keeps documentation placeholders (`sk-your-api-key-here`) out
 * of the no-override block: issued keys are base62 and practically always carry digits,
 * while placeholders are dash-separated words. The digit-free spelling stays in the
 * reviewable scan. Checked per maximal candidate run instead of inside one regex, whose
 * digit search would backtrack quadratically across a digit-free `sk-sk-...` wall in
 * the synchronous scanner.
 */
function hasDigitBearingSkToken(text: string): boolean {
  for (const match of text.matchAll(/\bsk-[A-Za-z0-9_-]{16,}\b/g)) {
    if (/[0-9]/.test(match[0])) return true;
  }
  return false;
}

/**
 * AWS's documented example access key is valid-shape but never a live credential;
 * documentation quoting it stays in the reviewable scan instead of the no-override
 * block. Replaced with a space so removal cannot splice surrounding text into a match.
 */
const EXAMPLE_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";

/**
 * A run of one repeated character (case-insensitive) is documentation spelling, never
 * issued-token entropy (`ghp_xxxxxxxx...`), so those spellings stay in the reviewable
 * scan instead of the no-override block. Replaced with a space like the example key,
 * so the removal cannot splice neighbors into a match, and a real token padded with an
 * obvious run still matches on what remains.
 */
const PLACEHOLDER_RUN = /(.)\1{15,}/gi;

function matchesCredentialToken(text: string): boolean {
  const scannable = text.replaceAll(EXAMPLE_ACCESS_KEY, " ").replace(PLACEHOLDER_RUN, " ");
  return (
    CREDENTIAL_TOKEN_PATTERNS.some((pattern) => pattern.test(scannable)) ||
    hasDigitBearingSkToken(scannable)
  );
}

const SECRET_PATTERNS = [
  ...CREDENTIAL_TOKEN_PATTERNS,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bAIza[A-Za-z0-9_-]{35,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
] as const;

export interface BackupFile {
  path: string;
  content: Buffer;
  executable?: boolean;
}

export interface BackupManifestFile {
  path: string;
  sha256: string;
  executable?: boolean;
}

export type BackupRedactionPath = jsonc.JSONPath;

export interface BackupManifest {
  schemaVersion: typeof BACKUP_SCHEMA_VERSION;
  exportedAt: string;
  muxVersion: string;
  sourceLabel: string;
  mcpRedactions?: BackupRedactionPath[];
  files: BackupManifestFile[];
}

export interface BackupPayload {
  manifest: BackupManifest;
  files: BackupFile[];
  redactions: string[];
}

export interface CreateBackupPayloadOptions {
  muxRoot: string;
  preferences?: UserPreferences;
  muxVersion: string;
  sourceLabel: string;
  exportedAt?: string;
  /**
   * Return detected secrets in the payload instead of throwing, so a caller that
   * owns the user-facing override can decide whether to proceed.
   */
  reportSecrets?: boolean;
  /** Keep the local MCP file verbatim for the safety snapshot used to undo a restore. */
  keepLocalSecrets?: boolean;
}

export interface RestoreBackupPayloadOptions {
  muxRoot: string;
  payload: BackupPayload;
  approvedCommandTokens?: readonly string[];
}

/**
 * No secretApproval digest on purpose: unlike the reviewable secret scan, this block has no
 * user override, so the UI shows it as a hard failure instead of offering approval.
 */
export class BackupCredentialDetectedError extends Error {
  readonly code = "SECRET_DETECTED";

  constructor(readonly files: string[]) {
    super(
      `Backup blocked: values matching known credential formats were found in ${files.join(", ")}. Remove the credentials from the local files, then back up again.`
    );
    this.name = "BackupCredentialDetectedError";
  }
}

export class BackupCommandApprovalRequiredError extends Error {
  readonly code = "COMMAND_APPROVAL_REQUIRED";

  constructor(readonly approvals: readonly BackupCommandApproval[]) {
    super(
      "This backup would replace executable MCP commands. Review and approve them before restoring."
    );
    this.name = "BackupCommandApprovalRequiredError";
  }

  /** The paths the UI lists, matching how `SECRET_DETECTED` reports blocked files. */
  get files(): string[] {
    return this.approvals.map((approval) => `${approval.path}: ${approval.command}`);
  }
}

export interface RestoreBackupPayloadResult {
  /**
   * The backup's preferences document, unmerged and absent when the payload carries none.
   * Merging belongs to the caller so it can read the current config inside the same
   * serialized edit that writes the result.
   */
  backupPreferences?: unknown;
  localOnlyFiles: string[];
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function toPosixPath(...parts: string[]): string {
  return parts.join("/");
}

/**
 * MCP definitions carry commands, URLs, and headers that can hold credentials, so restore
 * reproduces the owner-only mode `mcpConfigService` writes rather than following the umask.
 */
function isOwnerOnlyPayloadPath(relativePath: string): boolean {
  return relativePath === "mcp.jsonc";
}

function isAllowedPayloadPath(relativePath: string): boolean {
  if (relativePath === "AGENTS.md" || relativePath === "mcp.jsonc") return true;
  if (relativePath === "preferences.json") return true;
  if (/^agents\/[^/]+\.md$/.test(relativePath)) return true;
  if (/^skills\/.+/.test(relativePath)) return true;
  return /^memory\/global\/.+/.test(relativePath);
}

function backupPathSegments(relativePath: string): string[] {
  const segments = relativePath.split("/");
  if (segments.length > MAX_BACKUP_PATH_DEPTH) {
    throw new Error(
      `Backup path '${relativePath}' has more than ${MAX_BACKUP_PATH_DEPTH} path components`
    );
  }
  return segments;
}

/**
 * Local safety snapshots use `portable: false` so cross-platform filename checks cannot block
 * a restore while protecting a file valid on the current filesystem. Containment and allowlist
 * checks still apply.
 */
function assertAllowedPayloadPath(
  relativePath: string,
  options: { portable: boolean } = { portable: true }
): void {
  const segments = backupPathSegments(relativePath);
  if (
    !isAllowedPayloadPath(relativePath) ||
    path.isAbsolute(relativePath) ||
    // Payload paths are always posix. A backslash is an ordinary filename character
    // here but a separator on Windows, so `skills/..\..\evil` would escape the
    // destination once path.join runs there. A local snapshot never travels, and
    // resolveContainedPath still rejects traversal and symlinked ancestors either way.
    (options.portable && relativePath.includes("\\")) ||
    segments.some(
      (segment) =>
        segment === ".." ||
        isHiddenName(segment) ||
        (options.portable && isWindowsUnusableSegment(segment))
    ) ||
    isForbiddenBasename(path.posix.basename(relativePath))
  ) {
    throw new Error(`Backup contains disallowed path '${relativePath}'`);
  }
}

async function lstatOrNull(target: string) {
  try {
    return await fs.lstat(target);
  } catch {
    return null;
  }
}

/** Filesystem identity detects aliases across hard links, case folding, and normalization. */
async function localFilesOverwrittenByPayload(
  muxRoot: string,
  localPaths: Iterable<string>,
  payloadPaths: Iterable<string>
): Promise<{ overwritten: Map<string, string[]>; multiLinkLocals: Set<string> }> {
  const byIdentity = new Map<string, string[]>();
  const multiLinkLocals = new Set<string>();
  for (const localPath of localPaths) {
    const identity = await fileIdentity(muxRoot, localPath);
    if (identity === null) continue;
    if (identity.nlink > 1) multiLinkLocals.add(localPath);
    const key = fileIdentityKey(identity);
    const names = byIdentity.get(key);
    if (names === undefined) byIdentity.set(key, [localPath]);
    else names.push(localPath);
  }
  const overwritten = new Map<string, string[]>();
  for (const payloadPath of payloadPaths) {
    const identity = await fileIdentity(muxRoot, payloadPath);
    const names = identity === null ? undefined : byIdentity.get(fileIdentityKey(identity));
    if (names !== undefined) overwritten.set(payloadPath, names);
  }
  return { overwritten, multiLinkLocals };
}

async function fileIdentity(
  muxRoot: string,
  relativePath: string
): Promise<FileIdentityStat | null> {
  const stat = await lstatOrNull(path.join(muxRoot, ...relativePath.split("/")));
  return stat === null ? null : { dev: stat.dev, ino: stat.ino, nlink: stat.nlink };
}

/**
 * A hard-linked alias is local-only unless restored directly because writes sever the
 * restored name.
 */
export async function localOnlyPayloadFiles(
  muxRoot: string,
  localPaths: Iterable<string>,
  restoredPaths: ReadonlySet<string>
): Promise<{ localOnly: string[]; overwritten: Map<string, string[]> }> {
  const locals = [...localPaths];
  const { overwritten, multiLinkLocals } = await localFilesOverwrittenByPayload(
    muxRoot,
    locals,
    restoredPaths
  );
  const overwrittenLocals = new Set([...overwritten.values()].flat());
  return {
    localOnly: locals
      .filter(
        (file) =>
          !restoredPaths.has(file) && (!overwrittenLocals.has(file) || multiLinkLocals.has(file))
      )
      .sort(),
    overwritten,
  };
}

/**
 * Joins a posix relative path onto a root, rejecting any component that is a symlink.
 * Git stores symlinks (mode 120000), so a backup repository can contain one; reading or
 * writing through it would escape the directory this feature is allowed to touch.
 */
export async function resolveContainedPath(root: string, relativePath: string): Promise<string> {
  const segments = relativePath.split("/");
  let current = root;
  for (const [index, segment] of segments.entries()) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error(`Backup contains disallowed path '${relativePath}'`);
    }
    current = path.join(current, segment);
    const existing = await lstatOrNull(current);
    if (existing?.isSymbolicLink()) {
      throw new Error(`Refusing to follow symlink '${relativePath}'`);
    }
    // A non-directory in the middle of the path would make mkdir fail mid-write.
    if (index < segments.length - 1 && existing !== null && !existing.isDirectory()) {
      throw new Error(`Cannot use '${relativePath}': a parent path is not a directory`);
    }
  }
  return current;
}

function assertBackupFileCount(count: number): void {
  if (count > MAX_BACKUP_FILE_COUNT) {
    throw new Error(`Backup has more than ${MAX_BACKUP_FILE_COUNT} files`);
  }
}

function createBackupPathComplexityTracker(): {
  recordDirectory: (relativePath: string) => void;
  recordFile: (relativePath: string) => void;
} {
  const directories = new Set<string>();

  function record(relativePath: string, includeLastSegment: boolean): void {
    const segments = backupPathSegments(relativePath);
    let prefix = "";
    for (const segment of includeLastSegment ? segments : segments.slice(0, -1)) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      directories.add(prefix);
      if (directories.size > MAX_BACKUP_DIRECTORY_COUNT) {
        throw new Error(`Backup has more than ${MAX_BACKUP_DIRECTORY_COUNT} directories`);
      }
    }
  }

  return {
    recordDirectory: (relativePath) => record(relativePath, true),
    recordFile: (relativePath) => record(relativePath, false),
  };
}

export function assertBackupPathComplexity(relativePaths: readonly string[]): void {
  const tracker = createBackupPathComplexityTracker();
  for (const relativePath of relativePaths) tracker.recordFile(relativePath);
}

function assertBackupPathLimits(
  relativePaths: readonly string[],
  options: { portable: boolean } = { portable: true }
): void {
  assertBackupFileCount(relativePaths.length);
  assertBackupPathComplexity(relativePaths);
  for (const relativePath of relativePaths) assertAllowedPayloadPath(relativePath, options);
}

function megabytes(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))} MB`;
}

/** Checked before each read, so an oversized entry is never buffered. */
function createByteBudget() {
  let used = 0;
  return function take(relativePath: string, size: number): void {
    if (size > MAX_BACKUP_FILE_BYTES) {
      throw new Error(
        `'${relativePath}' is larger than the ${megabytes(MAX_BACKUP_FILE_BYTES)} limit for one backup file`
      );
    }
    used += size;
    if (used > MAX_BACKUP_TOTAL_BYTES) {
      throw new Error(`Backup is larger than the ${megabytes(MAX_BACKUP_TOTAL_BYTES)} total limit`);
    }
  };
}

type ByteBudget = ReturnType<typeof createByteBudget>;

/**
 * Two paths collide when the filesystem cannot tell them apart, so the comparison has to fold
 * the same things a filesystem does. Case is the obvious one, and macOS also normalizes: NFC
 * `café.md` and its NFD spelling are one file there while they differ byte for byte, so
 * case-folding alone would let the second entry silently overwrite the first.
 */
function collisionKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

/**
 * Confirms the path just opened still holds no symlink between the root and the file, and that
 * the file it named is the file the handle holds.
 *
 * `O_NOFOLLOW` covers only the last component and Node exposes no `openat`, so an ancestor
 * directory swapped for a symlink between the checks and the open cannot be prevented, only
 * detected. Comparing the opened handle's identity with the identity the verified walk arrives
 * at is what does the detecting: a component put back after the open still leaves a different
 * file in hand.
 *
 * What this closes is a backup repository choosing a path that escapes the root, and a symlink
 * planted under the root beforehand. It is not atomic, and it does not claim to be: every check
 * here re-resolves a pathname, so a local process that can rename the root repeatedly while a
 * restore runs can still thread its way between them. Closing that needs directory-relative
 * opens (`openat`/`O_PATH`), which Node does not expose. A process with that access can write
 * these files directly anyway, so the pathname checks are the boundary that pays off.
 */
async function assertOpenedFileContained(
  root: BackupRoot,
  relativePath: string,
  opened: { dev: number; ino: number }
): Promise<void> {
  // The root is checked by identity, not by name: `realpath` returned a pathname, and a
  // pathname can be made to point somewhere else afterwards. Node cannot pin a directory, so
  // the check is that the canonical root is still the same directory this operation started on.
  const rootStat = await fs.lstat(root.path);
  if (rootStat.isSymbolicLink() || rootStat.dev !== root.dev || rootStat.ino !== root.ino) {
    throw new Error(`Refusing to use '${relativePath}': the backup root was replaced`);
  }
  let current = root.path;
  let last: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    last = await fs.lstat(current);
    if (last.isSymbolicLink()) throw new Error(`Refusing to follow symlink '${relativePath}'`);
  }
  if (last === undefined || last.dev !== opened.dev || last.ino !== opened.ino) {
    throw new Error(`Refusing to use '${relativePath}': it was replaced while being opened`);
  }
}

/**
 * Resolved once where an operation begins, so every open and check below it uses that result.
 * The root being a symlink is then neither refused nor traversed again: a user is free to keep
 * `~/.xum` on another volume, and swapping that link partway through cannot move an operation
 * already under way onto a different tree. Only the components below the root are held to the
 * no-symlink rule.
 */
interface BackupRoot {
  path: string;
  dev: number;
  ino: number;
}

async function resolveRoot(root: string): Promise<BackupRoot> {
  const canonical = await fs.realpath(root);
  const stat = await fs.lstat(canonical);
  if (!stat.isDirectory()) throw new Error(`'${root}' is not a directory`);
  return { path: canonical, dev: stat.dev, ino: stat.ino };
}

function nonBlockingFlag(): number {
  return fs.constants.O_NONBLOCK ?? 0;
}

function noFollowFlag(): number {
  // Absent on Windows, where a file cannot be swapped for a junction this way.
  return fs.constants.O_NOFOLLOW ?? 0;
}

function absolutePathOf(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}

/**
 * Reads a file through one handle, so the size that was checked is the size that is read.
 * Reopening the path after a `stat` lets a file that grew in between defeat the byte budget,
 * and lets a symlink installed in between be followed after the checks said there was none.
 * The window is ordinary rather than adversarial here: agents write under this root while a
 * Preview or Push is running.
 */
async function readCheckedFile(
  root: BackupRoot,
  relativePath: string,
  charge: (size: number) => void
): Promise<{ content: Buffer; mode: number; identity: FileIdentityStat }> {
  const handle = await fs.open(
    absolutePathOf(root.path, relativePath),
    fs.constants.O_RDONLY | noFollowFlag() | nonBlockingFlag()
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Refusing to read '${relativePath}': not a regular file`);
    await assertOpenedFileContained(root, relativePath, stat);
    charge(stat.size);
    const content = Buffer.alloc(stat.size);
    let filled = 0;
    while (filled < stat.size) {
      const { bytesRead } = await handle.read(content, filled, stat.size - filled, filled);
      // A file truncated while being read yields short, which is the bound holding rather
      // than an error: the caller's checksum decides whether the result is usable.
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return {
      content: filled === stat.size ? content : content.subarray(0, filled),
      mode: stat.mode,
      identity: { dev: stat.dev, ino: stat.ino, nlink: stat.nlink },
    };
  } finally {
    await handle.close();
  }
}

interface FileIdentityStat {
  dev: number;
  ino: number;
  nlink: number;
}

/**
 * `nlink` says how many names a file has but not where they are, so a single read cannot
 * tell an alias inside the root from one outside it. The collection as a whole can: when
 * every name a file has was itself collected, all its aliases are inside the backed-up set,
 * and any excess means a name somewhere this walk cannot see. A hard link to a file outside
 * the root carries that file's bytes past the allowlist the same way the symlinks this
 * feature already refuses would, so the unprovable case is refused too. Aliases inside the
 * set stay allowed: they are how a case-folding volume's one-file-many-spellings behaves,
 * and every one of them is content the backup already carries.
 */
function fileIdentityKey(identity: FileIdentityStat): string {
  return `${identity.dev}:${identity.ino}`;
}

function createHardLinkTracker() {
  const identities = new Map<string, { nlink: number; names: string[] }>();
  return {
    record(relativePath: string, identity: FileIdentityStat): void {
      if (identity.nlink <= 1) return;
      const key = fileIdentityKey(identity);
      const entry = identities.get(key);
      if (entry === undefined) {
        identities.set(key, { nlink: identity.nlink, names: [relativePath] });
      } else {
        entry.names.push(relativePath);
      }
    },
    assertContained(): void {
      for (const { nlink, names } of identities.values()) {
        if (nlink > names.length) {
          throw new Error(
            `Refusing to use '${names[0] ?? ""}': it is hard-linked to a file outside the backed-up files`
          );
        }
      }
    },
  };
}

type HardLinkTracker = ReturnType<typeof createHardLinkTracker>;

function restoredPermissions(
  mode: number,
  executable: boolean,
  ownerOnly: boolean
): { base: number; next: number } {
  // Git records only executability, so preserve local read and write permissions. Bun's chmod
  // strips setuid and setgid, so masking privileged bits cannot be fixture-tested under bun test.
  const base = mode & 0o777;
  let next = executable ? base | ((base & 0o444) >> 2) : base & ~0o111;
  if (ownerOnly) next = 0o600;
  return { base, next };
}

/**
 * Writes a file through one handle, opened without following a symlink and verified to be the
 * file inside the root that was planned before anything is written to it. Deliberately not
 * `O_TRUNC`: truncation happens after the verification, so a destination that turned out to be
 * somewhere else is not emptied on the way to finding that out. The mode is set on the handle
 * rather than the path for the same reason.
 */
async function writeCheckedFile(
  root: BackupRoot,
  relativePath: string,
  content: Buffer,
  executable: boolean,
  options: { ownerOnly?: boolean } = {}
): Promise<void> {
  const ownerOnly = options.ownerOnly === true;
  const destination = absolutePathOf(root.path, relativePath);
  await fs.mkdir(path.dirname(destination), {
    recursive: true,
    ...(ownerOnly ? { mode: 0o700 } : {}),
  });
  const { handle, stat } = await openSeveredWriteHandle(root, relativePath, destination, {
    ...(ownerOnly ? { mode: 0o600 } : {}),
  });
  try {
    await handle.truncate(0);
    let written = 0;
    while (written < content.length) {
      // A short write resolves successfully, so the count decides when the file is complete:
      // treating the first call as the whole write would publish a truncated file as a
      // finished one.
      const { bytesWritten } = await handle.write(
        content,
        written,
        content.length - written,
        written
      );
      if (bytesWritten === 0) {
        throw new Error(`Could not finish writing '${relativePath}'`);
      }
      written += bytesWritten;
    }
    const { base, next } = restoredPermissions(stat.mode, executable, ownerOnly);
    // Existing destinations ignore the creation mode, so owner-only restores still need chmod.
    // Compared against the permission bits alone: `stat.mode` also carries the file type, so
    // comparing whole modes never matches and chmods a file whose mode is already correct, which
    // fails with EPERM when the destination is writable but owned by someone else.
    if (next !== base) await handle.chmod(next);
  } finally {
    await handle.close();
  }
}

/**
 * Opens the destination for writing, verified to be the planned file inside the root, and
 * never a name shared with another one. Writing through a multi-link file updates every one
 * of its names, and `nlink` cannot say whether one of them is outside the root, where a
 * write would land backup-controlled bytes in a file the containment walk never approved.
 * Instead of refusing, the name is severed: unlinked and recreated exclusively, so the write
 * lands in a fresh file only this name reads. On the volumes whose behavior in-root aliases
 * simulate, all spellings are one directory entry and severing is indistinguishable from
 * writing in place.
 */
async function openSeveredWriteHandle(
  root: BackupRoot,
  relativePath: string,
  destination: string,
  options: { mode?: number } = {}
): Promise<{ handle: fs.FileHandle; stat: Stats }> {
  const opened = await fs.open(
    destination,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | noFollowFlag() | nonBlockingFlag(),
    options.mode
  );
  let severedMode: number;
  try {
    const stat = await opened.stat();
    await assertOpenedFileContained(root, relativePath, stat);
    if (stat.nlink <= 1) return { handle: opened, stat };
    severedMode = stat.mode & 0o777;
  } catch (error) {
    await opened.close();
    throw error;
  }
  await opened.close();
  await fs.unlink(destination);
  const fresh = await fs.open(
    destination,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag(),
    options.mode ?? severedMode
  );
  try {
    // A creation mode is filtered by the umask, which would silently narrow the replacement
    // below the permissions the file being replaced already had. chmod is not filtered, so the
    // mode is reapplied here to land exactly what was asked for.
    await fresh.chmod(options.mode ?? severedMode);
    const stat = await fresh.stat();
    await assertOpenedFileContained(root, relativePath, stat);
    return { handle: fresh, stat };
  } catch (error) {
    await fresh.close();
    throw error;
  }
}

async function readBackupFile(
  root: BackupRoot,
  relativePath: string,
  budget: ByteBudget,
  links: HardLinkTracker
): Promise<BackupFile> {
  const { content, mode, identity } = await readCheckedFile(root, relativePath, (size) =>
    budget(relativePath, size)
  );
  links.record(relativePath, identity);
  return { path: relativePath, content, executable: (mode & 0o111) !== 0 };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * lstat, not stat: a symlinked entry would let the closed allowlist export whatever it
 * points at (`AGENTS.md -> ~/company-secrets.txt`). Symlinks are not backed up.
 */
async function isRegularFile(filePath: string): Promise<boolean> {
  return (await lstatOrNull(filePath))?.isFile() === true;
}

export async function collectAllowlistedFiles(muxRoot: string): Promise<BackupFile[]> {
  const root = await resolveRoot(muxRoot);
  const files: BackupFile[] = [];
  const budget = createByteBudget();
  const links = createHardLinkTracker();

  const pathComplexity = createBackupPathComplexityTracker();

  async function collectDirectory(
    relativeRoot: string,
    filter: (relativePath: string, entry: Dirent) => boolean
  ): Promise<void> {
    const absoluteRoot = path.join(root.path, ...relativeRoot.split("/"));
    // A symlinked collection root would let readdir walk outside MUX_ROOT, and restore
    // refuses to write through symlinks anyway, so they are simply not backed up.
    const rootStat = await lstatOrNull(absoluteRoot);
    if (rootStat?.isSymbolicLink() === true) return;
    if (rootStat?.isDirectory() === true) pathComplexity.recordDirectory(relativeRoot);

    let entries: Dirent[];
    try {
      entries = await fs.readdir(absoluteRoot, { withFileTypes: true });
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return;
      throw error;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (isHiddenName(entry.name)) continue;
      const relativePath = toPosixPath(relativeRoot, entry.name);
      if (!filter(relativePath, entry)) continue;
      if (entry.isDirectory()) {
        await collectDirectory(relativePath, filter);
      } else if (entry.isFile() && !isForbiddenBasename(entry.name)) {
        assertBackupFileCount(files.length + 1);
        pathComplexity.recordFile(relativePath);
        files.push(await readBackupFile(root, relativePath, budget, links));
      }
    }
  }

  for (const relativePath of ["AGENTS.md", "mcp.jsonc"]) {
    if (await isRegularFile(path.join(root.path, relativePath))) {
      assertBackupFileCount(files.length + 1);
      pathComplexity.recordFile(relativePath);
      files.push(await readBackupFile(root, relativePath, budget, links));
    }
  }

  await collectDirectory(
    "agents",
    (relativePath, entry) => entry.isDirectory() || /^agents\/[^/]+\.md$/.test(relativePath)
  );
  await collectDirectory("skills", () => true);
  await collectDirectory("memory/global", () => true);
  links.assertContained();
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function copyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function serializeBackupPreferences(preferences: unknown): Buffer {
  return Buffer.from(
    `${JSON.stringify(projectBackupPreferences(preferences), null, 2)}\n`,
    "utf-8"
  );
}

type Appearance = NonNullable<UserPreferences["appearance"]>;

/**
 * `editorConfig` is excluded on purpose. `customCommand` is executed as a shell command
 * by `EditorService.openInEditor`, so restoring it from a repository would let whoever
 * can write to that repository run a command here. The editor is machine-local anyway,
 * since its binary has to exist on the machine.
 */
const BACKED_UP_APPEARANCE_FIELDS = [
  "theme",
  "transcriptDensity",
  "bashCollapsedSummaryMode",
  "terminalFontConfig",
  "terminalBadgeConfig",
  "vimEnabled",
] as const satisfies ReadonlyArray<keyof Appearance>;

function projectAppearance(value: Appearance | undefined): Appearance | undefined {
  if (!value) return undefined;
  const projected: Appearance = {};
  for (const field of BACKED_UP_APPEARANCE_FIELDS) {
    if (value[field] !== undefined) {
      Object.assign(projected, { [field]: copyJson(value[field]) });
    }
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

type BackupProviderOptions = NonNullable<NonNullable<UserPreferences["ai"]>["providerOptions"]>;

/**
 * Of the providers `UserPreferencesSchema` can hold, only `anthropic` has a closed
 * `z.object` schema, so parsing already dropped undeclared keys. `google` is
 * `z.record(z.string(), z.unknown())`, which would carry an `apiKey` straight into the
 * backup, so it is excluded. A provider added later is excluded until it is listed here,
 * which fails closed, and `satisfies` rejects a name the preferences schema cannot hold.
 */
const BACKED_UP_PROVIDER_OPTIONS = ["anthropic"] as const satisfies ReadonlyArray<
  keyof BackupProviderOptions
>;

function projectProviderOptions(value: unknown): BackupProviderOptions | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const provider of BACKED_UP_PROVIDER_OPTIONS) {
    if (source[provider] !== undefined) projected[provider] = copyJson(source[provider]);
  }
  return Object.keys(projected).length > 0 ? (projected as BackupProviderOptions) : undefined;
}

export function projectBackupPreferences(value: unknown): UserPreferences {
  const parsed = UserPreferencesSchema.parse(value ?? {});
  const projected: UserPreferences = {};

  const appearance = projectAppearance(parsed.appearance);
  if (appearance !== undefined) projected.appearance = appearance;
  if (parsed.navigation?.launchBehavior !== undefined) {
    projected.navigation = { launchBehavior: parsed.navigation.launchBehavior };
  }
  if (parsed.ai) {
    const ai: NonNullable<UserPreferences["ai"]> = {};
    if (parsed.ai.globalDefaults !== undefined) {
      ai.globalDefaults = copyJson(parsed.ai.globalDefaults);
    }
    const providerOptions = projectProviderOptions(parsed.ai.providerOptions);
    if (providerOptions !== undefined) ai.providerOptions = providerOptions;
    if (parsed.ai.autoCompactionThresholdByModel !== undefined) {
      ai.autoCompactionThresholdByModel = copyJson(parsed.ai.autoCompactionThresholdByModel);
    }
    if (Object.keys(ai).length > 0) projected.ai = ai;
  }
  if (parsed.review?.includeUncommitted !== undefined) {
    projected.review = { includeUncommitted: parsed.review.includeUncommitted };
  }

  return projected;
}

type AiPreferences = NonNullable<UserPreferences["ai"]>;

/**
 * Provider options merge per provider rather than wholesale, because the record-typed
 * providers are deliberately excluded from a backup. Replacing the object would delete
 * settings the backup never had the chance to carry.
 */
function mergeAiPreferences(current: AiPreferences | undefined, projected: AiPreferences) {
  const merged: AiPreferences = { ...current, ...projected };
  if (projected.providerOptions !== undefined) {
    merged.providerOptions = { ...current?.providerOptions, ...projected.providerOptions };
  }
  return merged;
}

export function mergeBackupPreferences(
  current: UserPreferences | undefined,
  backup: unknown
): UserPreferences {
  const projected = projectBackupPreferences(backup);
  return UserPreferencesSchema.parse({
    ...(current ?? {}),
    ...(projected.appearance
      ? { appearance: { ...current?.appearance, ...projected.appearance } }
      : {}),
    ...(projected.navigation
      ? { navigation: { ...current?.navigation, ...projected.navigation } }
      : {}),
    ...(projected.ai ? { ai: mergeAiPreferences(current?.ai, projected.ai) } : {}),
    ...(projected.review ? { review: { ...current?.review, ...projected.review } } : {}),
  });
}

/**
 * `MCPHeaderValue` is `string | { secret }` (src/common/types/mcp.ts), so Xum sends a plain
 * string verbatim and never interpolates it: only the reference form is portable. Exactly one
 * key, because a sibling property inside the reference would be published verbatim and is a
 * place to hide a credential that `resolveHeaders` would never read.
 */
function isPortableReference(value: unknown): boolean {
  const record = readRecord(value);
  if (!record) return false;
  const keys = Object.keys(record);
  return keys.length === 1 && typeof record.secret === "string" && record.secret.trim() !== "";
}

/**
 * `jsonc.parse` collapses duplicate keys but `jsonc.modify` rewrites only one occurrence,
 * so a duplicated header would leave the second credential in the exported file. Redaction
 * cannot be guaranteed complete for such a file, so refuse it instead.
 */
function assertNoDuplicateKeys(tree: jsonc.Node, fileName: string): void {
  const visit = (node: jsonc.Node): void => {
    if (node.type === "object") {
      const names = new Set<string>();
      for (const property of node.children ?? []) {
        const name: unknown = property.children?.[0]?.value;
        if (typeof name === "string") {
          if (names.has(name)) throw new Error(`Invalid ${fileName}: duplicate key '${name}'`);
          names.add(name);
        }
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
}

function parseJsoncObjectWithTree(
  raw: string,
  fileName: string
): { parsed: Record<string, unknown>; tree: jsonc.Node } {
  const errors: jsonc.ParseError[] = [];
  const parsed: unknown = jsonc.parse(raw, errors);
  const tree = jsonc.parseTree(raw);
  const record = readRecord(parsed);
  if (errors.length > 0 || !record || tree?.type !== "object") {
    throw new Error(`Invalid ${fileName}`);
  }
  assertNoDuplicateKeys(tree, fileName);
  return { parsed: record, tree };
}

function parseJsoncObject(raw: string, fileName: string): Record<string, unknown> {
  return parseJsoncObjectWithTree(raw, fileName).parsed;
}

const JSONC_FORMATTING_OPTIONS: jsonc.FormattingOptions = { tabSize: 2, insertSpaces: true };
const JSONC_EDIT_OPTIONS: jsonc.ModificationOptions = {
  formattingOptions: JSONC_FORMATTING_OPTIONS,
};

/**
 * Rewrites values in place with jsonc edits, leaving the rest of the document as it was.
 * Restore needs that: it writes the file the user just previewed, not a reformatted copy.
 */
function applyJsoncEdits(text: string, edits: Array<{ path: jsonc.JSONPath; value: unknown }>) {
  let result = text;
  for (const edit of edits) {
    result = jsonc.applyEdits(
      result,
      jsonc.modify(result, edit.path, edit.value, JSONC_EDIT_OPTIONS)
    );
  }
  return result;
}

interface JsoncPropertyInsertion {
  leadingText: string;
  propertyText: string;
  trailingCommentText: string;
}

type LocalMcpServerMerge =
  | { kind: "none" }
  | { kind: "replace"; valueText: string }
  | {
      kind: "insert";
      objectPath: jsonc.JSONPath;
      entries: JsoncPropertyInsertion[];
      objectTrailingText: string;
    };

function containsJsoncComma(text: string): boolean {
  const scanner = jsonc.createScanner(text, false);
  for (let token = scanner.scan(); token !== jsonc.SyntaxKind.EOF; token = scanner.scan()) {
    if (token === jsonc.SyntaxKind.CommaToken) return true;
  }
  return false;
}

function lineIndentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const prefix = text.slice(lineStart, offset);
  return /^[\t ]*$/.test(prefix) ? prefix : "";
}

function insertJsoncObjectProperties(
  text: string,
  jsonPath: jsonc.JSONPath,
  entries: readonly JsoncPropertyInsertion[],
  objectTrailingText: string
): string {
  if (entries.length === 0) return text;
  const tree = jsonc.parseTree(text);
  const objectNode = tree ? jsonc.findNodeAtLocation(tree, jsonPath) : undefined;
  if (objectNode?.type !== "object") throw new Error("Invalid mcp.jsonc");

  const properties = objectNode.children ?? [];
  const lastProperty = properties.at(-1);
  const objectEnd = objectNode.offset + objectNode.length - 1;
  const trailingComma =
    lastProperty !== undefined &&
    containsJsoncComma(text.slice(lastProperty.offset + lastProperty.length, objectEnd));
  const objectProperty = objectNode.parent?.type === "property" ? objectNode.parent : undefined;
  const closingIndent = lineIndentAt(text, objectProperty?.offset ?? objectNode.offset);
  const propertyIndent = `${closingIndent}${" ".repeat(JSONC_FORMATTING_OPTIONS.tabSize ?? 2)}`;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const entryText = entries
    .map((entry, index) => {
      const leadingText = entry.leadingText || `${eol}${propertyIndent}`;
      const comma = index < entries.length - 1 || trailingComma ? "," : "";
      const trailingComment =
        entry.trailingCommentText === "" ? "" : ` ${entry.trailingCommentText}`;
      return `${leadingText}${entry.propertyText}${comma}${trailingComment}`;
    })
    .join("");
  const closeLineStart = text.lastIndexOf("\n", objectEnd - 1) + 1;
  const closePrefix = text.slice(closeLineStart, objectEnd);
  const insertAtLineStart = /^[\t ]*$/.test(closePrefix);
  const insertionOffset = insertAtLineStart ? closeLineStart : objectEnd;
  const insertedContent = `${entryText}${objectTrailingText}`;
  const insertionText = insertAtLineStart
    ? `${insertedContent.replace(/^\r?\n/, "")}${eol}`
    : `${insertedContent.startsWith(eol) ? "" : eol}${insertedContent}${eol}${closingIndent}`;

  let result = jsonc.applyEdits(text, [
    { offset: insertionOffset, length: 0, content: insertionText },
  ]);
  if (lastProperty !== undefined && !trailingComma) {
    result = jsonc.applyEdits(result, [
      { offset: lastProperty.offset + lastProperty.length, length: 0, content: "," },
    ]);
  }
  return result;
}

function replaceJsoncNodeText(text: string, jsonPath: jsonc.JSONPath, valueText: string): string {
  const tree = jsonc.parseTree(text);
  const node = tree ? jsonc.findNodeAtLocation(tree, jsonPath) : undefined;
  if (!node) throw new Error("Invalid mcp.jsonc");
  return jsonc.applyEdits(text, [{ offset: node.offset, length: node.length, content: valueText }]);
}

/**
 * `McpConfigService.readConfigFile` enumerates `servers` with `Object.entries`, so an array or
 * a string there becomes runnable servers named by index rather than being ignored. A document
 * like that cannot be projected field by field, so both an export and a restore refuse it
 * instead of passing a shape the runtime accepts through unexamined.
 * A falsy value is not this case: the runtime returns no servers at all for it.
 */
function isUnsupportedServerMap(value: unknown): boolean {
  return Boolean(value) && (typeof value !== "object" || Array.isArray(value));
}

/**
 * Fields Xum itself reads (`McpConfigService.normalizeEntry`), with the type it reads them as.
 * Anything else in the document, at any depth, is replaced with the marker: `normalizeEntry`
 * ignores an unrecognised field such as `env` or `args`, so nobody here can say whether its
 * value is a credential, and `{ "API_KEY": "hunter2" }` is not something a scanner can catch.
 * Restore puts the local value back at that exact path, so a field only Xum ignores is not
 * lost from a machine that already has it.
 *
 * `command` and `url` pass the type check but can still carry credentials in-band, so the
 * projection additionally redacts env-style assignment values in commands and whole urls
 * with credential components.
 */
const PORTABLE_SERVER_FIELDS: Record<string, (value: unknown) => boolean> = {
  command: (value) => typeof value === "string",
  url: (value) => typeof value === "string",
  transport: (value) =>
    value === "stdio" || value === "http" || value === "sse" || value === "auto",
  disabled: (value) => typeof value === "boolean",
  toolAllowlist: (value) => Array.isArray(value) && value.every((tool) => typeof tool === "string"),
};

/**
 * A jsonc edit keeps every comment, and a comment is prose the projection cannot inspect, so a
 * local `// token=hunter2` beside a server would be published verbatim and the scanner would
 * not recognise it either. Reserializing publishes only the values this file kept.
 */
function serializeProjectedMcp(text: string): {
  content: Buffer;
  parsed: Record<string, unknown>;
} {
  const parsed = readRecord(jsonc.parse(text));
  if (!parsed) throw new Error("Invalid mcp.jsonc");
  return {
    content: Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf-8"),
    parsed,
  };
}

function valueHasRedactionAtPath(
  root: Record<string, unknown>,
  jsonPath: BackupRedactionPath
): boolean {
  let value: unknown = root;
  for (const segment of jsonPath) {
    if (typeof segment === "number") {
      value = Array.isArray(value) ? value[segment] : undefined;
      continue;
    }
    const record = readRecord(value);
    value = record ? readOwn(record, segment) : undefined;
  }
  return typeof value === "string" && containsRedaction(value);
}

/**
 * `NAME=value` assignments in a command string are how stdio servers get credentials
 * (`GRAFANA_SERVICE_ACCOUNT_TOKEN=... mcp-grafana`), and nothing here can say which values
 * are secret, so every assignment value is replaced. Matched anywhere in the string, not
 * just before the program name, so `env NAME=value cmd` and trailing `KEY=value` arguments
 * are covered too. The value grammar consumes a whole shell word, escaped characters and
 * quoted segments included, so an escape cannot carry part of the value past the
 * replacement. Restore puts the whole local command back at that path.
 */
// The shell ends a word at these without whitespace, so an assignment can directly follow
// one (`bootstrap;TOKEN=... mcp`) and an unquoted value ends at the next one. Braces are
// deliberately absent: brace expansion happens within one word and non-expanding braces
// are literal, so braces travel inside names and values, where a replaced marker
// distributes safely through any expansion (`TOK{A,B}=x` becomes `TOKA=x TOKB=x`).
const SHELL_WORD_BREAK = ";&|<>()`";
// Only space, tab, and newline delimit words for Bash. JS `\s` would also break on NBSP
// and its other Unicode cousins, which Bash keeps inside the word: an assignment value
// would end early there, publishing the rest of the runtime value as its own word.
const SHELL_BLANK = " \\t\\n";
// Any non-option word up to an unquoted `=` is an assignment name: GNU `env` accepts
// arbitrary `NAME=VALUE` operands (`TOKEN:NAME=x`, `TOKEN+=x`), and Bash's identifier
// rule is just the narrow case. Quoting, `$`, and `=` end a name; a leading dash is an
// option word (`--transport=stdio`), which stays published.
const ASSIGNMENT_NAME = `[^-${SHELL_BLANK}\\\\'"$=${SHELL_WORD_BREAK}][^${SHELL_BLANK}\\\\'"$=${SHELL_WORD_BREAK}]*=`;
const ASSIGNMENT_VALUE = `(?:\\\\[\\s\\S]|'[^']*'|"(?:\\\\[\\s\\S]|[^"\\\\])*"|[^${SHELL_BLANK}\\\\'"${SHELL_WORD_BREAK}]+)+`;
const COMMAND_ENV_ASSIGNMENT = new RegExp(
  `(^|[${SHELL_BLANK}${SHELL_WORD_BREAK}])(${ASSIGNMENT_NAME})(${ASSIGNMENT_VALUE})`,
  "g"
);

/**
 * An assignment value the word grammar could not fully consume: after replacement its
 * remainder trails the marker, or the whole match failed and the original text follows the
 * `=`. Either way the value's true extent is unknowable, e.g. an unterminated quote.
 */
const UNCONSUMED_ASSIGNMENT = new RegExp(
  `(^|[${SHELL_BLANK}${SHELL_WORD_BREAK}])${ASSIGNMENT_NAME}` +
    `(?!${REDACTED_BACKUP_VALUE}(?=[${SHELL_BLANK}${SHELL_WORD_BREAK}]|$))(?=[^${SHELL_BLANK}${SHELL_WORD_BREAK}])`
);

/** One whole shell word, however its quoted and escaped segments interleave. */
const SHELL_WORD = new RegExp(
  `(?:\\\\[\\s\\S]|'[^']*'|"(?:\\\\[\\s\\S]|[^"\\\\])*"|[^${SHELL_BLANK}\\\\'"${SHELL_WORD_BREAK}])+`,
  "g"
);
const ASSIGNMENT_START = new RegExp(`^${ASSIGNMENT_NAME}`);

/**
 * A parameter expansion that can turn into nothing at runtime: an unset variable.
 * Deleting it models the vanish-splice (`ghp_aaa$NOPE"bbb"` joins around the expansion
 * the quote boundary ends). Redaction localizes every command holding an active
 * expansion before anything publishes, so this deletion survives only as the
 * backstop's independent model of that splice over the finished payload.
 */
const SIMPLE_EXPANSION = /^\$[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Bash-accurate quote removal, in both directions on purpose: under-stripping would hide
 * disguised assignments, while over-stripping would join quoted fragments the shell
 * keeps apart and manufacture no-override credential matches (`'ghp_aa\\bb'` keeps its
 * backslash at runtime). `stripExpansions` deletes simple parameter expansions only in
 * the contexts where the shell expands them, so a single-quoted or escaped dollar stays
 * the literal the process receives.
 */
function unquoteShellWord(word: string, stripExpansions = false, collapseGlobs = false): string {
  let result = "";
  let i = 0;
  while (i < word.length) {
    const char = word[i];
    // ANSI-C ($'...') and locale ($"...") quoting hand the consumer their inner text.
    if (char === "$" && (word[i + 1] === "'" || word[i + 1] === '"')) {
      i += 1;
      continue;
    }
    if (char === "$" && stripExpansions) {
      const expansion = SIMPLE_EXPANSION.exec(word.slice(i));
      if (expansion) {
        i += expansion[0].length;
        continue;
      }
    }
    if (char === "\\") {
      // A line continuation disappears entirely. Only backslash-LF: before CRLF the
      // backslash escapes the CR, which stays a literal character and breaks the word.
      if (word[i + 1] === "\n") {
        i += 2;
        continue;
      }
      result += word[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (char === "'") {
      const end = word.indexOf("'", i + 1);
      result += word.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (char === '"') {
      let j = i + 1;
      while (j < word.length && word[j] !== '"') {
        // Expansions stay active inside double quotes.
        if (word[j] === "$" && stripExpansions) {
          const expansion = SIMPLE_EXPANSION.exec(word.slice(j));
          if (expansion) {
            j += expansion[0].length;
            continue;
          }
        }
        if (word[j] === "\\") {
          const next = word[j + 1] ?? "";
          // Inside double quotes the shell unescapes only these; any other
          // backslash stays a literal character.
          if (next === "$" || next === "`" || next === '"' || next === "\\") {
            result += next;
            j += 2;
            continue;
          }
          if (next === "\n") {
            j += 2;
            continue;
          }
          result += word[j];
          j += 1;
          continue;
        }
        result += word[j];
        j += 1;
      }
      i = j + 1;
      continue;
    }
    if (collapseGlobs) {
      // Pathname expansion is live in this unquoted context. A single caseless
      // member is deterministic (`[8]` can only produce `8`), and any reader
      // collapses the published spelling the same way, so scan what it yields.
      // Letter members and nondeterministic wildcards never reach this scan:
      // redaction localizes their whole command (nocaseglob makes letters casefold).
      if (char === "[" && word[i + 2] === "]") {
        const member = word[i + 1] ?? "";
        if (!"!^]\\'\"".includes(member) && !/[A-Za-z]/.test(member)) {
          result += member;
          i += 3;
          continue;
        }
      }
    }
    result += char;
    i += 1;
  }
  return result;
}

/**
 * The words Bash would execute: an unquoted `#` opening a word after a blank (or the
 * string start) discards the rest of that line before quote removal even applies, so
 * scanning a comment would manufacture no-override matches from prose the process never
 * sees. Text past the newline is live again and re-tokenized from scratch, because a
 * quoted word begun inside the comment must not swallow it.
 */
function executedShellWords(text: string): string[] {
  const words: string[] = [];
  let rest: string | undefined = text;
  while (rest !== undefined) {
    const current: string = rest;
    rest = undefined;
    for (const match of current.matchAll(SHELL_WORD)) {
      const start = match.index;
      const before = start === 0 ? "" : (current[start - 1] ?? "");
      // Any word break opens a comment position, not just blanks: `cmd;# ...` comments,
      // and where the grammar wanted a word instead (`>#f`) Bash reports a syntax error
      // and executes nothing, so skipping the text cannot hide a live word either way.
      // Leading backslash-LF continuations disappear before tokenization, so a word
      // spelled `\<LF>#...` opens the same comment its unwrapped form would.
      if (
        match[0].replace(/^(?:\\\n)+/, "").startsWith("#") &&
        (start === 0 ||
          before === " " ||
          before === "\t" ||
          before === "\n" ||
          SHELL_WORD_BREAK.includes(before))
      ) {
        const lineEnd = current.indexOf("\n", start);
        if (lineEnd !== -1) rest = current.slice(lineEnd + 1);
        break;
      }
      words.push(match[0]);
    }
  }
  return words;
}

/**
 * GNU `env -S`/`--split-string` re-splits its attached value into assignments, and GNU
 * getopt accepts any unique long-option abbreviation. No other `env` long option starts
 * with `s`, so every `--s...` prefix spelling (`--s=`, `--split=`) resolves to it.
 */
function isSplitStringOption(unquoted: string): boolean {
  if (/^-[A-Za-z0-9]*S/.test(unquoted)) return true;
  const abbreviation = /^--([A-Za-z-]*)=/.exec(unquoted);
  return (
    abbreviation !== null && abbreviation[1] !== "" && "split-string".startsWith(abbreviation[1])
  );
}

/** Exactly one replaced assignment, nothing else riding along in the same word. */
const CONSUMED_ASSIGNMENT = new RegExp(`^${ASSIGNMENT_NAME}${REDACTED_BACKUP_VALUE}$`);

/**
 * The word with every quoted or escaped character reduced to one placeholder, so a
 * syntax test sees only the regions Bash parses as syntax: a quoted comma cannot
 * trigger brace expansion and a quoted bracket cannot open a glob class. The
 * placeholder keeps the active fragments around a quoted run from splicing into
 * syntax that never existed (`{a.'x'.b}` must not read as `{a..b}`).
 */
function activeWordProjection(word: string): string {
  let result = "";
  let i = 0;
  while (i < word.length) {
    const char = word[i];
    if (char === "\\") {
      result += "_";
      i += 2;
      continue;
    }
    if (char === "'") {
      const end = word.indexOf("'", i + 1);
      result += "_";
      i = end === -1 ? word.length : end + 1;
      continue;
    }
    if (char === '"') {
      let j = i + 1;
      while (j < word.length && word[j] !== '"') {
        j += word[j] === "\\" ? 2 : 1;
      }
      result += "_";
      i = j + 1;
      continue;
    }
    result += char;
    i += 1;
  }
  return result;
}

/**
 * A glob whose output depends on the working directory: `?`, `*`, and any class other
 * than `[c]` with one plain literal member expand against whatever files exist, so a
 * wildcard inside a known token prefix (`gh?_...`) can hand the process a credential no
 * textual scan reconstructs. Escaped, quoted, negated, and `]` members are excluded
 * from the deterministic form: the projection cannot represent them faithfully, and
 * only the plain `[c]` spelling is what the scan's collapse pass reproduces. A single
 * quote-aware pass rather than a regex, because a regex restarts its `]` search at
 * every bracket of a long literal `[` run, going quadratic on input an 8 MB mcp.jsonc
 * can deliver to this synchronous scan. Unmatched `[` stays literal for Bash but
 * localizes here, one more undecidable-cheap case.
 */
function hasNondeterministicGlob(word: string): boolean {
  let i = 0;
  while (i < word.length) {
    const char = word[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === "'") {
      const end = word.indexOf("'", i + 1);
      i = end === -1 ? word.length : end + 1;
      continue;
    }
    if (char === '"') {
      let j = i + 1;
      while (j < word.length && word[j] !== '"') {
        j += word[j] === "\\" ? 2 : 1;
      }
      i = j + 1;
      continue;
    }
    if (char === "?" || char === "*") return true;
    if (char === "[") {
      // A letter member is only deterministic case-sensitively; with nocaseglob
      // inherited via BASHOPTS, `[P]` matches a lowercase `p` file, so letters
      // localize and only caseless members (digits, symbols) collapse.
      const member = word[i + 1] ?? "";
      if (word[i + 2] === "]" && !"!^]\\'\"".includes(member) && !/[A-Za-z]/.test(member)) {
        i += 3;
        continue;
      }
      return true;
    }
    i += 1;
  }
  return false;
}

/**
 * A brace group holding `,` or `..` at any nesting depth expands, and expansion output
 * can reassemble a credential from fragments no scanner recognizes (`ghp_...{8..8}...`,
 * nested `gh{p,{x}}_...`). Literal braces (`{hunter2}`) do not expand and stay inside
 * the word the ordinary rules cover. A depth stack rather than a flat regex, because an
 * inner non-expanding group otherwise hides the expanding outer one. Runs on the active
 * projection, so quoted commas stay inert.
 */
function hasActiveBraceExpansion(active: string): boolean {
  const groupExpands: boolean[] = [];
  let i = 0;
  while (i < active.length) {
    const char = active[i];
    if (char === "{") groupExpands.push(false);
    else if (char === "}" && groupExpands.length > 0) {
      if (groupExpands.pop()) return true;
    } else if (
      groupExpands.length > 0 &&
      (char === "," || (char === "." && active[i + 1] === "."))
    ) {
      groupExpands[groupExpands.length - 1] = true;
    }
    i += 1;
  }
  return false;
}

/**
 * Shells whose `-c` payload (or script argument) is reparsed under full expansion
 * rules: a quoted script with no literal whitespace still synthesizes separators
 * there (`bash -c 'printf${IFS}%s...'`), so naming one localizes the command.
 * Matched on the quote-removed word's basename, covering `/bin/sh` spellings. A
 * custom wrapper that reparses its argv is per-program knowledge no shell-syntax
 * scan can model, the same boundary drawn for `tee` and option semantics; these
 * names are the shells the platform actually ships.
 */
const SHELL_INTERPRETER_NAMES = new Set([
  "sh",
  "bash",
  "dash",
  "ash",
  "zsh",
  "ksh",
  "mksh",
  "csh",
  "tcsh",
  "fish",
  "busybox",
  "pwsh",
  "powershell",
]);

/**
 * Builtins that rewrite shell state the word scans cannot follow: `eval` reparses its
 * concatenated arguments, and the others give a shell-built value environment or
 * parameter visibility without any `=` or `$` spelling. Matched on quote-removed
 * words, so a binary that merely contains the letters (`evaluate`) stays an argument.
 */
const SHELL_STATE_WORDS = new Set([
  "eval",
  "export",
  "declare",
  "typeset",
  "readonly",
  "local",
  "set",
  // `shopt -so allexport` flips the same allexport state `set -a` does, and
  // `shopt -s expand_aliases` opens alias rewriting of later lines.
  "shopt",
  // `source`/`.` run a file in this shell with the remaining words as positionals
  // (`source ./launch ghp_aaa bbb` can join them into one runtime token). A bare `.`
  // argument (the cwd) localizes with it: keywords like `do` make command-position
  // detection undecidable here, so the dot fails closed like every ambiguous form.
  "source",
  ".",
]);

/**
 * Words that hand a downstream consumer an assignment the shell itself does not see,
 * none of them decidable here. Only a word that is exactly one consumed assignment is
 * exempt (`A="B=1"` cannot fire); a marker merely inside a larger word proves nothing
 * about the rest of that word.
 */
function hasDisguisedAssignment(redacted: string): boolean {
  let operandsOnly = false;
  for (const word of redacted.match(SHELL_WORD) ?? []) {
    if (CONSUMED_ASSIGNMENT.test(word)) continue;
    // Bash expands neither syntax from quoted or escaped text (`--config
    // '{"a":1,"b":2}'` stays a literal argument). The brace test runs on the active
    // projection; the glob analyzer is quote-aware itself and needs the raw word to
    // tell `[\p]` (escaped member) from `[p]`.
    if (hasActiveBraceExpansion(activeWordProjection(word))) return true;
    if (hasNondeterministicGlob(word)) return true;
    const unquoted = unquoteShellWord(word);
    // `eval` concatenates its arguments and reparses the result, dissolving one more
    // layer of quoting than any single-pass scan models (`ghp_a\\\\b` reaches the
    // process as `ghp_ab`), wherever the word sits: even mid-command it still names
    // the builtin to some consumer (`env eval ...`, `bash -c 'eval ...'`). The
    // export-family builtins move a shell-built variable into the environment with
    // no `=` or `$` in the text (`printf -v TOKEN ...; export TOKEN`), and `set`
    // reaches the same end through `-a` or the positional parameters.
    if (SHELL_STATE_WORDS.has(unquoted)) return true;
    if (SHELL_INTERPRETER_NAMES.has(unquoted.slice(unquoted.lastIndexOf("/") + 1))) return true;
    // Option terminators end option parsing: past one even a dash-led word is an
    // operand, so `env -- --evil=x` sets an environment entry despite the option look.
    // GNU `env` documents `[-]` as a terminator too, and the consumer sees the word
    // after quote removal, so `"--"` and `\-\-` spellings count as well.
    if (unquoted === "-" || unquoted === "--") {
      operandsOnly = true;
      continue;
    }
    // A quoted region spanning whitespace is a script or argument string some
    // interpreter re-parses on its own terms (`sh -c '...'`, `powershell -Command
    // '$env:TOKEN=...; ...'`, `csh -c 'setenv TOKEN ...'`, `env -S'...'`); what that
    // grammar treats as an assignment is not decidable here.
    if (/\s/.test(unquoted)) return true;
    if (!word.includes("=")) continue;
    if (operandsOnly) return true;
    // GNU `env` reads a bare `=value` word as an assignment operand too.
    if (unquoted.startsWith("=")) return true;
    // A quote-mangled `NAME=` spelling (`TOKEN\\=x`, `'TOKEN'=x`) for `env`/`eval`.
    if (ASSIGNMENT_START.test(unquoted)) return true;
    // A split-string option with its value attached (`-STOKEN=x`, `--s=TOKEN=x`).
    if (isSplitStringOption(unquoted)) return true;
    // An option value can embed a whole assignment for the target program
    // (`systemd-run --setenv=TOKEN=x`, `--env=TOKEN=x`): a second `=` past the
    // option's own separator marks one. Plain long-option flag values
    // (`--transport=stdio`) carry no inner `=` and stay published.
    if (
      unquoted.startsWith("-") &&
      ASSIGNMENT_START.test(unquoted.slice(unquoted.indexOf("=") + 1))
    ) {
      return true;
    }
    // A short option with an attached argument leaves no boundary before the
    // assignment (`systemd-run -ETOKEN=x`, `-Dapi.key=x`), and which letters take
    // env-like arguments is per-program knowledge this scan cannot have.
    if (/^-[^-]/.test(unquoted)) return true;
    // `=` mixed with quoting or expansion machinery: some other grammar's assignment
    // (`$env:TOKEN=x`, `python -c 'os.environ["TOKEN"]="x"'` fragments).
    if (/['"\\$]/.test(word)) return true;
  }
  return false;
}

/**
 * The undecidable constructs, detected only where the shell parses them. An expansion
 * body can carry arbitrary bytes into one runtime word (`TOKEN$(printf =hunter2)`,
 * `$'TOKEN\x3d...'`, legacy arithmetic `TOKEN$[0]=...`), and every parameter
 * expansion depends on execution state the words cannot show: the command itself can
 * fill `$1` (`set -- p`) or a plain `$X` with no assignment word to rewrite
 * (`for X in p`, `printf -v X p`), so `gh$X'_'...` runs as a contiguous credential
 * no scan of the spelling reconstructs. Any of them makes assignment detection
 * undecidable. A
 * here-document or here-string feeds the consumer a body under document rules the word
 * scans would misread. Process substitution and write redirection each hand the
 * consumer a file whose bytes the command chooses (`--token-file <(printf a;printf b)`,
 * `printf a >f; printf b >>f`), assignment or not, so both localize; program-internal
 * writes (`tee`) are per-program knowledge no shell-syntax scan can model, the same
 * boundary drawn for option semantics. A pipe moves one stage's bytes into the next
 * (`printf a | { read -r T; export T; ... }`), so pipes localize too, while `||` and
 * `&&` carry no data and stay portable. With `extglob` inherited via BASHOPTS, `?( *( +( @( !(` open one
 * pathname pattern whose file match can complete a credential, undecidable like any
 * glob. Single-quoted, escaped, and commented spellings are inert
 * (`--pattern '$(date)'` is a literal argument a raw-string test would localize), while
 * double quotes keep expansions live but make redirections literal.
 */
function findActiveShellConstructs(command: string): {
  carrier: boolean;
  heredoc: boolean;
  processSubstitution: boolean;
  redirection: boolean;
  pipeline: boolean;
} {
  const found = {
    carrier: false,
    heredoc: false,
    processSubstitution: false,
    redirection: false,
    pipeline: false,
  };
  let i = 0;
  let wordStart = true;
  // The previous character as Bash sees it, or "" when that character was quoted or
  // escaped: extglob operators only form from two adjacent unquoted characters.
  let prevActive = "";
  while (i < command.length) {
    const char = command[i];
    if (char === "\\") {
      // A backslash-LF continuation vanishes before tokenization, so it neither opens
      // nor ends a word: a `#` right after `cmd \` still sits at a comment position.
      if (command[i + 1] !== "\n") {
        wordStart = false;
        prevActive = "";
      }
      i += 2;
      continue;
    }
    if (char === "'") {
      const end = command.indexOf("'", i + 1);
      i = end === -1 ? command.length : end + 1;
      wordStart = false;
      prevActive = "";
      continue;
    }
    if (char === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        if (command[j] === "\\") {
          j += 2;
          continue;
        }
        if (command[j] === "`") found.carrier = true;
        if (command[j] === "$" && /[({[!0-9@*#?$A-Za-z_-]/.test(command[j + 1] ?? "")) {
          found.carrier = true;
        }
        j += 1;
      }
      i = j + 1;
      wordStart = false;
      prevActive = "";
      continue;
    }
    if (char === "#" && wordStart) {
      const lineEnd = command.indexOf("\n", i);
      if (lineEnd === -1) break;
      i = lineEnd + 1;
      wordStart = true;
      prevActive = "";
      continue;
    }
    if (char === "`") {
      found.carrier = true;
      i += 1;
      wordStart = false;
      prevActive = char;
      continue;
    }
    if (char === "$") {
      if (/[({['"!0-9@*#?$A-Za-z_-]/.test(command[i + 1] ?? "")) found.carrier = true;
      i += 1;
      wordStart = false;
      prevActive = char;
      continue;
    }
    if (char === "<") {
      if (command[i + 1] === "<") found.heredoc = true;
      if (command[i + 1] === "(") found.processSubstitution = true;
      i += 1;
      wordStart = true;
      prevActive = char;
      continue;
    }
    if (char === ">") {
      if (command[i + 1] === "(") found.processSubstitution = true;
      // Any write redirection lets the command assemble a file whose bytes the scans
      // cannot model (`printf a >f; printf b >>f; mcp --token-file f`).
      found.redirection = true;
      i += 1;
      wordStart = true;
      prevActive = char;
      continue;
    }
    if (char === "|") {
      // `||` is a control operator with no data flow, but a pipe (`|`, `|&`) hands one
      // stage's bytes to the next, where `read` can turn published fragments into an
      // exported variable.
      if (command[i + 1] === "|") {
        i += 2;
        wordStart = true;
        prevActive = char;
        continue;
      }
      found.pipeline = true;
      i += 1;
      wordStart = true;
      prevActive = char;
      continue;
    }
    if (char === "(" && prevActive !== "" && "?*+@!".includes(prevActive)) {
      found.carrier = true;
    }
    wordStart = char === " " || char === "\t" || char === "\n" || SHELL_WORD_BREAK.includes(char);
    prevActive = char;
    i += 1;
  }
  return found;
}

/**
 * The command split at Bash comment boundaries, quote-aware: assignment-like prose in a
 * comment must neither be rewritten (Bash never evaluates it, and a marker would make
 * the whole command machine-local) nor feed the residue checks. Each piece keeps its
 * trailing comment, and the newline that ends a comment stays in the next piece's code,
 * so per-piece replacement sees the same boundaries the one-string form did.
 */
function splitCommandComments(command: string): Array<{ code: string; comment: string }> {
  const pieces: Array<{ code: string; comment: string }> = [];
  let code = "";
  let i = 0;
  let wordStart = true;
  while (i < command.length) {
    const char = command[i];
    if (char === "#" && wordStart) {
      const lineEnd = command.indexOf("\n", i);
      const end = lineEnd === -1 ? command.length : lineEnd;
      pieces.push({ code, comment: command.slice(i, end) });
      code = "";
      i = end;
      wordStart = true;
      continue;
    }
    if (char === "\\") {
      code += command.slice(i, i + 2);
      // Invisible to tokenization, a continuation keeps the comment position open.
      if (command[i + 1] !== "\n") wordStart = false;
      i += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      const quote = char;
      let j = i + 1;
      while (j < command.length && command[j] !== quote) {
        j += quote === '"' && command[j] === "\\" ? 2 : 1;
      }
      code += command.slice(i, Math.min(j + 1, command.length));
      i = j + 1;
      wordStart = false;
      continue;
    }
    code += char;
    wordStart = char === " " || char === "\t" || char === "\n" || SHELL_WORD_BREAK.includes(char);
    i += 1;
  }
  pieces.push({ code, comment: "" });
  return pieces;
}

/**
 * The command with every active line continuation removed. Bash deletes an unquoted or
 * double-quoted backslash-LF before any expansion, so syntax split across one
 * (`$`+continuation+`(`, a brace sequence's `..`) reads contiguously to the shell
 * while a per-character analyzer would see an escape pair. Single-quoted pairs stay the
 * literal bytes the process receives, and a comment's backslash is prose that cannot
 * hide the newline ending the comment.
 */
function removeActiveLineContinuations(command: string): string {
  let result = "";
  let i = 0;
  let wordStart = true;
  while (i < command.length) {
    const char = command[i];
    if (char === "\\") {
      if (command[i + 1] === "\n") {
        i += 2;
        continue;
      }
      result += command.slice(i, i + 2);
      i += 2;
      wordStart = false;
      continue;
    }
    if (char === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end === -1 ? command.length : end + 1;
      result += command.slice(i, stop);
      i = stop;
      wordStart = false;
      continue;
    }
    if (char === '"') {
      result += char;
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        if (command[j] === "\\" && command[j + 1] === "\n") {
          j += 2;
          continue;
        }
        if (command[j] === "\\") {
          result += command.slice(j, j + 2);
          j += 2;
          continue;
        }
        result += command[j];
        j += 1;
      }
      if (j < command.length) result += '"';
      i = j + 1;
      wordStart = false;
      continue;
    }
    if (char === "#" && wordStart) {
      const lineEnd = command.indexOf("\n", i);
      const end = lineEnd === -1 ? command.length : lineEnd;
      result += command.slice(i, end);
      i = end;
      continue;
    }
    result += char;
    wordStart = char === " " || char === "\t" || char === "\n" || SHELL_WORD_BREAK.includes(char);
    i += 1;
  }
  return result;
}

/**
 * Fail closed before any per-character analysis: mcp.jsonc may be megabytes, and the
 * walks below hold per-character state (projection copies, brace stacks), so an
 * adversarial brace wall could stall the synchronous main process for seconds and
 * balloon memory. No legitimate portable command approaches this length; beyond it the
 * command goes machine-local without being parsed at all.
 */
export const MAX_ANALYZED_COMMAND_LENGTH = 32_768;

/**
 * The per-command cap composes: a near-8 MB mcp.jsonc can hold ~250 commands that each
 * pass it, and their walks together still stall the synchronous main process for
 * seconds. One aggregate budget per config bounds total analysis work; commands past
 * it go machine-local unparsed, exactly like a single oversized command.
 */
export const MAX_TOTAL_ANALYZED_COMMAND_LENGTH = 8 * MAX_ANALYZED_COMMAND_LENGTH;

function redactCommandEnvAssignments(command: string): string {
  if (command.length > MAX_ANALYZED_COMMAND_LENGTH) return REDACTED_BACKUP_VALUE;
  // Analysis mirrors execution: active continuations vanish first, so every analyzer
  // below sees the same contiguous syntax the shell parses.
  const analyzed = removeActiveLineContinuations(command);
  const pieces = splitCommandComments(analyzed);
  const redactedPieces = pieces.map((piece) =>
    piece.code.replace(
      COMMAND_ENV_ASSIGNMENT,
      (_match, lead: string, name: string) => `${lead}${name}${REDACTED_BACKUP_VALUE}`
    )
  );
  const redactedCode = redactedPieces.join("");
  // When an assignment's boundaries cannot be trusted, no partial rewrite can be either,
  // so the whole command goes local and restore puts the exact text back. The residue and
  // quote-led checks run even when nothing was replaced: an unconsumable or quote-led
  // value means the replacement never saw it.
  const constructs = findActiveShellConstructs(analyzed);
  if (
    UNCONSUMED_ASSIGNMENT.test(redactedCode) ||
    hasDisguisedAssignment(redactedCode) ||
    constructs.carrier ||
    constructs.heredoc ||
    constructs.processSubstitution ||
    constructs.redirection ||
    constructs.pipeline
  ) {
    return REDACTED_BACKUP_VALUE;
  }
  const rewritten = redactedPieces
    .map((piece, index) => piece + (pieces[index]?.comment ?? ""))
    .join("");
  // Nothing to redact: the original spelling, wrapped lines and all, is what executes.
  if (rewritten === analyzed) return command;
  // Markers are positioned in the unwrapped spelling; when the original wrapped lines,
  // mapping them back onto the wrapped text is not decidable, so the command goes
  // machine-local instead of publishing a respelled value.
  return analyzed === command ? rewritten : REDACTED_BACKUP_VALUE;
}

function redactMcpConfig(content: Buffer): {
  content: Buffer;
  redactionPaths: BackupRedactionPath[];
} {
  const text = content.toString("utf-8");
  const { parsed: root, tree } = parseJsoncObjectWithTree(text, "mcp.jsonc");
  const redactionPaths: BackupRedactionPath[] = [];
  const edits: Array<{ path: jsonc.JSONPath; value: unknown }> = [];

  function redact(jsonPath: jsonc.JSONPath): void {
    edits.push({ path: jsonPath, value: REDACTED_BACKUP_VALUE });
    redactionPaths.push([...jsonPath]);
  }

  let analysisBudget = MAX_TOTAL_ANALYZED_COMMAND_LENGTH;

  function redactCommand(jsonPath: jsonc.JSONPath, command: string): void {
    let redacted: string;
    if (command.length > analysisBudget) {
      redacted = REDACTED_BACKUP_VALUE;
    } else {
      analysisBudget -= command.length;
      redacted = redactCommandEnvAssignments(command);
    }
    if (redacted === command) return;
    edits.push({ path: jsonPath, value: redacted });
    redactionPaths.push([...jsonPath]);
  }

  function finish(): { content: Buffer; redactionPaths: BackupRedactionPath[] } {
    const projected = serializeProjectedMcp(applyJsoncEdits(text, edits));
    const retainedRedactionPaths = redactionPaths.filter((jsonPath) =>
      valueHasRedactionAtPath(projected.parsed, jsonPath)
    );
    assertBackupMcpRedactions(retainedRedactionPaths);
    return {
      content: projected.content,
      redactionPaths: retainedRedactionPaths,
    };
  }

  // Names come from the document rather than the parse result throughout, because
  // `jsonc.parse` drops a `__proto__` key while the text keeps it. Enumerating the parsed
  // object would leave such a key, and its value, published verbatim.
  for (const key of objectKeyNames(tree, [])) {
    if (key !== "servers") redact([key]);
  }

  const servers = readOwn(root, "servers");
  // Refused rather than redacted: restore rejects this shape on every machine, including the
  // one that wrote it, so redacting here would report a successful push for a backup that can
  // never be restored.
  if (isUnsupportedServerMap(servers)) {
    throw new BackupInvalidPayloadError(
      new Error(
        "Cannot back up: mcp.jsonc lists servers as something other than an object. Fix the local file, then back up again."
      )
    );
  }
  const serverRecord = readRecord(servers);
  if (!serverRecord) return finish();

  for (const serverName of objectKeyNames(tree, ["servers"])) {
    const rawServer = readOwn(serverRecord, serverName);
    // A bare string entry is the stdio command itself (`McpConfigService.normalizeEntry`).
    if (typeof rawServer === "string") {
      redactCommand(["servers", serverName], rawServer);
      continue;
    }
    const server = readRecord(rawServer);
    if (!server) {
      redact(["servers", serverName]);
      continue;
    }

    for (const field of objectKeyNames(tree, ["servers", serverName])) {
      const fieldPath: jsonc.JSONPath = ["servers", serverName, field];
      const value = readOwn(server, field);
      const isPortableField = Object.hasOwn(PORTABLE_SERVER_FIELDS, field)
        ? PORTABLE_SERVER_FIELDS[field]
        : undefined;
      if (isPortableField) {
        // Read as the wrong type, `normalizeEntry` ignores it, which makes it another place
        // to hide a value nobody reads.
        if (!isPortableField(value)) {
          redact(fieldPath);
          continue;
        }
        if (field === "command" && typeof value === "string") redactCommand(fieldPath, value);
        // Whole-value, not in-string: the userinfo/parameter detection deliberately covers
        // malformed and percent-encoded spellings a partial rewrite could misparse and leave
        // the credential in. Restore puts the local url back at this path.
        if (field === "url" && typeof value === "string" && urlHasCredentialComponents(value)) {
          redact(fieldPath);
        }
        continue;
      }
      if (field === "headers") {
        const headers = readRecord(value);
        if (!headers) {
          redact(fieldPath);
          continue;
        }
        for (const headerName of objectKeyNames(tree, fieldPath)) {
          if (!isPortableReference(readOwn(headers, headerName))) {
            redact([...fieldPath, headerName]);
          }
        }
        continue;
      }
      // Xum ignores every other field, so its value may carry credentials under a shape this
      // projection cannot classify. Restore uses only the local value at that exact path.
      redact(fieldPath);
    }
  }
  return finish();
}

function findMcpRedactionPaths(tree: jsonc.Node): BackupRedactionPath[] {
  const paths: BackupRedactionPath[] = [];
  const jsonPath: BackupRedactionPath = [];

  function walk(node: jsonc.Node): void {
    if (node.type === "string") {
      if (typeof node.value === "string" && containsRedaction(node.value)) {
        paths.push([...jsonPath]);
      }
      return;
    }
    if (node.type === "array") {
      for (const [index, child] of (node.children ?? []).entries()) {
        jsonPath.push(index);
        walk(child);
        jsonPath.pop();
      }
      return;
    }
    if (node.type !== "object") return;
    for (const property of node.children ?? []) {
      const key: unknown = property.children?.[0]?.value;
      const value = property.children?.[1];
      if (typeof key !== "string" || !value) continue;
      jsonPath.push(key);
      walk(value);
      jsonPath.pop();
    }
  }

  walk(tree);
  return paths;
}

/**
 * JSON, not delimiter-joined: server and header names come from the backup, so a crafted
 * name containing the delimiter could collide with another entry's field path and shadow
 * its resolution (e.g. skipping the header drop for a server named `safe\u0000url`).
 */
function redactionPathKey(jsonPath: ReadonlyArray<string | number>): string {
  return JSON.stringify(jsonPath);
}

function redactionPathLabel(jsonPath: ReadonlyArray<string | number>): string {
  return jsonPath.join(".");
}

function validateMcpRedactionPaths(tree: jsonc.Node, paths: readonly BackupRedactionPath[]): void {
  if (paths.length === 0) return;
  const markerPaths = new Set(findMcpRedactionPaths(tree).map(redactionPathKey));
  for (const jsonPath of paths) {
    if (!markerPaths.has(redactionPathKey(jsonPath))) {
      throw new BackupInvalidPayloadError(
        new Error(`Invalid MCP redaction path '${redactionPathLabel(jsonPath)}'`)
      );
    }
  }
}

/**
 * Documentation is the only thing a recursive collection publishes without asking. `skills/`
 * and `memory/global/` hold whatever the user put there, and no content scanner can decide
 * whether an arbitrary file is a credential: `{"password":"hunter2"}` has no distinguishing
 * shape. So the gate is structural rather than pattern-based, and anything outside the
 * documented set is surfaced for review instead of being published or silently dropped.
 */
const AUTO_PUBLISHED_RECURSIVE_FILE = /\.(?:md|mdx|markdown|txt)$/i;

/** A name promising credentials earns review even when the extension is documentation. */
const CREDENTIAL_PATH_HINT =
  /(?:^|[^a-z])(?:credential|credentials|secret|secrets|password|passwords|token|tokens|(?:api|private)(?:[^a-z/]+)?keys?|netrc|keychain|htpasswd)(?:[^a-z]|$)/i;

function hasCredentialPathHint(filePath: string): boolean {
  const stem = path.posix.parse(filePath).name.toLowerCase();
  return stem === "auth" || stem === "passwd" || CREDENTIAL_PATH_HINT.test(filePath);
}

const MCP_REVIEW_URL_PARAMETER_NAMES = new Set([
  ...CREDENTIAL_URL_PARAMETER_NAMES,
  "code",
  "key",
  "session",
  "sid",
  "sig",
]);

function rawUrlHasUserinfo(rawUrl: string): boolean {
  const schemeEnd = rawUrl.indexOf("://");
  if (schemeEnd < 0 && !rawUrl.startsWith("//")) return false;
  const authorityStart = schemeEnd >= 0 ? schemeEnd + 3 : 2;
  const delimiters = ["/", "?", "#"]
    .map((delimiter) => rawUrl.indexOf(delimiter, authorityStart))
    .filter((offset) => offset >= 0);
  const authorityEnd = delimiters.length > 0 ? Math.min(...delimiters) : rawUrl.length;
  // Decoded first: a client resolves `user:pw%40host` to userinfo `user:pw`, so the encoded
  // spelling publishes the same credential the literal one is held back for.
  return decodeDelimitersOnce(rawUrl.slice(authorityStart, authorityEnd)).includes("@");
}

function normalizedUrlHasUserinfo(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.username !== "" || parsed.password !== "";
  } catch {
    return false;
  }
}

function malformedSpecialUrlHasUserinfo(rawUrl: string): boolean {
  return /^(?:ftp|https?|wss?):[^/?#]*@/i.test(decodeDelimitersOnce(rawUrl));
}

function urlHasCredentialComponents(rawUrl: string): boolean {
  return (
    rawUrlHasUserinfo(rawUrl) ||
    malformedSpecialUrlHasUserinfo(rawUrl) ||
    normalizedUrlHasUserinfo(rawUrl) ||
    hasCredentialUrlParameters(rawUrl, MCP_REVIEW_URL_PARAMETER_NAMES)
  );
}

function mcpConfigRequiresPublishApproval(content: string): boolean {
  const errors: jsonc.ParseError[] = [];
  const parsed = readRecord(jsonc.parse(content, errors));
  if (errors.length > 0 || !parsed) return false;
  const servers = readRecord(readOwn(parsed, "servers"));
  if (!servers) return false;
  for (const server of Object.values(servers)) {
    const serverRecord = readRecord(server);
    const command =
      typeof server === "string" ? server : serverRecord && readOwn(serverRecord, "command");
    if (typeof command === "string" && command.trim() !== "") return true;
    if (!serverRecord) continue;
    const url = readOwn(serverRecord, "url");
    if (typeof url === "string" && urlHasCredentialComponents(url)) return true;
  }
  return false;
}

function isRecursivelyCollected(filePath: string): boolean {
  return filePath.startsWith("skills/") || filePath.startsWith("memory/global/");
}

/**
 * Files a push must not publish until the user approves this exact payload. Not all of them
 * hold a secret: the structural cases are suspicion rather than detection.
 */
export function scanBackupFilesForSecrets(files: readonly BackupFile[]): string[] {
  return files
    .filter((file) => {
      const content = file.content.toString("utf-8");
      if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) return true;
      if (file.path === "mcp.jsonc" && mcpConfigRequiresPublishApproval(content)) return true;
      // Every collected file, not just the recursive ones: `agents/` is collected by name and
      // its `.md` filter would otherwise auto-publish `agents/api-key.md`.
      if (hasCredentialPathHint(file.path)) return true;
      if (!isRecursivelyCollected(file.path)) return false;
      return !AUTO_PUBLISHED_RECURSIVE_FILE.test(file.path);
    })
    .map((file) => file.path)
    .sort();
}

/**
 * Binds an override to the exact bytes it was shown for. A bare boolean would let approval of
 * one blocked set authorize a later push whose payload another window changed in between.
 */
export function backupSecretApprovalDigest(
  files: readonly BackupFile[],
  flaggedPaths: readonly string[]
): string {
  const flagged = new Set(flaggedPaths);
  // JSON for the same reason as backupCommandApprovalToken: no delimiter is unambiguous
  // once a component can contain it. Paths are portable-checked today, but the digest must
  // not depend on that staying true.
  const parts = files
    .filter((file) => flagged.has(file.path))
    .map((file) => [file.path, sha256(file.content)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(Buffer.from(JSON.stringify(parts), "utf-8"));
}

export async function createBackupPayload(
  options: CreateBackupPayloadOptions
): Promise<BackupPayload> {
  const files = await collectAllowlistedFiles(options.muxRoot);
  const mcpRedactionPaths: BackupRedactionPath[] = [];
  const mcpFile = files.find((file) => file.path === "mcp.jsonc");
  if (mcpFile && options.keepLocalSecrets !== true) {
    const redacted = redactMcpConfig(mcpFile.content);
    mcpFile.content = redacted.content;
    mcpRedactionPaths.push(...redacted.redactionPaths);
  }
  files.push({
    path: "preferences.json",
    content: serializeBackupPreferences(options.preferences),
  });
  // Count and complexity only: this payload may be a local snapshot, whose names keep
  // current-filesystem forms that portable validation would refuse. Collection already
  // validated each name under local rules; publication re-checks with portable rules.
  assertBackupFileCount(files.length);
  assertBackupPathComplexity(files.map((file) => file.path));
  files.sort((a, b) => a.path.localeCompare(b.path));

  // Backstop behind the redaction above, not the primary mechanism: a credential-format
  // match in the finished payload always aborts, with no reportSecrets override. The local
  // safety snapshot keeps secrets by design and never leaves the machine, so it is exempt.
  if (options.keepLocalSecrets !== true) {
    const leakedFiles = files
      .filter((file) => {
        // The path publishes alongside the content, and recursive collections take
        // whatever a directory entry happens to be named.
        const content = file.content.toString("utf-8");
        // NUL-stripping reassembles ASCII tokens out of UTF-16 text, which decodes to
        // interleaved NUL characters here; text published as prose has no business
        // holding NULs, so this manufactures no match from ordinary content.
        const targets = [content, content.replaceAll("\u0000", ""), file.path];
        // Shell-normalized variants catch a token split by quoting or an expansion
        // (`--token ghp_123\456...`, `ghp_...$9...`): the shell removes both on
        // execution, and the published text reconstructs the same credential.
        // Normalization works on parsed command strings, not the raw JSON text, whose
        // escape encoding garbles the reassembly. Only command values are shell input;
        // other strings (tool names, urls, prose) can legitimately hold quote-separated
        // token-like fragments, and this block has no override.
        if (file.path === "mcp.jsonc") {
          const parsedMcp: unknown = jsonc.parse(content);
          for (const text of collectCommandStrings(parsedMcp)) {
            // Word-by-word, with real quoting rules: raw character stripping would
            // join fragments the shell keeps apart (a backslash inside single quotes
            // survives execution) and manufacture a match from a harmless command.
            const words = executedShellWords(text);
            targets.push(words.map((word) => unquoteShellWord(word)).join(" "));
            // A simple parameter expansion that is unset at runtime vanishes,
            // splicing the fragments around it into one token. Redaction localizes
            // active expansions before publication; this pass is the backstop's own
            // model of the same splice, independent of that layer.
            targets.push(words.map((word) => unquoteShellWord(word, true)).join(" "));
            // Pathname expansion can hand the process a token a deterministic glob
            // spelling hides, and the published text collapses the same way for any
            // reader.
            targets.push(words.map((word) => unquoteShellWord(word, true, true)).join(" "));
          }
          // A standard URL parse hands any reader the decoded value, so a published
          // url is scanned as what it decodes to, not just its encoded spelling. The
          // WHATWG parser deletes embedded tab and newline separators before anything
          // else, so they are removed first: `ghp_aaa\tbbb` reaches the client as the
          // contiguous token. Separator removal cannot hide a match, because no token
          // charset contains them.
          for (const url of collectUrlStrings(parsedMcp)) {
            const canonical = url.replaceAll("\t", "").replaceAll("\n", "").replaceAll("\r", "");
            targets.push(percentDecodeOnce(canonical));
          }
        }
        return targets.some(matchesCredentialToken);
      })
      .map((file) => file.path)
      .sort();
    if (leakedFiles.length > 0) throw new BackupCredentialDetectedError(leakedFiles);
  }

  if (options.reportSecrets !== true) {
    const secretFiles = scanBackupFilesForSecrets(files);
    if (secretFiles.length > 0) {
      throw new Error(`Backup contains possible secrets in: ${secretFiles.join(", ")}`);
    }
  }

  return {
    manifest: {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      exportedAt: options.exportedAt ?? new Date().toISOString(),
      muxVersion: normalizeMuxVersion(options.muxVersion),
      sourceLabel: options.sourceLabel,
      ...(mcpFile ? { mcpRedactions: mcpRedactionPaths } : {}),
      files: files.map((file) => ({
        path: file.path,
        sha256: sha256(file.content),
        ...(file.executable === true ? { executable: true } : {}),
      })),
    },
    files,
    redactions: mcpRedactionPaths.map(redactionPathLabel),
  };
}

function sameManifestContent(a: BackupManifest, b: BackupManifest): boolean {
  if (JSON.stringify(a.mcpRedactions) !== JSON.stringify(b.mcpRedactions)) return false;
  if (a.files.length !== b.files.length) return false;
  return a.files.every(
    (file, index) =>
      file.path === b.files[index]?.path &&
      file.sha256 === b.files[index]?.sha256 &&
      (file.executable === true) === (b.files[index]?.executable === true)
  );
}

/** Null when the directory is not there yet, which is the ordinary first push. */
async function resolveRootIfPresent(root: string): Promise<BackupRoot | null> {
  try {
    return await resolveRoot(root);
  } catch {
    return null;
  }
}

async function readManifestIfPresent(
  destinationDir: BackupRoot | null
): Promise<{ manifest: BackupManifest; raw: string } | null> {
  if (destinationDir === null) return null;
  try {
    await resolveContainedPath(destinationDir.path, BACKUP_MANIFEST_FILE);
    // Reading this only avoids a no-op commit, so an oversized one is ignored rather than
    // buffered: the push replaces it either way.
    const raw = (
      await readCheckedFile(destinationDir, BACKUP_MANIFEST_FILE, (size) => {
        if (size > MAX_BACKUP_FILE_BYTES) {
          throw new Error(`'${BACKUP_MANIFEST_FILE}' is larger than the reuse limit`);
        }
      })
    ).content.toString("utf-8");
    // Portable: this manifest is the one already in the repository, which every platform that
    // pulls the backup has to be able to write out.
    return { manifest: parseManifest(raw, true), raw };
  } catch {
    return null;
  }
}

function normalizeMuxVersion(value: string | undefined): string {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

/**
 * Read-time budgets bound what is buffered; this bounds what is published, which is not the
 * same set: `preferences.json` is generated after collection, and redaction rewrites content.
 * Without it a push could commit a payload that every later Preview rejects as oversized.
 */
function assertPayloadWithinLimits(files: readonly BackupFile[], manifestJson: string): void {
  // Manifest first, matching the order the reader charges them, so a payload that writes
  // cannot be one that every later read rejects.
  const budget = createByteBudget();
  budget(BACKUP_MANIFEST_FILE, Buffer.byteLength(manifestJson, "utf-8"));
  for (const file of files) budget(file.path, file.content.length);
}

export async function writeBackupPayload(
  destinationDir: string,
  payload: BackupPayload,
  options: { portable?: boolean; ownerOnly?: boolean } = {}
): Promise<void> {
  const portable = options.portable !== false;
  assertBackupPathLimits(
    payload.files.map((file) => file.path),
    { portable }
  );
  assertBackupPathLimits(
    payload.manifest.files.map((file) => file.path),
    { portable }
  );
  const ownerOnly = options.ownerOnly === true;
  const claimed = new Set<string>();
  for (const file of payload.files) {
    // A published backup is read on filesystems that fold case and normalization, so a
    // collision only a case-sensitive source can produce would make it unreadable elsewhere.
    // A local snapshot goes back to the filesystem the files were just collected from, where
    // two names that coexist are two files by definition, so folding them would refuse to
    // snapshot a perfectly valid `Foo.md` beside `foo.md` and block the restore entirely.
    const claim = portable ? collisionKey(file.path) : file.path;
    if (claimed.has(claim)) throw new Error(`Duplicate backup path '${file.path}'`);
    claimed.add(claim);
  }
  // Reuse the previous manifest when content hashes match. Otherwise changing
  // export metadata would produce a commit with no settings changes.
  const previous = await readManifestIfPresent(await resolveRootIfPresent(destinationDir));
  const reusable = previous && sameManifestContent(previous.manifest, payload.manifest);
  const manifestJson = reusable ? previous.raw : `${JSON.stringify(payload.manifest, null, 2)}\n`;
  assertPayloadWithinLimits(payload.files, manifestJson);

  await fs.rm(destinationDir, { recursive: true, force: true });
  // `ownerOnly` restores what the remove just discarded: a safety snapshot's destination
  // comes from `mkdtemp` as owner-only, and it holds an unredacted payload, so recreating
  // it with the process umask could hand other local users the literal MCP credentials.
  await fs.mkdir(destinationDir, { recursive: true, ...(ownerOnly ? { mode: 0o700 } : {}) });
  const root = await resolveRoot(destinationDir);
  for (const file of payload.files) {
    await resolveContainedPath(root.path, file.path);
    await writeCheckedFile(root, file.path, file.content, file.executable === true, {
      ownerOnly,
    });
  }
  await writeCheckedFile(root, BACKUP_MANIFEST_FILE, Buffer.from(manifestJson, "utf-8"), false, {
    ownerOnly,
  });
}

function assertBackupMcpRedactionCount(redactionCount: number): void {
  if (redactionCount > MAX_BACKUP_MCP_REDACTIONS) {
    throw new Error(`Backup has more than ${MAX_BACKUP_MCP_REDACTIONS} MCP redactions`);
  }
}

function assertBackupMcpRedactionSegments(
  pathSegmentCount: number,
  totalSegmentCount: number
): void {
  if (pathSegmentCount > MAX_BACKUP_MCP_REDACTION_PATH_SEGMENTS) {
    throw new Error(
      `Backup MCP redaction path has more than ${MAX_BACKUP_MCP_REDACTION_PATH_SEGMENTS} segments`
    );
  }
  if (totalSegmentCount > MAX_BACKUP_MCP_REDACTION_SEGMENTS) {
    throw new Error(
      `Backup MCP redaction paths have more than ${MAX_BACKUP_MCP_REDACTION_SEGMENTS} total segments`
    );
  }
}

function assertBackupMcpRedactions(
  redactions: unknown[]
): asserts redactions is BackupRedactionPath[] {
  assertBackupMcpRedactionCount(redactions.length);
  let segmentCount = 0;
  for (const jsonPath of redactions) {
    if (!Array.isArray(jsonPath) || jsonPath.length === 0) {
      throw new Error("Invalid backup manifest");
    }
    segmentCount += jsonPath.length;
    assertBackupMcpRedactionSegments(jsonPath.length, segmentCount);
    if (
      !jsonPath.every(
        (segment) =>
          typeof segment === "string" ||
          (typeof segment === "number" && Number.isInteger(segment) && segment >= 0)
      )
    ) {
      throw new Error("Invalid backup manifest");
    }
  }
}

function parseManifest(raw: string, portable: boolean): BackupManifest {
  const tree = jsonc.parseTree(raw);
  if (!tree) throw new Error("Invalid backup manifest");
  assertNoDuplicateKeys(tree, "backup manifest");
  const value: unknown = JSON.parse(raw);
  if (!isPlainObject(value)) throw new Error("Invalid backup manifest");
  const manifest: Partial<BackupManifest> = value;
  if (
    manifest.schemaVersion !== BACKUP_SCHEMA_VERSION ||
    typeof manifest.exportedAt !== "string" ||
    typeof manifest.muxVersion !== "string" ||
    typeof manifest.sourceLabel !== "string"
  ) {
    throw new Error("Invalid backup manifest");
  }
  const mcpRedactions: unknown = manifest.mcpRedactions;
  if (mcpRedactions !== undefined) {
    if (!Array.isArray(mcpRedactions)) throw new Error("Invalid backup manifest");
    assertBackupMcpRedactions(mcpRedactions);
  }
  if (!Array.isArray(manifest.files)) throw new Error("Invalid backup manifest");
  assertBackupFileCount(manifest.files.length);
  if (mcpRedactions !== undefined) {
    const paths = new Set<string>();
    for (const jsonPath of mcpRedactions) {
      const key = redactionPathKey(jsonPath);
      if (paths.has(key)) throw new Error("Invalid backup manifest: duplicate MCP redaction path");
      paths.add(key);
    }
  }
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      (file.executable !== undefined && typeof file.executable !== "boolean")
    ) {
      throw new Error("Invalid backup manifest file entry");
    }
  }
  assertBackupPathLimits(
    manifest.files.map((file) => file.path),
    { portable }
  );
  return manifest as BackupManifest;
}

/**
 * True when the bytes parse as a portable backup manifest. Managed-path selection probes
 * with this rather than mere existence: `manifest.json` is a generic filename, so an
 * unrelated or corrupt file under one spelling must not beat a valid backup under another.
 */
export function isParseableBackupManifest(raw: string): boolean {
  try {
    parseManifest(raw, true);
    return true;
  } catch {
    return false;
  }
}

export async function backupPayloadExists(sourceDir: string): Promise<boolean> {
  return await fileExists(path.join(sourceDir, BACKUP_MANIFEST_FILE));
}

export class BackupInvalidPayloadError extends Error {
  readonly code = "INVALID_BACKUP";

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "BackupInvalidPayloadError";
  }
}

/** An fs failure carries an errno string; a validation failure does not. */
function isFilesystemError(error: unknown): boolean {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}

/**
 * Wraps validation failures so the service reports repository corruption as
 * `INVALID_BACKUP` rather than the `IO_ERROR` fallback. A genuine filesystem failure keeps
 * its own error, so a local disk problem is not blamed on the repository.
 *
 * `portable: false` for a local safety snapshot, matching the `writeBackupPayload` call that
 * produced it: those keep names only this filesystem has to accept, so the cross-platform
 * rules a repository payload needs would reject the copy a recovery reads.
 */
export async function readBackupPayload(
  sourceDir: string,
  options: { portable?: boolean } = {}
): Promise<BackupPayload> {
  try {
    return await readBackupPayloadUnchecked(sourceDir, options.portable !== false);
  } catch (error) {
    if (isFilesystemError(error)) throw error;
    throw new BackupInvalidPayloadError(error);
  }
}

/**
 * An absent file here means the manifest describes content the repository does not have,
 * which is a corrupt backup rather than a local disk problem. Any other errno still belongs
 * to the local filesystem and keeps its own error.
 */
async function readManifestEntry(
  sourceDir: BackupRoot,
  relativePath: string,
  budget: ByteBudget
): Promise<Buffer> {
  try {
    await resolveContainedPath(sourceDir.path, relativePath);
    return (
      await readCheckedFile(sourceDir, relativePath, (size) => {
        budget(relativePath, size);
      })
    ).content;
  } catch (error) {
    if (isErrnoWithCode(error, "ENOENT")) {
      throw new Error(`Backup is missing '${relativePath}'`);
    }
    throw error;
  }
}

async function readBackupPayloadUnchecked(
  sourceDir: string,
  portable: boolean
): Promise<BackupPayload> {
  const budget = createByteBudget();
  const root = await resolveRoot(sourceDir);
  await resolveContainedPath(root.path, BACKUP_MANIFEST_FILE);
  // The manifest is the first thing read from a repository anyone with write access can
  // change, so it is charged to the same budget before it is parsed.
  const manifestRaw = await readCheckedFile(root, BACKUP_MANIFEST_FILE, (size) => {
    budget(BACKUP_MANIFEST_FILE, size);
  });
  const manifest = parseManifest(manifestRaw.content.toString("utf-8"), portable);
  const files: BackupFile[] = [];
  const seen = new Set<string>();
  for (const manifestFile of manifest.files) {
    const key = portable ? collisionKey(manifestFile.path) : manifestFile.path;
    if (seen.has(key)) throw new Error(`Duplicate backup path '${manifestFile.path}'`);
    seen.add(key);
    const content = await readManifestEntry(root, manifestFile.path, budget);
    if (sha256(content) !== manifestFile.sha256) {
      throw new Error(`Backup checksum mismatch for '${manifestFile.path}'`);
    }
    files.push({
      path: manifestFile.path,
      content,
      ...(manifestFile.executable === true ? { executable: true } : {}),
    });
  }
  // Parse every structured entry here so a malformed backup is rejected before restore
  // writes anything. Otherwise a later parse failure leaves a half-restored install.
  const preferencesFile = files.find((file) => file.path === "preferences.json");
  if (preferencesFile) {
    projectBackupPreferences(JSON.parse(preferencesFile.content.toString("utf-8")));
  }
  const mcpFile = files.find((file) => file.path === "mcp.jsonc");
  const parsedMcp = mcpFile
    ? parseJsoncObjectWithTree(mcpFile.content.toString("utf-8"), "backup mcp.jsonc")
    : undefined;
  if (manifest.mcpRedactions !== undefined) {
    if (!parsedMcp) throw new Error("Backup manifest lists MCP redactions without mcp.jsonc");
    validateMcpRedactionPaths(parsedMcp.tree, manifest.mcpRedactions);
    return {
      manifest,
      files,
      redactions: manifest.mcpRedactions.map(redactionPathLabel),
    };
  }
  return {
    manifest,
    files,
    redactions: parsedMcp ? findMcpRedactionPaths(parsedMcp.tree).map(redactionPathLabel) : [],
  };
}

function containsRedaction(value: string): boolean {
  return (
    value.includes(REDACTED_BACKUP_VALUE) ||
    value.includes(encodeURIComponent(REDACTED_BACKUP_VALUE))
  );
}

function isRedactedBackupValue(
  value: string,
  jsonPath: jsonc.JSONPath,
  redactedPaths: ReadonlySet<string> | undefined
): boolean {
  return redactedPaths === undefined
    ? containsRedaction(value)
    : redactedPaths.has(redactionPathKey(jsonPath));
}

/** Whole-value restoration prevents backup-controlled text from redirecting local credentials. */
function collectRedactionRestoreEdits(
  backup: unknown,
  local: unknown,
  currentPath: jsonc.JSONPath,
  edits: Array<{ path: jsonc.JSONPath; value: unknown }>,
  redactedPaths: ReadonlySet<string> | undefined,
  resolvedServers: ReadonlySet<string> = new Set()
): void {
  // Only the paths handled by command or header resolution are skipped, so a mixed entry
  // can still rehydrate its other redacted values. A dropped entry is skipped wholesale,
  // since a nested edit would resurrect what it removed.
  if (resolvedServers.has(redactionPathKey(currentPath))) return;
  if (typeof backup === "string" && isRedactedBackupValue(backup, currentPath, redactedPaths)) {
    if (local !== undefined) edits.push({ path: currentPath, value: local });
    return;
  }
  if (Array.isArray(backup)) {
    const localArray = Array.isArray(local) ? local : [];
    backup.forEach((value, index) =>
      collectRedactionRestoreEdits(
        value,
        localArray[index],
        [...currentPath, index],
        edits,
        redactedPaths,
        resolvedServers
      )
    );
    return;
  }
  const backupRecord = readRecord(backup);
  if (!backupRecord) return;
  const localRecord = readRecord(local) ?? {};
  for (const [key, value] of Object.entries(backupRecord)) {
    collectRedactionRestoreEdits(
      value,
      readOwn(localRecord, key),
      [...currentPath, key],
      edits,
      redactedPaths,
      resolvedServers
    );
  }
}

/** Shared by preview and restore so the preview cannot promise a different result. */
export async function resolveRestoredContent(
  muxRoot: string,
  file: BackupFile,
  mcpRedactions?: readonly BackupRedactionPath[]
): Promise<Buffer> {
  return file.path === "mcp.jsonc"
    ? await restoreMcpFile(muxRoot, file.content, mcpRedactions)
    : file.content;
}

/**
 * Local MCP state is optional. The pre-check avoids opening special files, while the nonblocking
 * checked read makes a replacement race fail instead of hanging restore.
 */
async function readLocalMcpText(muxRoot: string): Promise<string | null> {
  try {
    const root = await resolveRoot(muxRoot);
    if (!(await isRegularFile(absolutePathOf(root.path, "mcp.jsonc")))) return null;
    const budget = createByteBudget();
    const { content } = await readCheckedFile(root, "mcp.jsonc", (size) =>
      budget("mcp.jsonc", size)
    );
    return content.toString("utf-8");
  } catch {
    return null;
  }
}

interface ServerCommand {
  command: string;
  enabled: boolean;
  /** False when `normalizeEntry` gives a non-empty URL precedence over this command. */
  runnable: boolean;
}

/**
 * Mirrors `McpConfigService.normalizeEntry`: a stdio server is either a bare command
 * string or an object carrying `command`. An empty command cannot run anything, so it is
 * not tracked. A disabled entry IS tracked, because `MCPServerManager.applyServerOverrides`
 * lets a workspace `enabledServers` override start a project-disabled server.
 */
function readServerCommand(value: unknown): ServerCommand | undefined {
  const raw = typeof value === "string" ? value : undefined;
  if (raw !== undefined) {
    if (raw.trim() === "") return undefined;
    return { command: raw, enabled: true, runnable: true };
  }
  const record = readRecord(value);
  if (!record) return undefined;
  const command = record.command;
  if (typeof command !== "string" || command.trim() === "") return undefined;
  const url = record.url;
  return {
    command,
    enabled: record.disabled !== true,
    runnable: !(typeof url === "string" && url !== ""),
  };
}

/**
 * Only for the local file, where a malformed config holds no recoverable commands and
 * every incoming one is therefore new. The backup's own copy must never be read this way:
 * treating an unparseable payload as "no commands" would let it skip the approval gate.
 */
function readLocalServerCommands(content: string): Map<string, ServerCommand> {
  try {
    return readServerCommands(content);
  } catch {
    return new Map();
  }
}

function readServerCommands(content: string): Map<string, ServerCommand> {
  const commands = new Map<string, ServerCommand>();
  const servers = parseJsoncObject(content, "mcp.jsonc").servers;
  if (isUnsupportedServerMap(servers)) {
    throw new BackupInvalidPayloadError(
      new Error(
        "Cannot restore: the backup's mcp.jsonc lists servers as something other than an object"
      )
    );
  }
  const serverRecord = readRecord(servers);
  if (!serverRecord) return commands;
  for (const [name, server] of Object.entries(serverRecord)) {
    const entry = readServerCommand(server);
    if (entry !== undefined) commands.set(name, entry);
  }
  return commands;
}

/** Binds an approval to the exact command text the user read. */
export function backupCommandApprovalToken(serverPath: string, command: string): string {
  // JSON, not delimiter-joined: both components come from JSONC strings, whose escapes can
  // produce any character including NUL, so no delimiter makes concatenation unambiguous
  // and a crafted pair could collide with a different command's token.
  return sha256(Buffer.from(JSON.stringify([serverPath, command]), "utf-8"));
}

/**
 * MCP commands a restore would make runnable, or newly runnable. Those strings reach
 * `runtime.exec()` when the server next starts, so a repository the user does not fully
 * control must not be able to change them without the user reading the exact text first.
 * A command is exempt only when the local config already holds identical text and the
 * restore does not enable it, which covers both an unchanged command and one whose whole
 * scalar the redaction rehydration kept locally authoritative.
 */
export async function collectMcpCommandApprovals(
  muxRoot: string,
  files: readonly BackupFile[],
  mcpRedactions?: readonly BackupRedactionPath[]
): Promise<BackupCommandApproval[]> {
  const file = files.find((candidate) => candidate.path === "mcp.jsonc");
  if (!file) return [];

  const restored = await resolveRestoredContent(muxRoot, file, mcpRedactions);
  const incoming = readServerCommands(restored.toString("utf-8"));
  const localText = await readLocalMcpText(muxRoot);
  const local =
    localText === null ? new Map<string, ServerCommand>() : readLocalServerCommands(localText);

  const approvals: BackupCommandApproval[] = [];
  for (const [name, entry] of incoming) {
    if (!entry.runnable) continue;
    const current = local.get(name);
    // A workspace can enable a disabled command, so removing its URL shadow still needs approval.
    const makesItRun = current?.runnable === false || (entry.enabled && current?.enabled === false);
    if (current?.command === entry.command && !makesItRun) continue;
    const serverPath = `servers.${name}.command`;
    approvals.push({
      path: serverPath,
      command: entry.command,
      token: backupCommandApprovalToken(serverPath, entry.command),
    });
  }
  return approvals;
}

export function assertBackupCommandsApproved(
  approvals: readonly BackupCommandApproval[],
  approvedTokens: readonly string[] | null | undefined
): void {
  const approved = new Set(approvedTokens ?? []);
  const unapproved = approvals.filter((approval) => !approved.has(approval.token));
  // The full list, not just the unapproved rest: the UI resends tokens only for the
  // commands it displays, so an error carrying a subset would drop the already-approved
  // tokens from the retry and turn them back into the next round's unapproved rest.
  if (unapproved.length > 0) throw new BackupCommandApprovalRequiredError(approvals);
}

async function restoreMcpFile(
  muxRoot: string,
  content: Buffer,
  mcpRedactions?: readonly BackupRedactionPath[]
): Promise<Buffer> {
  const redactedPaths =
    mcpRedactions === undefined ? undefined : new Set(mcpRedactions.map(redactionPathKey));
  const backupText = content.toString("utf-8");
  // Deliberately not gated on a marker being present: `resolveRestoredHeaders` has to inspect
  // a marker-free backup too, since a bare `{secret: NAME}` header carries no marker yet
  // still resolves against local data.
  const { parsed: backup, tree: backupTree } = parseJsoncObjectWithTree(
    backupText,
    "backup mcp.jsonc"
  );
  if (mcpRedactions !== undefined) validateMcpRedactionPaths(backupTree, mcpRedactions);
  const localText = await readLocalMcpText(muxRoot);
  let local: Record<string, unknown> = {};
  let localTree: jsonc.Node | undefined;
  if (localText !== null) {
    try {
      const parsedLocal = parseJsoncObjectWithTree(localText, "local mcp.jsonc");
      local = parsedLocal.parsed;
      localTree = parsedLocal.tree;
    } catch {
      // A corrupt local file holds no recoverable values, and it must not block the
      // restore that would replace it.
      local = {};
    }
  }
  const edits: Array<{ path: jsonc.JSONPath; value: unknown }> = [];
  const localServerMerge =
    localTree && localText
      ? preserveLocalOnlyMcpServers(backupTree, localTree, localText)
      : ({ kind: "none" } satisfies LocalMcpServerMerge);
  const resolved = resolveRestoredCommands(backup, local, edits, redactedPaths);
  for (const path of resolveRestoredUrls(backup, local, edits, resolved, redactedPaths)) {
    resolved.add(path);
  }
  for (const path of resolveRestoredHeaders(
    backup,
    local,
    backupTree,
    edits,
    resolved,
    redactedPaths
  )) {
    resolved.add(path);
  }
  collectRedactionRestoreEdits(backup, local, [], edits, redactedPaths, resolved);
  let restoredText = applyJsoncEdits(backupText, edits);
  if (localServerMerge.kind === "replace") {
    restoredText = replaceJsoncNodeText(restoredText, ["servers"], localServerMerge.valueText);
  } else if (localServerMerge.kind === "insert") {
    restoredText = insertJsoncObjectProperties(
      restoredText,
      localServerMerge.objectPath,
      localServerMerge.entries,
      localServerMerge.objectTrailingText
    );
  }
  parseJsoncObjectWithTree(restoredText, "restored mcp.jsonc");
  return Buffer.from(restoredText, "utf-8");
}

function leadingJsoncTriviaText(
  text: string,
  objectNode: jsonc.Node,
  property: jsonc.Node,
  previousProperty: jsonc.Node | undefined
): string {
  const start = previousProperty
    ? previousProperty.offset + previousProperty.length
    : objectNode.offset + 1;
  const trivia = text.slice(start, property.offset);
  if (!previousProperty) return trivia;
  const lineBreak = trivia.search(/\r?\n/);
  return lineBreak < 0 ? "" : trivia.slice(lineBreak);
}

function trailingJsoncCommentText(
  text: string,
  objectNode: jsonc.Node,
  property: jsonc.Node,
  nextProperty: jsonc.Node | undefined
): string {
  const end = nextProperty?.offset ?? objectNode.offset + objectNode.length - 1;
  const trivia = text.slice(property.offset + property.length, end);
  const scanner = jsonc.createScanner(trivia, false);
  for (let token = scanner.scan(); token !== jsonc.SyntaxKind.EOF; token = scanner.scan()) {
    if (token === jsonc.SyntaxKind.Trivia || token === jsonc.SyntaxKind.CommaToken) continue;
    if (token === jsonc.SyntaxKind.LineBreakTrivia) return "";
    if (
      token === jsonc.SyntaxKind.LineCommentTrivia ||
      token === jsonc.SyntaxKind.BlockCommentTrivia
    ) {
      return trivia.slice(
        scanner.getTokenOffset(),
        scanner.getTokenOffset() + scanner.getTokenLength()
      );
    }
    return "";
  }
  return "";
}

function objectTrailingJsoncText(text: string, objectNode: jsonc.Node): string {
  const properties = objectNode.children ?? [];
  const lastProperty = properties.at(-1);
  if (!lastProperty) return "";
  const start = lastProperty.offset + lastProperty.length;
  const end = objectNode.offset + objectNode.length - 1;
  const trivia = text.slice(start, end);
  const lineBreak = trivia.search(/\r?\n/);
  if (lineBreak < 0) return "";
  return trivia.slice(lineBreak).replace(/\r?\n[\t ]*$/, "");
}

function jsoncPropertyInsertion(
  text: string,
  objectNode: jsonc.Node,
  propertyIndex: number
): JsoncPropertyInsertion {
  const properties = objectNode.children ?? [];
  const property = properties[propertyIndex];
  if (!property) throw new Error("Invalid JSONC property index");
  return {
    leadingText: leadingJsoncTriviaText(text, objectNode, property, properties[propertyIndex - 1]),
    propertyText: text.slice(property.offset, property.offset + property.length),
    trailingCommentText: trailingJsoncCommentText(
      text,
      objectNode,
      property,
      properties[propertyIndex + 1]
    ),
  };
}

/** Restore is not a mirror, so it keeps server definitions present only on this device. */
function preserveLocalOnlyMcpServers(
  backupTree: jsonc.Node,
  localTree: jsonc.Node,
  localText: string
): LocalMcpServerMerge {
  const backupServersNode = jsonc.findNodeAtLocation(backupTree, ["servers"]);
  const localServersNode = jsonc.findNodeAtLocation(localTree, ["servers"]);
  if (localServersNode?.type !== "object") return { kind: "none" };

  const localServersText = localText.slice(
    localServersNode.offset,
    localServersNode.offset + localServersNode.length
  );
  if (backupServersNode === undefined) {
    const property = localServersNode.parent;
    const properties = localTree.children ?? [];
    const index = property ? properties.indexOf(property) : -1;
    if (property?.type !== "property" || index < 0) return { kind: "none" };
    return {
      kind: "insert",
      objectPath: [],
      entries: [jsoncPropertyInsertion(localText, localTree, index)],
      objectTrailingText:
        index === properties.length - 1 ? objectTrailingJsoncText(localText, localTree) : "",
    };
  }
  if (backupServersNode.type !== "object") {
    return jsonc.getNodeValue(backupServersNode)
      ? { kind: "none" }
      : { kind: "replace", valueText: localServersText };
  }

  const backupNames = new Set(objectKeyNames(backupTree, ["servers"]));
  const localProperties = localServersNode.children ?? [];
  const entries = localProperties.flatMap((property, index) => {
    const key: unknown = property.children?.[0]?.value;
    return typeof key === "string" && !backupNames.has(key)
      ? [jsoncPropertyInsertion(localText, localServersNode, index)]
      : [];
  });
  if (entries.length === 0) return { kind: "none" };
  const lastLocalProperty = localProperties.at(-1);
  const lastLocalKey: unknown = lastLocalProperty?.children?.[0]?.value;
  return {
    kind: "insert",
    objectPath: ["servers"],
    entries,
    objectTrailingText:
      typeof lastLocalKey === "string" && !backupNames.has(lastLocalKey)
        ? objectTrailingJsoncText(localText, localServersNode)
        : "",
  };
}

/** Tracks handled paths so the generic pass cannot resurrect removed commands. */
function resolveRestoredCommands(
  backup: Record<string, unknown>,
  local: Record<string, unknown>,
  edits: Array<{ path: jsonc.JSONPath; value: unknown }>,
  redactedPaths: ReadonlySet<string> | undefined
): Set<string> {
  const handled = new Set<string>();
  const servers = readRecord(backup.servers);
  if (!servers) return handled;
  const localServers = readRecord(local.servers) ?? {};

  for (const [name, entry] of Object.entries(servers)) {
    const barePath: jsonc.JSONPath = ["servers", name];
    const objectPath: jsonc.JSONPath = ["servers", name, "command"];
    const isBareMarker =
      typeof entry === "string" && isRedactedBackupValue(entry, barePath, redactedPaths);
    const objectCommand = readRecord(entry)?.command;
    const isObjectMarker =
      !isBareMarker &&
      typeof objectCommand === "string" &&
      isRedactedBackupValue(objectCommand, objectPath, redactedPaths);
    if (!isBareMarker && !isObjectMarker) continue;

    const localEntry = readOwn(localServers, name);
    const localCommand = readAnyServerCommand(localEntry);
    if (localCommand === undefined) {
      // `normalizeEntry` gives a non-empty resolved URL precedence over the command. Keep that
      // HTTP entry after removing the marker; otherwise remove the server so it cannot execute.
      const url = isObjectMarker
        ? restoredServerUrl(entry, readRecord(localEntry), name, redactedPaths)
        : undefined;
      const hasUrl = url !== undefined && url !== "" && !containsRedaction(url);
      const removed: jsonc.JSONPath = hasUrl ? ["servers", name, "command"] : ["servers", name];
      edits.push({ path: removed, value: undefined });
      handled.add(redactionPathKey(removed));
      continue;
    }
    const commandPath = isBareMarker ? barePath : objectPath;
    edits.push({ path: commandPath, value: localCommand });
    handled.add(redactionPathKey(commandPath));
  }
  return handled;
}

/**
 * Mirrors the command resolution for `url`: a marker is only ever replaced by the local
 * value at the same path. Without one the marker must not survive as the endpoint the
 * entry connects to, so the url is dropped when the entry still has a usable command
 * (`collectMcpCommandApprovals` gates any command that removal makes runnable) and the
 * whole server is removed otherwise.
 */
function resolveRestoredUrls(
  backup: Record<string, unknown>,
  local: Record<string, unknown>,
  edits: Array<{ path: jsonc.JSONPath; value: unknown }>,
  resolvedServers: ReadonlySet<string>,
  redactedPaths: ReadonlySet<string> | undefined
): Set<string> {
  const handled = new Set<string>();
  const servers = readRecord(backup.servers);
  if (!servers) return handled;
  const localServers = readRecord(local.servers) ?? {};

  for (const [name, entry] of Object.entries(servers)) {
    // An entry the command resolution removed has no url left to decide about.
    if (resolvedServers.has(redactionPathKey(["servers", name]))) continue;
    const record = readRecord(entry);
    const url = record?.url;
    const urlPath: jsonc.JSONPath = ["servers", name, "url"];
    if (typeof url !== "string" || !isRedactedBackupValue(url, urlPath, redactedPaths)) continue;

    const localUrl = readUrl(readRecord(readOwn(localServers, name)));
    if (localUrl !== undefined) {
      edits.push({ path: urlPath, value: localUrl });
      handled.add(redactionPathKey(urlPath));
      continue;
    }
    const commandPath: jsonc.JSONPath = ["servers", name, "command"];
    const command = record?.command;
    // Either the command resolution already put the local command back at this path, or the
    // backup carries a plain command of its own. A marker command never reaches the second
    // arm: without a local command the command resolution removed the server above.
    const hasCommand =
      resolvedServers.has(redactionPathKey(commandPath)) ||
      (typeof command === "string" &&
        command.trim() !== "" &&
        !isRedactedBackupValue(command, commandPath, redactedPaths));
    const removed: jsonc.JSONPath = hasCommand ? urlPath : ["servers", name];
    edits.push({ path: removed, value: undefined });
    handled.add(redactionPathKey(removed));
  }
  return handled;
}

/**
 * A restored header value is only ever the local value at that exact path, or nothing.
 *
 * `MCPServerManager.resolveHeaders` resolves both a literal header and a `{secret: NAME}`
 * reference against local data, then sends the result to whatever `url` the entry carries.
 * Deciding per value shape which ones are safe to carry over from a backup does not work:
 * a marker, a marker standing in for the whole `headers` object, a bare reference in a
 * marker-free file, and a reference the backup adds next to a url it chose are all the same
 * defect. So nothing the backup writes under `headers` survives unless the local file
 * already holds it at the same path, which makes the shape irrelevant.
 *
 * A local value is only put back when the restored entry still points at the endpoint the
 * local config already sends that header to. Otherwise the header is dropped, leaving an
 * entry that cannot authenticate rather than one that authenticates somewhere the user never
 * approved. Only header names the backup itself lists are considered, so a restore never
 * introduces a local header the backup did not have.
 *
 * Returns the paths handled here so the generic redaction walk leaves them alone.
 */
function resolveRestoredHeaders(
  backup: Record<string, unknown>,
  local: Record<string, unknown>,
  backupTree: jsonc.Node,
  edits: Array<{ path: jsonc.JSONPath; value: unknown }>,
  resolvedServers: ReadonlySet<string>,
  redactedPaths: ReadonlySet<string> | undefined
): Set<string> {
  const handled = new Set<string>();
  const servers = readRecord(backup.servers);
  if (!servers) return handled;
  const localServers = readRecord(local.servers) ?? {};

  for (const [name, entry] of Object.entries(servers)) {
    // An entry command resolution already removed has no headers left to decide about, and
    // `jsonc.modify` cannot address a path whose parent this edit list deletes.
    if (resolvedServers.has(redactionPathKey(["servers", name]))) continue;
    const rawHeaders = readRecord(entry)?.headers;
    if (rawHeaders === undefined) continue;
    const localServer = readRecord(readOwn(localServers, name));
    const headersPath: jsonc.JSONPath = ["servers", name, "headers"];
    // The whole subtree is withheld from the generic walk, so no header can be rehydrated
    // by a path this function did not decide on.
    handled.add(redactionPathKey(headersPath));

    const headers = readRecord(rawHeaders);
    const endpointMatches =
      restoredServerUrl(entry, localServer, name, redactedPaths) === readUrl(localServer);
    if (!headers || !endpointMatches) {
      edits.push({ path: headersPath, value: undefined });
      continue;
    }

    const localHeaders = readRecord(localServer?.headers) ?? {};
    // Names come from the document, not the parsed object, because `jsonc.parse` drops a
    // `__proto__` key while the text keeps it. Enumerating the parse result would leave that
    // header, and its marker, untouched in the restored file.
    const names = objectKeyNames(backupTree, ["servers", name, "headers"]);
    const restored: Record<string, unknown> = {};
    for (const headerName of names) {
      if (!Object.hasOwn(localHeaders, headerName)) continue;
      restored[headerName] = localHeaders[headerName];
    }

    if (names.length !== Object.keys(restored).length) {
      // Something has to go: a header with no local counterpart, a duplicate key, or a name
      // the parser hides. Replacing the whole value is the only edit that reliably removes
      // it, since `jsonc.modify` cannot address a key it cannot see.
      edits.push({ path: headersPath, value: restored });
      continue;
    }
    for (const [headerName, value] of Object.entries(restored)) {
      // Skipping an already-identical value keeps `jsonc.modify` from reformatting a header
      // the restore would not have changed.
      if (JSON.stringify(readOwn(headers, headerName)) === JSON.stringify(value)) continue;
      edits.push({ path: [...headersPath, headerName], value });
    }
  }
  return handled;
}

/**
 * Own key names as the document spells them. `jsonc.parse` drops a `__proto__` key while the
 * text keeps it, so a walk over the parse result cannot see, or edit, every key present.
 */
function objectKeyNames(tree: jsonc.Node | undefined, jsonPath: jsonc.JSONPath): string[] {
  if (!tree) return [];
  const node = jsonPath.length === 0 ? tree : jsonc.findNodeAtLocation(tree, jsonPath);
  if (node?.type !== "object") return [];
  return (node.children ?? []).flatMap((property) => {
    const key: unknown = property.children?.[0]?.value;
    return typeof key === "string" ? [key] : [];
  });
}

/**
 * Header and server names come from the backup, so a name like `constructor` would otherwise
 * read an `Object.prototype` member and hand a function to `jsonc.modify`.
 */
function readOwn(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** The url the restored entry ends up with, since a redacted url is itself put back from local. */
function restoredServerUrl(
  backupEntry: unknown,
  localServer: Record<string, unknown> | undefined,
  serverName: string,
  redactedPaths: ReadonlySet<string> | undefined
): string | undefined {
  const backupUrl = readUrl(readRecord(backupEntry));
  const localUrl = readUrl(localServer);
  if (
    backupUrl !== undefined &&
    isRedactedBackupValue(backupUrl, ["servers", serverName, "url"], redactedPaths) &&
    localUrl !== undefined
  ) {
    return localUrl;
  }
  return backupUrl;
}

function readUrl(server: Record<string, unknown> | undefined): string | undefined {
  const url = server?.url;
  return typeof url === "string" ? url : undefined;
}

/** Every command string a shell would execute, for shell-normalized credential scans. */
function collectCommandStrings(root: unknown): string[] {
  const servers = readRecord(readRecord(root)?.servers);
  if (!servers) return [];
  const commands: string[] = [];
  for (const value of Object.values(servers)) {
    const command = typeof value === "string" ? value : readRecord(value)?.command;
    if (typeof command === "string") commands.push(command);
  }
  return commands;
}

function collectUrlStrings(root: unknown): string[] {
  const servers = readRecord(readRecord(root)?.servers);
  if (!servers) return [];
  const urls: string[] = [];
  for (const value of Object.values(servers)) {
    const url = readRecord(value)?.url;
    if (typeof url === "string") urls.push(url);
  }
  return urls;
}

/**
 * One decoding pass, never a loop: a double-encoded `%2561` reaches a client as the
 * literal `%61` a single standard parse yields, and repeated decoding would manufacture
 * blocks from spellings no consumer resolves to the credential.
 */
function percentDecodeOnce(text: string): string {
  return text.replace(/%([0-9a-fA-F]{2})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
}

/**
 * Structural, never `isPlainObject`: `jsonc.parse` assigns a `__proto__` key through the
 * prototype, so a polluted entry has a non-standard prototype but must stay visible here,
 * or its sibling keys (an executable `command`, a redacted header) escape scanning.
 */
function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readAnyServerCommand(value: unknown): string | undefined {
  const command = typeof value === "string" ? value : readRecord(value)?.command;
  return typeof command === "string" && command.trim() !== "" ? command : undefined;
}

interface RestorePlan {
  /** Resolved by the plan and reused for the writes, so the two cannot disagree on the tree. */
  root: BackupRoot;
  writes: Array<{ path: string; content: Buffer; executable: boolean }>;
  backupPreferences: unknown;
}

async function assertDirectoryAccepts(directory: string, relativePath: string): Promise<void> {
  try {
    await fs.access(directory, fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    throw new Error(`Cannot restore '${relativePath}': the destination is not writable`);
  }
}

/**
 * The write opens an existing destination `O_WRONLY` and otherwise creates it along with any
 * missing parent, so a readable-but-unwritable destination fails there instead of here, once
 * earlier entries of the same restore are already on disk. Probing the permission the write will
 * need keeps that refusal in the preflight, where nothing has changed yet.
 */
async function assertRestoreDestinationWritable(
  destination: string,
  existing: Stats | null,
  relativePath: string
): Promise<void> {
  let probe = destination;
  let mode = fs.constants.W_OK;
  if (existing !== null && existing.nlink > 1) {
    // A multi-link destination is severed by unlinking it, which the directory holding the name
    // has to permit, not the file itself.
    const directory = path.dirname(destination);
    await assertDirectoryAccepts(directory, relativePath);
    const dirStat = await fs.stat(directory);
    const uid = process.getuid?.();
    // Sticky directories let only root, the file owner, or the directory owner unlink an entry.
    if (
      (dirStat.mode & 0o1000) !== 0 &&
      uid !== undefined &&
      uid !== 0 &&
      existing.uid !== uid &&
      dirStat.uid !== uid
    ) {
      throw new Error(`Cannot restore '${relativePath}': the destination cannot be replaced`);
    }
  }
  if (existing === null) {
    // The write's mkdir is recursive, so the directory that has to accept the new entry is the
    // nearest one that already exists, which is not always the immediate parent.
    mode |= fs.constants.X_OK;
    probe = path.dirname(destination);
    while ((await lstatOrNull(probe)) === null) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  try {
    await fs.access(probe, mode);
  } catch {
    throw new Error(`Cannot restore '${relativePath}': the destination is not writable`);
  }
}

/**
 * Everything a restore can reject before it writes anything, so a path or a limit that
 * refuses the payload cannot leave a half-restored install behind. `BackupService.restore`
 * runs this ahead of the safety snapshot too: a refused restore changes nothing, so it must
 * not leave an unredacted copy of the local settings behind either.
 */
export async function planRestoreWrites(
  muxRoot: string,
  payload: BackupPayload
): Promise<RestorePlan> {
  assertBackupPathLimits(payload.files.map((file) => file.path));
  const root = await resolveRoot(muxRoot);
  let backupPreferences: unknown;
  const writes: RestorePlan["writes"] = [];
  const claimed = new Set<string>();
  // Restoring rehydrates local values into repository-controlled text, so what gets written is
  // not what was read and bounded. A payload made of markers is small however many large local
  // values it asks for, so the result is charged to the same budget as any other backup byte.
  const budget = createByteBudget();
  for (const file of payload.files) {
    if (file.path === "preferences.json") {
      // Projected here so a document the merge would reject cannot reach the write loop, but
      // kept unmerged: the merge belongs to the config edit, against the config as it is when
      // that edit runs rather than as it was before the restore.
      const parsed: unknown = JSON.parse(file.content.toString("utf-8"));
      projectBackupPreferences(parsed);
      backupPreferences = parsed;
      continue;
    }
    const destination = await resolveContainedPath(root.path, file.path);
    const existing = await lstatOrNull(destination);
    if (existing?.isDirectory() === true) {
      throw new Error(`Cannot restore '${file.path}': a directory already exists there`);
    }
    if (existing !== null && !existing.isFile()) {
      throw new Error(`Cannot restore '${file.path}': a non-regular file already exists there`);
    }
    await assertRestoreDestinationWritable(destination, existing, file.path);
    if (existing !== null && existing.nlink <= 1) {
      const { base, next } = restoredPermissions(
        existing.mode,
        file.executable === true,
        isOwnerOnlyPayloadPath(file.path)
      );
      if (next !== base) {
        const uid = process.getuid?.();
        if (uid !== undefined && uid !== 0 && existing.uid !== uid) {
          throw new Error(
            `Cannot restore '${file.path}': the destination's permissions cannot be changed`
          );
        }
      }
    }
    // Folding the path catches the pair a case-insensitive or normalizing volume would merge,
    // which no filesystem here can be asked about because neither name exists yet: both entries
    // would write the same bytes and the last would decide what both names hold.
    //
    // Destinations that are already one file (hard links) are not refused. Collection publishes
    // every such name deliberately, so refusing here made a push this same install could not
    // then preview or restore. `openSeveredWriteHandle` unlinks a destination whose `nlink`
    // exceeds one and recreates it, so each entry ends up at its own inode holding exactly what
    // the backup recorded, which is the same outcome the refusal was protecting.
    const claim = collisionKey(destination);
    if (claimed.has(claim)) {
      throw new Error(`Cannot restore '${file.path}': another entry resolves to the same file`);
    }
    claimed.add(claim);
    const content = await resolveRestoredContent(root.path, file, payload.manifest.mcpRedactions);
    budget(file.path, content.byteLength);
    writes.push({ path: file.path, content, executable: file.executable === true });
  }
  return { root, writes, backupPreferences };
}

export async function restoreBackupPayload(
  options: RestoreBackupPayloadOptions
): Promise<RestoreBackupPayloadResult> {
  const localPaths = new Set(
    (await collectAllowlistedFiles(options.muxRoot)).map((file) => file.path)
  );
  const restoredPaths = new Set(
    options.payload.files
      .filter((file) => file.path !== "preferences.json")
      .map((file) => file.path)
  );
  // Recomputed here rather than trusted from the preview, so an approval cannot authorize
  // a command the repository changed between the preview and this restore.
  assertBackupCommandsApproved(
    await collectMcpCommandApprovals(
      options.muxRoot,
      options.payload.files,
      options.payload.manifest.mcpRedactions
    ),
    options.approvedCommandTokens
  );

  const plan = await planRestoreWrites(options.muxRoot, options.payload);
  // Classify against the pre-restore filesystem state before writes change file identities.
  const { localOnly } = await localOnlyPayloadFiles(options.muxRoot, localPaths, restoredPaths);

  for (const write of plan.writes) {
    await writeCheckedFile(plan.root, write.path, write.content, write.executable, {
      ownerOnly: isOwnerOnlyPayloadPath(write.path),
    });
  }

  return { backupPreferences: plan.backupPreferences, localOnlyFiles: localOnly };
}
