import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import { assert } from "@/common/utils/assert";
import { isWindowsUnusableSegment } from "@/common/config/schemas/settingsBackup";
import {
  getArtifactShelfRoot,
  isCompleteShelfEntry,
  isValidShelfEntryName,
  replaceShelfEntryLocked,
  withShelfScopeLock,
} from "@/node/services/artifactShelf";
import { projectPathHashSuffix } from "@/node/services/memoryService";
import writeFileAtomic from "@/node/utils/writeFileAtomic";
import {
  ARTIFACT_SHELF_BACKUP_DIR,
  BACKUP_MANIFEST_FILE,
  hasDisallowedPathShape,
  MAX_BACKUP_FILE_BYTES,
  MAX_BACKUP_FILE_COUNT,
  MAX_BACKUP_TOTAL_BYTES,
  resolveContainedPath,
} from "./payload";

/**
 * Settings backup of the artifact shelf (Artifacts M5c). Artifacts are not settings, so this is
 * off unless the user opts in:
 * - the global shelf travels only with its own toggle (`includeGlobalArtifacts`);
 * - project shelves travel only inside the opt-in project bundle (`includeProjects`);
 * - workspace artifacts are never backed up.
 *
 * Like `project-bundle/`, the shelf lives in its own sidecar directory with its own manifest:
 * older builds read the core payload from its manifest and silently ignore unknown sidecars,
 * while a path listed in the core manifest would make them refuse the whole backup.
 *
 * Sidecar layout: artifact-shelf/{manifest.json, global/<entry>/<file>, project/<dir>/<entry>/<file>}
 * where <dir> is the project's memory-style directory name (basename + path hash), so restore
 * recognizes the same project the way project memory does.
 *
 * Shelf files may be up to 10 MB while backup files are capped at 8 MiB: larger files, and files
 * that would push the managed tree past the 64 MiB total, are skipped and reported.
 */

export const ARTIFACT_SHELF_BACKUP_MANIFEST_PATH = `${ARTIFACT_SHELF_BACKUP_DIR}/${BACKUP_MANIFEST_FILE}`;

export { ARTIFACT_SHELF_BACKUP_DIR };

const ShelfBackupManifestSchema = z.object({
  schemaVersion: z.literal(1),
  projects: z.array(z.object({ path: z.string().max(4096), dir: z.string().max(64) })).max(256),
  files: z
    .array(z.object({ path: z.string().max(1024), sha256: z.string().regex(/^[0-9a-f]{64}$/) }))
    .max(MAX_BACKUP_FILE_COUNT),
});
export type ShelfBackupManifest = z.infer<typeof ShelfBackupManifestSchema>;

export interface ShelfBackupFile {
  /** Sidecar-relative POSIX path (global/... or project/<dir>/...). */
  path: string;
  content: Buffer;
}

