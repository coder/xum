import * as fsPromises from "fs/promises";
import * as path from "path";
import * as jsonc from "jsonc-parser";
import writeFileAtomic from "write-file-atomic";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { isMultiProject } from "@/common/utils/multiProject";
import { isWorktreeRuntime } from "@/common/types/runtime";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { Config } from "@/node/config";
import { expandTilde } from "@/node/runtime/tildeExpansion";
import { log } from "@/node/services/log";
import { isPathInsideDir, stripTrailingSlashes } from "@/node/utils/pathUtils";
import { getProjectName } from "@/node/utils/runtime/helpers";

/**
 * Opt-in sync of a VS Code `.code-workspace` file's `folders` list with a
 * project's active worktree workspaces (issue #3722), so users browsing in
 * VS Code / code-server see every xum worktree in one multi-root window.
 *
 * Managed-entry invariant: xum only ever adds or removes folder entries whose
 * resolved path lives under the project's managed worktree root
 * (`<srcDir>/<projectName>/`). Everything else in the file (user-added
 * folders, the project-root entry seeded on creation, `settings`,
 * `extensions`, comments) is never touched, reordered, or rewritten.
 */

export const CODE_WORKSPACE_EXTENSION = ".code-workspace";

// VS Code generates .code-workspace files with tab indentation; match it.
const MODIFY_OPTIONS: jsonc.ModificationOptions = {
  formattingOptions: { insertSpaces: false, tabSize: 4, eol: "\n" },
};

// Serialize read-modify-write per canonical file path: two projects may share
// one .code-workspace file, and concurrent lifecycle syncs would otherwise
// lose updates (the later write wins over a stale read).
const fileWriteQueues = new Map<string, Promise<void>>();

async function withFileWriteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileWriteQueues.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail: Promise<void> = run
    .then(
      () => undefined,
      () => undefined
    )
    .then(() => {
      if (fileWriteQueues.get(key) === tail) {
        fileWriteQueues.delete(key);
      }
    });
  fileWriteQueues.set(key, tail);
  return run;
}

// write-file-atomic renames a temp file over the target, which would replace a
// symlink rather than write through it; resolve the real target first so user
// symlinks to shared editor config survive syncs.
async function resolveRealPath(filePath: string): Promise<string> {
  try {
    return await fsPromises.realpath(filePath);
  } catch {
    // File may not exist yet; resolve the parent so directory symlinks are
    // still honored, keeping the configured basename.
    try {
      const realDir = await fsPromises.realpath(path.dirname(filePath));
      return path.join(realDir, path.basename(filePath));
    } catch {
      return filePath;
    }
  }
}

function readFolders(text: string): unknown[] | undefined {
  const parsed = jsonc.parse(text, undefined, { allowTrailingComma: true }) as
    | { folders?: unknown }
    | undefined;
  return Array.isArray(parsed?.folders) ? parsed.folders : undefined;
}

// VS Code resolves relative folder paths against the .code-workspace file's
// directory; it does not expand `~` or variables, so neither do we. Such
// entries never match the managed root and stay untouched.
function getEntryPath(entry: unknown, workspaceFileDir: string): string | null {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }
  const folderPath = (entry as { path?: unknown }).path;
  if (typeof folderPath !== "string" || folderPath.trim() === "") {
    return null;
  }
  return path.resolve(workspaceFileDir, folderPath);
}

export interface CodeWorkspaceFileUpdate {
  /** Absolute path of the .code-workspace file. */
  codeWorkspacePath: string;
  /** Absolute directories; only folder entries under one of them are managed by xum. */
  managedRootDirs: string[];
  /** Absolute worktree paths that should be present as folder entries. */
  desiredPaths: string[];
  /** Folder paths written when the file does not exist yet. */
  seedFolders: string[];
}

function isUnderAnyRoot(managedRootDirs: string[], candidate: string): boolean {
  return managedRootDirs.some((rootDir) => isPathInsideDir(rootDir, candidate));
}

/**
 * Reconcile the file's `folders` array with `desiredPaths` under the
 * managed-entry invariant. Creates the file (with `seedFolders`) when missing.
 * Uses jsonc-parser edits so user comments and unknown keys survive.
 */
