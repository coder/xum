import { randomBytes } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import {
  ArtifactKindSchema,
  ArtifactShelfScopeSchema,
  type ArtifactShelfEntry,
  type ArtifactShelfScope,
} from "@/common/orpc/schemas/artifacts";
import { assert } from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { projectMemoryDirName } from "@/node/services/memoryService";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import writeFileAtomic from "@/node/utils/writeFileAtomic";
import { parseArtifactRelativePath } from "./artifactStore";

/**
 * Cross-workspace artifact shelf (Artifacts M5c): pinned artifact versions shared by every
 * workspace of a project (project shelf) or by every workspace (global shelf).
 *
 * Layout, host-local like memory (so SSH and Docker workspaces share it with no extra work):
 *   <xumRoot>/artifacts/global/<entry>/{meta.json, <file>}
 *   <xumRoot>/artifacts/project/<projectMemoryDirName>/<entry>/{meta.json, <file>}
 *
 * Deliberately NOT under /memories: memory files feed the memory index, the hot set, intuition
 * recall and the consolidation agent, which may rewrite or delete them. An entry is a byte copy of
 * one published version, so the shelf never changes under a reader; pinning the same artifact
 * path from the same workspace again replaces its entry (see chooseShelfEntryName). Agents write the shelf only through the
 * `artifact` tool's pin; everything else is read-only for them.
 */

export const ARTIFACT_SHELF_DIR_NAME = "artifacts";
const META_FILE_NAME = "meta.json";

/** Same cap as attach_file and artifact reads: anything the agent can attach can be pinned. */
export const MAX_SHELF_FILE_BYTES = 10 * 1024 * 1024;

export const PROJECT_SHELF_MULTI_PROJECT_ERROR =
  "Multi-project workspaces have no project shelf; pin to the global shelf instead.";

/** Longest title a pin stores; longer labels are clamped (see clampShelfTitle). */
export const MAX_SHELF_TITLE_LENGTH = 1024;

/**
 * Bounded like every other field that a settings-backup restore can bring in from a repository:
 * meta.json is re-sent on every shelf listing, so an oversized one is skipped, not served.
 */
const ShelfMetaSchema = z.object({
  // Legacy workspace ids are `<project>-<workspace>` basenames, so leave room for two names.
  sourceWorkspaceId: z.string().max(1024),
  /** POSIX path relative to the source workspace's artifacts dir. */
  sourcePath: z.string().max(4096),
  version: z.number().int().positive(),
  title: z.string().max(MAX_SHELF_TITLE_LENGTH),
  kind: ArtifactKindSchema,
  pinnedAtMs: z.number(),
  pinnedBy: z.enum(["agent", "user"]),
  /** Name of the content file inside the entry dir (the source file's basename). */
  file: z.string().max(255),
});
export type ShelfMeta = z.infer<typeof ShelfMetaSchema>;

const scopeLocks = new MutexMap<string>();

/**
 * Run `fn` holding the scope's lock, the one pins, unpins and restores take. Backup collection
 * and restore use it so they never see (or overwrite) an entry halfway through a swap.
 */
export function withShelfScopeLock<T>(scopeDir: string, fn: () => Promise<T>): Promise<T> {
  return scopeLocks.withLock(scopeDir, fn);
}

/** meta.json, compared case-insensitively: on macOS and Windows `META.JSON` is the same file. */
function isMetaFileName(name: string): boolean {
  return name.toLowerCase() === META_FILE_NAME;
}

function clampShelfTitle(title: string): string {
  if (title.length <= MAX_SHELF_TITLE_LENGTH) return title;
  let clamped = title.slice(0, MAX_SHELF_TITLE_LENGTH - 1);
  // Never end on half a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(clamped)) clamped = clamped.slice(0, -1);
  return `${clamped}…`;
}

export function getArtifactShelfRoot(xumRoot: string): string {
  return path.join(xumRoot, ARTIFACT_SHELF_DIR_NAME);
}

/**
 * Directory of one shelf scope. `projectIdentity` is resolveMemoryProjectIdentity's value:
 * "" (multi-project workspace) has no project shelf.
 */
export function getShelfScopeDir(
  shelfRoot: string,
  scope: ArtifactShelfScope,
  projectIdentity: string
): string | { error: string } {
  if (scope === "global") return path.join(shelfRoot, "global");
  if (projectIdentity === "") return { error: PROJECT_SHELF_MULTI_PROJECT_ERROR };
  return path.join(shelfRoot, "project", projectMemoryDirName(projectIdentity));
}