export interface ShelfBackup {
  manifest: ShelfBackupManifest;
  files: ShelfBackupFile[];
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Project dir names come from projectMemoryDirName; a repository may hold anything. */
function isValidProjectDir(dir: string, projectPath: string): boolean {
  return (
    /^[A-Za-z0-9._-]{1,64}$/.test(dir) &&
    dir !== "." &&
    dir !== ".." &&
    !isWindowsUnusableSegment(dir) &&
    dir.endsWith(`-${projectPathHashSuffix(projectPath)}`)
  );
}

/**
 * Sidecar file paths: global/<entry>/<file> or project/<dir>/<entry>/<file>, held to the shared
 * backup path rules. A project dir may start with a dot (a `.dotfiles` project), so that one
 * segment is shape-checked with the dot masked, like the project bundle does.
 */
function isAllowedShelfBackupPath(relativePath: string, projectDirs: ReadonlySet<string>): boolean {
  const segments = relativePath.split("/");
  // Entry and file names must also be names the shelf itself accepts.
  if (!segments.slice(-2).every(isValidShelfEntryName)) return false;
  if (segments[0] === "global") {
    return segments.length === 3 && !hasDisallowedPathShape(relativePath, { portable: true });
  }
  if (segments[0] === "project") {
    const dir = segments[1] ?? "";
    if (segments.length !== 4 || !projectDirs.has(dir)) return false;
    const masked = [segments[0], dir.replace(/^\./, "_"), ...segments.slice(2)].join("/");
    return !hasDisallowedPathShape(masked, { portable: true });
  }
  return false;
}

/**
 * Shelf entries of one scope with their regular files (<entry>/<file>); symlinks are skipped.
 * An entry is backed up whole or not at all (its meta.json is useless without the copy).
 */
async function listScopeEntries(
  scopeDir: string
): Promise<Array<{ entry: string; files: string[] }>> {
  const out: Array<{ entry: string; files: string[] }> = [];
  let entries: string[];
  try {
    const stat = await fs.lstat(scopeDir);
    if (!stat.isDirectory()) return out;
    entries = await fs.readdir(scopeDir);
  } catch {
    return out;
  }
  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) continue; // staging dirs and other hidden files
    const entryDir = path.join(scopeDir, entry);
    const entryStat = await fs.lstat(entryDir).catch(() => null);
    if (!entryStat?.isDirectory()) continue;
    const files: string[] = [];
    for (const file of (await fs.readdir(entryDir).catch(() => [] as string[])).sort()) {
      const fileStat = await fs.lstat(path.join(entryDir, file)).catch(() => null);
      if (fileStat?.isFile()) files.push(`${entry}/${file}`);
    }
    if (files.length > 0) out.push({ entry, files });
  }
  return out;
}

/**
 * Bytes kept free for the sidecar manifest's fixed part (schemaVersion and the JSON frame). Each
 * file and project record is charged against the budget as it is accepted (manifestRecordBytes).
 */
export const SHELF_MANIFEST_HEADER_RESERVE = 4096;

/**
 * Upper bound of one record's bytes in the pretty-printed manifest: the compact JSON plus the
 * indentation, line breaks and separators JSON.stringify(…, null, 2) adds (27 bytes; 32 kept).
 */
function manifestRecordBytes(record: Record<string, string>): number {
  return Buffer.byteLength(JSON.stringify(record)) + 32;
}

const PLACEHOLDER_SHA256 = "0".repeat(64);

export interface CollectShelfBackupResult {
  backup: ShelfBackup;
  /** Human-readable notices for files left out (size, total budget, unportable names). */
  skipped: string[];
}

/**
 * Collect the shelf scopes selected for backup. `projects` are the registered projects whose
 * shelves travel with the project bundle (empty when it is off). `budgetBytes` is what the
 * managed tree has left under the 64 MiB total.
 */