export async function updateCodeWorkspaceFile(update: CodeWorkspaceFileUpdate): Promise<void> {
  const targetPath = await resolveRealPath(update.codeWorkspacePath);
  await withFileWriteLock(targetPath, () => updateCodeWorkspaceFileLocked(targetPath, update));
}

async function updateCodeWorkspaceFileLocked(
  targetPath: string,
  update: CodeWorkspaceFileUpdate
): Promise<void> {
  const { codeWorkspacePath, managedRootDirs, desiredPaths } = update;
  // Relative folder entries resolve against the configured file location,
  // matching how VS Code resolves them for the file the user opens.
  const fileDir = path.dirname(codeWorkspacePath);

  let original: string | null;
  try {
    original = await fsPromises.readFile(targetPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    original = null;
  }

  if (original === null) {
    const fresh = { folders: update.seedFolders.map((folderPath) => ({ path: folderPath })) };
    await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
    await writeFileAtomic(targetPath, JSON.stringify(fresh, null, "\t") + "\n");
    return;
  }

  // Never clobber a file we cannot faithfully edit (self-healing over failing).
  const parseErrors: jsonc.ParseError[] = [];
  const parsed = jsonc.parse(original, parseErrors, { allowTrailingComma: true }) as unknown;
  if (
    parseErrors.length > 0 ||
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    log.warn("Skipping .code-workspace sync: file is not valid JSONC", { codeWorkspacePath });
    return;
  }

  const existingFolders = (parsed as { folders?: unknown }).folders;
  if (existingFolders !== undefined && !Array.isArray(existingFolders)) {
    log.warn("Skipping .code-workspace sync: 'folders' is not an array", { codeWorkspacePath });
    return;
  }

  const desired = new Set(desiredPaths.map((desiredPath) => path.resolve(desiredPath)));
  let text = original;

  if (existingFolders === undefined) {
    text = jsonc.applyEdits(text, jsonc.modify(text, ["folders"], [], MODIFY_OPTIONS));
  }

  // Remove managed entries that are no longer desired, one edit at a time
  // (indices shift after every removal, so re-parse between edits).
  for (;;) {
    const folders = readFolders(text) ?? [];
    const removeIndex = folders.findIndex((entry) => {
      const entryPath = getEntryPath(entry, fileDir);
      return (
        entryPath !== null && isUnderAnyRoot(managedRootDirs, entryPath) && !desired.has(entryPath)
      );
    });
    if (removeIndex < 0) {
      break;
    }
    text = jsonc.applyEdits(
      text,
      jsonc.modify(text, ["folders", removeIndex], undefined, MODIFY_OPTIONS)
    );
  }

  // Append missing desired entries after the existing ones (user order is preserved).
  const presentPaths = new Set(
    (readFolders(text) ?? [])
      .map((entry) => getEntryPath(entry, fileDir))
      .filter((entryPath): entryPath is string => entryPath !== null)
  );
  const additions = [...desired].filter((desiredPath) => !presentPaths.has(desiredPath)).sort();
  for (const folderPath of additions) {
    const length = (readFolders(text) ?? []).length;
    text = jsonc.applyEdits(
      text,
      jsonc.modify(
        text,
        ["folders", length],
        { path: folderPath },
        {
          ...MODIFY_OPTIONS,
          isArrayInsertion: true,
        }
      )
    );
  }

  if (text !== original) {
    await writeFileAtomic(targetPath, text);
  }
}

function belongsToProject(metadata: FrontendWorkspaceMetadata, projectPath: string): boolean {
  return (
    stripTrailingSlashes(metadata.projectPath) === projectPath ||
    (metadata.projects?.some((ref) => stripTrailingSlashes(ref.projectPath) === projectPath) ??
      false)
  );
}

/**
 * Compute the worktree paths that belong in a project's .code-workspace file
 * (active, top-level worktree workspaces) plus the managed root directories
 * that scope which existing entries xum may remove.
 */
export function computeManagedWorktreePaths(params: {
  allMetadata: FrontendWorkspaceMetadata[];
  /** Normalized (no trailing slash) project path. */
  projectPath: string;
  projectName: string;
  defaultManagedRootDir: string;
}): { desiredPaths: string[]; managedRootDirs: string[] } {
  const { allMetadata, projectPath, projectName, defaultManagedRootDir } = params;

  // Managed roots come from every persisted worktree workspace of the project
  // (any lifecycle state), not just the current global srcDir: worktrees
  // created under a custom or legacy srcBaseDir (e.g. pre-rename ~/.mux/src)
  // must stay managed after upgrades. Residual: an entry under a custom root
  // whose last workspace was deleted is no longer classified as managed and
  // can linger until removed by hand.
  const roots = new Set<string>([path.resolve(defaultManagedRootDir)]);
  for (const metadata of allMetadata) {
    if (!belongsToProject(metadata, projectPath) || !isWorktreeRuntime(metadata.runtimeConfig)) {
      continue;
    }
    roots.add(path.resolve(path.join(expandTilde(metadata.runtimeConfig.srcBaseDir), projectName)));
  }
  const managedRootDirs = [...roots].sort();

  const desired = new Set<string>();
  for (const metadata of allMetadata) {
    if (!isWorktreeRuntime(metadata.runtimeConfig)) {
      continue;
    }
    // Sub-agent child workspaces are transient implementation detail; listing
    // them would churn the user's editor window on every spawned task.
    if (metadata.parentWorkspaceId) {
      continue;
    }
    // isolation:"none" tasks share an ancestor checkout, not an own worktree.
    if (metadata.taskIsolation === "none") {
      continue;
    }
    if (isWorkspaceArchived(metadata.archivedAt, metadata.unarchivedAt)) {
      continue;
    }
    if (!belongsToProject(metadata, projectPath)) {
      continue;
    }

    let worktreePath: string;
    if (isMultiProject(metadata)) {
      // Multi-project workspaces persist the _workspaces/<name> symlink
      // container as namedWorkspacePath; the real per-project checkout lives
      // at <srcBaseDir>/<projectName>/<workspaceName> for the primary and
      // secondary projects alike (createMultiProject passes
      // directoryName: workspaceName).
      worktreePath = path.join(
        expandTilde(metadata.runtimeConfig.srcBaseDir),
        projectName,
        metadata.name
      );
    } else {
      worktreePath = metadata.namedWorkspacePath;
    }
    const resolved = path.resolve(worktreePath);
    // Only paths under a managed root are synced; anything else is user-owned.
    if (!isUnderAnyRoot(managedRootDirs, resolved)) {
      continue;
    }
    desired.add(resolved);
  }
  return { desiredPaths: [...desired].sort(), managedRootDirs };
}

/**
 * Best-effort sync entry point used by workspace lifecycle operations and
 * startup reconciliation. Fast no-op when the project has no
 * `codeWorkspaceSyncPath` configured. Never throws: sync failures must never
 * fail or block a workspace operation.
 */
export async function syncProjectCodeWorkspace(config: Config, projectPath: string): Promise<void> {
  try {
    const normalizedProjectPath = stripTrailingSlashes(projectPath);
    const projectConfig = config.loadConfigOrDefault().projects.get(normalizedProjectPath);
    const rawSetting = projectConfig?.codeWorkspaceSyncPath?.trim();
    if (!rawSetting) {
      return;
    }

    // Relative settings resolve against the project root; `~` is expanded.
    const codeWorkspacePath = path.resolve(normalizedProjectPath, expandTilde(rawSetting));
    if (!codeWorkspacePath.endsWith(CODE_WORKSPACE_EXTENSION)) {
      // We read-modify-write this file, so never target arbitrary files.
      log.warn("Skipping .code-workspace sync: path must end with .code-workspace", {
        codeWorkspacePath,
      });
      return;
    }

    const projectName = getProjectName(normalizedProjectPath);
    const { desiredPaths, managedRootDirs } = computeManagedWorktreePaths({
      allMetadata: await config.getAllWorkspaceMetadata(),
      projectPath: normalizedProjectPath,
      projectName,
      defaultManagedRootDir: path.join(expandTilde(config.srcDir), projectName),
    });
    await updateCodeWorkspaceFile({
      codeWorkspacePath,
      managedRootDirs,
      desiredPaths,
      seedFolders: [normalizedProjectPath, ...desiredPaths],
    });
  } catch (error) {
    log.warn("Failed to sync .code-workspace file", { projectPath, error });
  }
}