/**
 * Entry directory name for an artifacts-relative path: segments joined with "__" so nested
 * artifacts stay one flat, readable entry. Re-pinning the same path lands on the same name.
 */
export function shelfEntryName(relPath: string): string {
  const segments = parseArtifactRelativePath(relPath);
  assert(typeof segments !== "string", `invalid artifact path: ${relPath}`);
  return segments.join("__");
}

/** Entry names come back from the UI and tools: one plain, visible path segment only. */
export function isValidShelfEntryName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    !name.startsWith(".")
  );
}

/** Refuse a scope dir or entry that is a symlink (or resolves outside the shelf root). */
async function assertRealDirWithin(root: string, target: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(target);
    if (!stat.isDirectory()) return false;
    const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
    const rel = path.relative(realRoot, realTarget);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

export interface PinToShelfParams {
  shelfRoot: string;
  scopeDir: string;
  relPath: string;
  bytes: Buffer;
  meta: Omit<ShelfMeta, "file" | "sourcePath">;
}

/**
 * Copy one version into the shelf. It replaces only its own earlier pin (see
 * chooseShelfEntryName); any other entry keeps its bytes.
 */
export async function pinToShelf(
  params: PinToShelfParams
): Promise<{ success: true; name: string } | { success: false; error: string }> {
  if (params.bytes.length > MAX_SHELF_FILE_BYTES) {
    return {
      success: false,
      error: `Artifact is ${params.bytes.length} bytes; shelf files are capped at ${MAX_SHELF_FILE_BYTES} bytes`,
    };
  }
  const file = path.posix.basename(params.relPath);
  // The entry dir holds the content file next to meta.json: a content file with that name would
  // be overwritten by the metadata and the entry would be unreadable.
  if (isMetaFileName(file)) {
    return {
      success: false,
      error: `An artifact named ${META_FILE_NAME} cannot be pinned; rename the artifact before pinning`,
    };
  }
  const meta: ShelfMeta = {
    ...params.meta,
    title: clampShelfTitle(params.meta.title),
    sourcePath: params.relPath,
    file,
  };
  // Write only metadata the shelf can read back: an entry its own listing skips would be
  // invisible, and later pins of the artifact would pile up as name~2, name~3, ...
  if (!ShelfMetaSchema.safeParse(meta).success) {
    return { success: false, error: "This artifact's pin details are too long for the shelf" };
  }
  return scopeLocks.withLock(params.scopeDir, async () => {
    const chosen = await chooseShelfEntryName(
      params.scopeDir,
      shelfEntryName(params.relPath),
      meta
    );
    if (typeof chosen !== "string") return { success: false as const, error: chosen.error };
    const replaced = await replaceShelfEntryLocked({
      shelfRoot: params.shelfRoot,
      scopeDir: params.scopeDir,
      name: chosen,
      files: [
        { name: meta.file, content: params.bytes },
        { name: META_FILE_NAME, content: Buffer.from(JSON.stringify(meta, null, 2)) },
      ],
    });
    return replaced.success ? { success: true as const, name: chosen } : replaced;
  });
}

const MAX_SHELF_NAME_SUFFIX = 100;

/**
 * A pin replaces only its own earlier pin: same source workspace and artifact path, and an agent
 * never replaces a pin you made. Any other entry with the same name (another workspace or project
 * pinning `report.html`, or `a/b.md` vs `a__b.md`) keeps its bytes and the new pin gets a
 * `name~2`, `name~3`, ... entry instead, because the shelf may hold the only copy left. Only a
 * missing entry counts as free: any other lstat error (EACCES, EIO) fails the pin rather than
 * risking an overwrite.
 */
async function chooseShelfEntryName(
  scopeDir: string,
  baseName: string,
  next: ShelfMeta
): Promise<string | { error: string }> {
  for (let n = 1; n <= MAX_SHELF_NAME_SUFFIX; n++) {
    const name = n === 1 ? baseName : `${baseName}~${n}`;
    if (!isValidShelfEntryName(name)) break;
    const entryDir = path.join(scopeDir, name);
    try {
      await fs.lstat(entryDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return name;
      return { error: `Could not check shelf entry ${name}: ${getErrorMessage(error)}` };
    }
    const existing = await readMeta(entryDir);
    const sameSource =
      existing != null &&
      existing.sourceWorkspaceId === next.sourceWorkspaceId &&
      existing.sourcePath === next.sourcePath;
    if (sameSource && !(existing.pinnedBy === "user" && next.pinnedBy === "agent")) return name;
  }
  return { error: "Too many shelf entries share this name" };
}

/**
 * Replace one shelf entry with exactly `files` (plain names inside the entry). Shared by pins
 * and the settings-backup restore so both take the scope lock and swap atomically.
 */
export async function replaceShelfEntry(params: ShelfEntryWrite): Promise<ShelfWriteResult> {
  return scopeLocks.withLock(params.scopeDir, () => replaceShelfEntryLocked(params));
}

interface ShelfEntryWrite {
  shelfRoot: string;
  scopeDir: string;
  name: string;
  files: ReadonlyArray<{ name: string; content: Buffer }>;
}

type ShelfWriteResult = { success: true } | { success: false; error: string };

/** replaceShelfEntry body; the caller holds the scope lock (withShelfScopeLock). */
export async function replaceShelfEntryLocked(params: ShelfEntryWrite): Promise<ShelfWriteResult> {
  assert(isValidShelfEntryName(params.name), `invalid shelf entry name: ${params.name}`);
  assert(
    params.files.length > 0 && params.files.every((file) => isValidShelfEntryName(file.name)),
    "shelf entry files must be plain names"
  );
  await fs.mkdir(params.scopeDir, { recursive: true });
  if (!(await assertRealDirWithin(params.shelfRoot, params.scopeDir))) {
    return { success: false, error: "Shelf directory is not usable" };
  }
  // Build the entry beside its final place, then swap it in, so readers never see a
  // half-written entry. The previous entry is moved aside (dot names are never listed or backed
  // up) and only deleted once the new one is in place: a failed swap puts it back.
  const suffix = randomBytes(6).toString("hex");
  const staging = path.join(params.scopeDir, `.staging-${suffix}`);
  const previous = path.join(params.scopeDir, `.old-${suffix}`);
  const target = path.join(params.scopeDir, params.name);
  try {
    await fs.mkdir(staging);
    for (const file of params.files) {
      await writeFileAtomic(path.join(staging, file.name), file.content);
    }
    let movedAside = false;
    try {
      await fs.rename(target, previous);
      movedAside = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await fs.rename(staging, target);
    } catch (error) {
      if (movedAside) await fs.rename(previous, target);
      throw error;
    }
  } catch (error) {
    log.warn("Shelf entry write failed", { target, error: getErrorMessage(error) });
    return { success: false, error: `Shelf write failed: ${getErrorMessage(error)}` };
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(previous, { recursive: true, force: true }).catch(() => undefined);
  }
  return { success: true };
}

async function readMeta(entryDir: string): Promise<ShelfMeta | null> {
  try {
    return parseShelfMeta(await fs.readFile(path.join(entryDir, META_FILE_NAME), "utf8"));
  } catch {
    return null;
  }
}

/** Parse meta.json text; null unless valid and naming a plain content file other than itself. */
function parseShelfMeta(text: string): ShelfMeta | null {
  try {
    const meta = ShelfMetaSchema.parse(JSON.parse(text));
    return isValidShelfEntryName(meta.file) && !isMetaFileName(meta.file) ? meta : null;
  } catch {
    return null;
  }
}

/**
 * True when `files` (name -> bytes) form a complete entry exactly as pins write it: a valid
 * meta.json plus the one content file it names, nothing else. The settings-backup restore uses
 * this so an incomplete entry never replaces a readable one.
 */
export function isCompleteShelfEntry(files: ReadonlyMap<string, Buffer>): boolean {
  const metaBytes = files.get(META_FILE_NAME);
  if (metaBytes == null) return false;
  const meta = parseShelfMeta(metaBytes.toString("utf8"));
  return meta != null && files.size === 2 && files.has(meta.file);
}

/** Entries of one scope, newest pin first. Unreadable or malformed entries are skipped. */
export async function listShelfScope(
  shelfRoot: string,
  scopeDir: string,
  scope: ArtifactShelfScope
): Promise<ArtifactShelfEntry[]> {
  if (!(await assertRealDirWithin(shelfRoot, scopeDir))) return [];
  let names: string[];
  try {
    names = await fs.readdir(scopeDir);
  } catch {
    return [];
  }
  const entries = await Promise.all(
    names.filter(isValidShelfEntryName).map(async (name) => {
      const entryDir = path.join(scopeDir, name);
      if (!(await assertRealDirWithin(shelfRoot, entryDir))) return null;
      const meta = await readMeta(entryDir);
      if (!meta) return null;
      try {
        const stat = await fs.lstat(path.join(entryDir, meta.file));
        if (!stat.isFile()) return null;
        const entry: ArtifactShelfEntry = {
          scope,
          name,
          file: meta.file,
          title: meta.title,
          kind: meta.kind,
          size: stat.size,
          version: meta.version,
          sourceWorkspaceId: meta.sourceWorkspaceId,
          sourcePath: meta.sourcePath,
          pinnedAtMs: meta.pinnedAtMs,
          pinnedBy: meta.pinnedBy,
        };
        return entry;
      } catch {
        return null;
      }
    })
  );
  return entries
    .filter((entry): entry is ArtifactShelfEntry => entry != null)
    .sort((a, b) => b.pinnedAtMs - a.pinnedAtMs || a.name.localeCompare(b.name));
}

export type ShelfReadOutcome =
  | { status: "ok"; meta: ShelfMeta; bytes: Buffer; modifiedMs: number }
  | { status: "missing" }
  | { status: "too_large"; meta: ShelfMeta; size: number; modifiedMs: number };

/** Read one entry's bytes (capped), refusing symlinks and names outside the scope dir. */
export async function readShelfEntry(
  shelfRoot: string,
  scopeDir: string,
  name: string,
  maxBytes: number = MAX_SHELF_FILE_BYTES
): Promise<ShelfReadOutcome> {
  if (!isValidShelfEntryName(name)) return { status: "missing" };
  if (!(await assertRealDirWithin(shelfRoot, scopeDir))) return { status: "missing" };
  const entryDir = path.join(scopeDir, name);
  if (!(await assertRealDirWithin(shelfRoot, entryDir))) return { status: "missing" };
  const meta = await readMeta(entryDir);
  if (!meta) return { status: "missing" };
  let handle: fs.FileHandle;
  try {
    // O_NOFOLLOW: a content file swapped for a symlink is refused, not followed.
    handle = await fs.open(
      path.join(entryDir, meta.file),
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
    );
  } catch {
    return { status: "missing" };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { status: "missing" };
    if (stat.size > maxBytes) {
      return { status: "too_large", meta, size: stat.size, modifiedMs: meta.pinnedAtMs };
    }
    // readFile loops until EOF (a single read() may return fewer bytes); the entry is at most
    // maxBytes per the stat above, and a file that grew since is refused.
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) {
      return { status: "too_large", meta, size: bytes.length, modifiedMs: meta.pinnedAtMs };
    }
    return { status: "ok", meta, bytes, modifiedMs: meta.pinnedAtMs };
  } finally {
    await handle.close();
  }
}

export const SHELF_ENTRY_CHANGED_ERROR =
  "This shelf entry changed since it was listed; refresh and try again.";

/**
 * Remove one entry. A missing entry is not an error (unpin is idempotent). With
 * `expectedPinnedAtMs` (the listing's value), an entry that was re-pinned since, possibly by
 * another workspace reusing the name, is kept: the shelf may hold its only copy.
 */
export async function unpinFromShelf(
  shelfRoot: string,
  scopeDir: string,
  name: string,
  expectedPinnedAtMs?: number
): Promise<{ success: true } | { success: false; error: string }> {
  if (!isValidShelfEntryName(name)) return { success: false, error: "Invalid shelf entry" };
  return scopeLocks.withLock(scopeDir, async () => {
    // A missing or symlinked scope dir holds nothing this shelf owns: nothing to unpin.
    if (!(await assertRealDirWithin(shelfRoot, scopeDir))) return { success: true as const };
    const entryDir = path.join(scopeDir, name);
    if (expectedPinnedAtMs != null) {
      const exists = await fs.lstat(entryDir).then(
        () => true,
        () => false
      );
      if (exists && (await readMeta(entryDir))?.pinnedAtMs !== expectedPinnedAtMs) {
        return { success: false as const, error: SHELF_ENTRY_CHANGED_ERROR };
      }
    }
    try {
      const stat = await fs.lstat(entryDir);
      // A symlinked entry is unlinked, never followed into its target.
      if (stat.isSymbolicLink()) await fs.unlink(entryDir);
      else await fs.rm(entryDir, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("Shelf unpin failed", { entryDir, error: getErrorMessage(error) });
        return { success: false as const, error: `Unpin failed: ${getErrorMessage(error)}` };
      }
    }
    return { success: true as const };
  });
}

export function parseShelfScope(value: unknown): ArtifactShelfScope | null {
  const parsed = ArtifactShelfScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