export async function collectShelfBackup(params: {
  xumRoot: string;
  includeGlobal: boolean;
  projects: ReadonlyArray<{ path: string; dir: string }>;
  budgetBytes: number;
  maxFileCount: number;
}): Promise<CollectShelfBackupResult> {
  const shelfRoot = getArtifactShelfRoot(params.xumRoot);
  const scopes: Array<{
    prefix: string;
    dir: string;
    project: { path: string; dir: string } | null;
  }> = [];
  if (params.includeGlobal) {
    scopes.push({ prefix: "global", dir: path.join(shelfRoot, "global"), project: null });
  }
  for (const project of params.projects) {
    scopes.push({
      prefix: `project/${project.dir}`,
      dir: path.join(shelfRoot, "project", project.dir),
      project,
    });
  }
  const projectDirs = new Set(params.projects.map((p) => p.dir));
  const files: ShelfBackupFile[] = [];
  const skipped: string[] = [];
  // Accepted paths folded the way readShelfBackup folds them: it refuses a sidecar with
  // case-only duplicates (they alias on macOS and Windows), so two pins such as Report.md and
  // report.md, both valid on a case-sensitive host, must not both be exported.
  const exportedFolded = new Set<string>();
  // File bytes plus the manifest records they add, so the written sidecar fits the budget.
  let used = 0;
  for (const scope of scopes) {
    let projectCharged = false;
    // Under the scope lock, a pin or restore cannot rename an entry between its listing, sizes
    // and reads (no ENOENT failing the push, no meta.json from one generation and file from
    // another).
    await withShelfScopeLock(scope.dir, async () => {
      for (const { entry, files: entryFiles } of await listScopeEntries(scope.dir)) {
        const label = `artifacts/${scope.prefix}/${entry}`;
        const paths = entryFiles.map((rel) => `${scope.prefix}/${rel}`);
        if (paths.some((p) => !isAllowedShelfBackupPath(p, projectDirs))) {
          skipped.push(`${label} (its file name cannot be backed up portably)`);
          continue;
        }
        if (paths.some((p) => exportedFolded.has(p.toLowerCase()))) {
          skipped.push(`${label} (its name differs only by case from an entry already backed up)`);
          continue;
        }
        const sizes = await Promise.all(
          entryFiles.map(
            async (rel) => (await fs.lstat(path.join(scope.dir, ...rel.split("/")))).size
          )
        );
        if (sizes.some((size) => size > MAX_BACKUP_FILE_BYTES)) {
          skipped.push(`${label} (over the 8 MiB limit for one backup file)`);
          continue;
        }
        const manifestBytes =
          paths.reduce(
            (sum, p) => sum + manifestRecordBytes({ path: p, sha256: PLACEHOLDER_SHA256 }),
            0
          ) + (scope.project != null && !projectCharged ? manifestRecordBytes(scope.project) : 0);
        const entrySize = sizes.reduce((a, b) => a + b, 0) + manifestBytes;
        if (
          used + entrySize > params.budgetBytes ||
          files.length + entryFiles.length > params.maxFileCount
        ) {
          skipped.push(`${label} (the backup would exceed its 64 MiB total)`);
          continue;
        }
        used += manifestBytes;
        if (scope.project != null) projectCharged = true;
        for (const p of paths) exportedFolded.add(p.toLowerCase());
        for (const [index, rel] of entryFiles.entries()) {
          const content = await fs.readFile(path.join(scope.dir, ...rel.split("/")));
          used += content.length;
          files.push({ path: paths[index] ?? rel, content });
        }
      }
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  // Project dirs with entries: project/<dir>/<entry>/<file>. Global paths are
  // global/<entry>/<file>, whose segment 1 is an entry name, not a project dir.
  const usedDirs = new Set(
    files.filter((f) => f.path.startsWith("project/")).map((f) => f.path.split("/")[1])
  );
  return {
    backup: {
      manifest: {
        schemaVersion: 1,
        projects: params.projects
          .filter((p) => usedDirs.has(p.dir))
          .map((p) => ({ path: p.path, dir: p.dir }))
          .sort((a, b) => a.path.localeCompare(b.path)),
        files: files.map((f) => ({ path: f.path, sha256: sha256(f.content) })),
      },
      files,
    },
    skipped,
  };
}

export function serializeShelfBackupManifest(manifest: ShelfBackupManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

/** Write the sidecar fresh (nothing is written when there are no files). */
export async function writeShelfBackup(destinationDir: string, backup: ShelfBackup): Promise<void> {
  const sidecar = path.join(destinationDir, ARTIFACT_SHELF_BACKUP_DIR);
  await fs.rm(sidecar, { recursive: true, force: true });
  if (backup.files.length === 0) return;
  await fs.mkdir(sidecar, { recursive: true, mode: 0o700 });
  for (const file of backup.files) {
    const target = await resolveContainedPath(sidecar, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFileAtomic(target, file.content, { mode: 0o600 });
  }
  await writeFileAtomic(
    path.join(sidecar, BACKUP_MANIFEST_FILE),
    serializeShelfBackupManifest(backup.manifest),
    { mode: 0o600 }
  );
}

export async function shelfBackupExists(sourceDir: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(sourceDir, ARTIFACT_SHELF_BACKUP_DIR));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and validate a checked-out sidecar. The repository side is written by whoever can push,
 * so every path, size and hash is checked, symlinks are refused, and budgets are enforced
 * before anything is restored. Missing sidecar → null.
 *
 * `scopes` limits reading to the scopes being restored: files of a disabled scope are neither
 * validated nor read, so a damaged global shelf cannot block restoring project shelves (and the
 * other way around).
 */
export async function readShelfBackup(
  sourceDir: string,
  scopes: { includeGlobal: boolean; includeProjects: boolean } = {
    includeGlobal: true,
    includeProjects: true,
  }
): Promise<ShelfBackup | null> {
  const sidecar = path.join(sourceDir, ARTIFACT_SHELF_BACKUP_DIR);
  const sidecarStat = await fs.lstat(sidecar).catch(() => null);
  if (sidecarStat === null) return null;
  if (!sidecarStat.isDirectory()) throw new Error("Backup artifact shelf is not a directory");
  const manifestPath = await resolveContainedPath(sidecar, BACKUP_MANIFEST_FILE);
  const manifestStat = await fs.lstat(manifestPath);
  // Same cap as any backup file: the schema bounds the manifest (4096 records of 1024-char paths)
  // to about 5 MB, so every manifest an export can write stays readable.
  if (!manifestStat.isFile() || manifestStat.size > MAX_BACKUP_FILE_BYTES) {
    throw new Error("Backup artifact shelf manifest is invalid");
  }
  const parsed = ShelfBackupManifestSchema.safeParse(
    JSON.parse(await fs.readFile(manifestPath, "utf-8"))
  );
  if (!parsed.success) throw new Error("Backup artifact shelf manifest is invalid");
  const manifest = parsed.data;
  if (scopes.includeProjects) {
    for (const project of manifest.projects) {
      if (!isValidProjectDir(project.dir, project.path)) {
        throw new Error(`Backup artifact shelf has an invalid project directory '${project.dir}'`);
      }
    }
  }
  const projectDirs = new Set(manifest.projects.map((p) => p.dir));
  const seen = new Set<string>();
  const files: ShelfBackupFile[] = [];
  let total = 0;
  for (const entry of manifest.files) {
    const scope = entry.path.split("/")[0];
    if (scope === "global" ? !scopes.includeGlobal : !scopes.includeProjects) continue;
    if (!isAllowedShelfBackupPath(entry.path, projectDirs) || seen.has(entry.path.toLowerCase())) {
      throw new Error(`Backup artifact shelf contains disallowed path '${entry.path}'`);
    }
    seen.add(entry.path.toLowerCase());
    const absolute = await resolveContainedPath(sidecar, entry.path);
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.size > MAX_BACKUP_FILE_BYTES) {
      throw new Error(`Backup artifact shelf file '${entry.path}' is invalid or too large`);
    }
    total += stat.size;
    if (total > MAX_BACKUP_TOTAL_BYTES) throw new Error("Backup artifact shelf is too large");
    const content = await fs.readFile(absolute);
    if (sha256(content) !== entry.sha256) {
      throw new Error(`Backup artifact shelf file '${entry.path}' does not match its manifest`);
    }
    files.push({ path: entry.path, content });
  }
  return { manifest, files };
}

export interface ShelfRestoreEntry {
  /** Scope directory relative to the Xum root: artifacts/global or artifacts/project/<dir>. */
  scopePath: string;
  name: string;
  files: Array<{ name: string; content: Buffer }>;
}

/**
 * Which backed-up entries a restore would write. Global entries need `includeGlobal`; a
 * project's entries need `includeProjects` and a registered project at the same path (whose
 * directory name is recomputed locally, as project memory does). Entries of unmatched
 * projects are reported, not written.
 */
export function planShelfRestore(params: {
  backup: ShelfBackup;
  includeGlobal: boolean;
  includeProjects: boolean;
  /** Registered project path → local project dir name. */
  registeredProjects: ReadonlyMap<string, string>;
}): { entries: ShelfRestoreEntry[]; skipped: string[] } {
  const byDir = new Map(params.backup.manifest.projects.map((p) => [p.dir, p.path]));
  const entries = new Map<string, ShelfRestoreEntry>();
  const skipped = new Set<string>();
  for (const file of params.backup.files) {
    const segments = file.path.split("/");
    let scopePath: string;
    let rest: string[];
    if (segments[0] === "global") {
      if (!params.includeGlobal) continue;
      scopePath = "artifacts/global";
      rest = segments.slice(1);
    } else {
      if (!params.includeProjects) continue;
      const sourcePath = byDir.get(segments[1] ?? "");
      const localDir = sourcePath != null ? params.registeredProjects.get(sourcePath) : undefined;
      if (localDir == null) {
        skipped.add(`artifacts/project/${segments[1] ?? ""} (its project is not registered here)`);
        continue;
      }
      scopePath = `artifacts/project/${localDir}`;
      rest = segments.slice(2);
    }
    const [name, fileName] = rest;
    assert(name != null && fileName != null, `unexpected shelf backup path ${file.path}`);
    const key = `${scopePath}/${name}`;
    const entry = entries.get(key) ?? { scopePath, name, files: [] };
    entry.files.push({ name: fileName, content: file.content });
    entries.set(key, entry);
  }
  // An entry is restored whole or not at all: one without a valid meta.json and exactly the
  // content file it names would replace a readable local entry with one the shelf skips.
  const complete: ShelfRestoreEntry[] = [];
  for (const [key, entry] of entries) {
    const files = new Map(entry.files.map((file) => [file.name, file.content]));
    if (isCompleteShelfEntry(files)) complete.push(entry);
    else skipped.add(`${key} (not a complete shelf entry)`);
  }
  return { entries: complete, skipped: [...skipped].sort() };
}

/** Current files of a local shelf entry (regular files only), or null when it is absent. */
async function readLocalEntry(
  xumRoot: string,
  entry: ShelfRestoreEntry
): Promise<Map<string, Buffer> | null> {
  const entryDir = await resolveContainedPath(xumRoot, `${entry.scopePath}/${entry.name}`);
  const stat = await fs.lstat(entryDir).catch(() => null);
  if (stat === null) return null;
  if (!stat.isDirectory()) return new Map();
  const files = new Map<string, Buffer>();
  for (const name of await fs.readdir(entryDir)) {
    const filePath = path.join(entryDir, name);
    if ((await fs.lstat(filePath)).isFile()) files.set(name, await fs.readFile(filePath));
  }
  return files;
}

function sameEntry(local: ReadonlyMap<string, Buffer>, entry: ShelfRestoreEntry): boolean {
  return (
    local.size === entry.files.length &&
    entry.files.every((file) => local.get(file.name)?.equals(file.content) === true)
  );
}

/** Preview statuses at the local destination: A (new entry) or M (entry would change). */
export async function previewShelfRestore(
  xumRoot: string,
  entries: readonly ShelfRestoreEntry[]
): Promise<Array<{ status: "A" | "M"; path: string }>> {
  const changes: Array<{ status: "A" | "M"; path: string }> = [];
  for (const entry of entries) {
    const local = await readLocalEntry(xumRoot, entry);
    if (local !== null && sameEntry(local, entry)) continue;
    for (const file of entry.files) {
      changes.push({
        status: local === null ? "A" : "M",
        path: `${entry.scopePath}/${entry.name}/${file.name}`,
      });
    }
  }
  return changes;
}

/** Hold every given scope lock (sorted, so concurrent callers cannot deadlock) around `fn`. */
async function withShelfScopeLocks<T>(
  scopeDirs: readonly string[],
  fn: () => Promise<T>
): Promise<T> {
  const [first, ...rest] = [...new Set(scopeDirs)].sort();
  if (first == null) return fn();
  return withShelfScopeLock(first, () => withShelfScopeLocks(rest, fn));
}

/**
 * Write planned entries into the Xum root. Each entry replaces the local one of the same name
 * whole (a pin is one file plus its meta.json); entries the backup does not hold are kept.
 *
 * The local entries about to be replaced are first written to `snapshotPath` as a shelf sidecar
 * (readShelfBackup can read it back, like the project-bundle snapshot). Reading them, writing the
 * snapshot and replacing them happen under the affected scope locks, so a concurrent pin can
 * neither be overwritten unsaved nor leave the snapshot with bytes that were not replaced.
 */
export async function applyShelfRestore(params: {
  xumRoot: string;
  entries: readonly ShelfRestoreEntry[];
  snapshotPath: string;
  /** Registered project path → local project dir name (names the snapshot's projects). */
  registeredProjects: ReadonlyMap<string, string>;
}): Promise<string[]> {
  const shelfRoot = getArtifactShelfRoot(params.xumRoot);
  const targets = await Promise.all(
    params.entries.map(async (entry) => ({
      entry,
      scopeDir: await resolveContainedPath(params.xumRoot, entry.scopePath),
    }))
  );
  return withShelfScopeLocks(
    targets.map((target) => target.scopeDir),
    async () => {
      const changing: Array<{ entry: ShelfRestoreEntry; scopeDir: string }> = [];
      const snapshotFiles: ShelfBackupFile[] = [];
      for (const target of targets) {
        const local = await readLocalEntry(params.xumRoot, target.entry);
        if (local !== null && sameEntry(local, target.entry)) continue;
        changing.push(target);
        const prefix = target.entry.scopePath.replace(/^artifacts\//, "");
        for (const [name, content] of local ?? []) {
          snapshotFiles.push({ path: `${prefix}/${target.entry.name}/${name}`, content });
        }
      }
      snapshotFiles.sort((a, b) => a.path.localeCompare(b.path));
      const snapshotDirs = new Set(
        snapshotFiles.flatMap((file) => {
          const [scope, dir] = file.path.split("/");
          return scope === "project" && dir != null ? [dir] : [];
        })
      );
      await writeShelfBackup(params.snapshotPath, {
        manifest: {
          schemaVersion: 1,
          projects: [...params.registeredProjects]
            .filter(([, dir]) => snapshotDirs.has(dir))
            .map(([projectPath, dir]) => ({ path: projectPath, dir }))
            .sort((a, b) => a.path.localeCompare(b.path)),
          files: snapshotFiles.map((file) => ({ path: file.path, sha256: sha256(file.content) })),
        },
        files: snapshotFiles,
      });

      const written: string[] = [];
      for (const { entry, scopeDir } of changing) {
        const result = await replaceShelfEntryLocked({
          shelfRoot,
          scopeDir,
          name: entry.name,
          files: entry.files,
        });
        if (!result.success) throw new Error(`Cannot restore ${entry.scopePath}: ${result.error}`);
        written.push(...entry.files.map((file) => `${entry.scopePath}/${entry.name}/${file.name}`));
      }
      return written;
    }
  );
}

/** Files and bytes already in the managed tree, so the shelf fits in what is left. */
export async function measureManagedTree(
  destinationDir: string
): Promise<{ fileCount: number; bytes: number }> {
  const entries = await fs.readdir(destinationDir, { withFileTypes: true, recursive: true });
  let fileCount = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    fileCount += 1;
    bytes += (await fs.lstat(path.join(entry.parentPath, entry.name))).size;
  }
  return { fileCount, bytes };
}
