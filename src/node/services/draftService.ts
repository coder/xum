import { createHash } from "crypto";
import { EventEmitter } from "events";
import * as fs from "fs/promises";
import * as path from "path";
import assert from "@/common/utils/assert";
import type { Config } from "@/node/config";
import writeFileAtomic from "@/node/utils/writeFileAtomic";
import { log } from "@/node/services/log";
import { withTargetMutationLock } from "@/node/services/refinement/targetMutationLocks";
import { isWorkspaceRemovalTombstoned } from "@/node/services/workspaceRemoval";
import { hasErrorCode } from "@/node/services/tools/skillFileUtils";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import { DRAFT_ID_PATTERN, MAX_DRAFT_JSON_BYTES } from "@/constants/drafts";
import type {
  Draft,
  DraftEvent,
  DraftGetOutput,
  DraftImportLegacyOutput,
  DraftScope,
  DraftSummary,
  DraftUpdateInput,
} from "@/common/orpc/schemas/drafts";
import {
  createEmptyDraft,
  draftJsonBytes,
  draftScopeKey,
  draftTooLargeMessage,
  isDraftEmpty,
  sanitizeDraft,
  stripStagedDraftAttachments,
  summarizeDraft,
} from "@/common/utils/drafts";

/**
 * Composer drafts (text + attachments) persisted on the backend.
 *
 * They used to live in renderer localStorage, where base64 attachment payloads exhausted the
 * origin quota (QuotaExceededError on `input:<workspaceId>`). The backend also shares one copy
 * between every client of a server (Electron window, browser tabs), which per-origin localStorage
 * could not.
 *
 * - Workspace drafts: `<sessionDir>/draft.json`. The session dir gives the lifecycle for free:
 *   removal deletes it, rename keeps the workspace ID, and fork copies the draft through
 *   copyWorkspaceDraftForFork (staged attachments stripped).
 * - Creation drafts ("new workspace" composer): `<xumRoot>/drafts/<projectHash>/<draftId>.json`,
 *   storing projectPath inside the file. Deleted by `delete`, by project removal
 *   (deleteProjectDrafts) and by the startup GC (collectOrphanedCreationDrafts).
 */
const DRAFT_FILE_NAME = "draft.json";
const CREATION_DRAFTS_DIR_NAME = "drafts";
const DRAFT_FILE_VERSION = 1;

type WorkspaceScope = Extract<DraftScope, { kind: "workspace" }>;
type CreationScope = Extract<DraftScope, { kind: "creation" }>;

interface IndexEntry {
  summary: DraftSummary;
  filePath: string;
}

/** Thrown for a scope whose id would resolve outside its storage dir. */
class InvalidDraftScopeError extends Error {}

/** Short, filesystem-safe directory name for a project's creation drafts. */
function projectDraftsDirName(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
}

export class DraftService extends EventEmitter {
  static readonly CHANGE_EVENT = "change";

  private readonly config: Config;
  private readonly creationRoot: string;
  /**
   * In-memory per-scope revision, bumped on every persisted change. Scopes start at the process
   * start time, so a restarted backend does not regress below the previous process's revisions
   * in practice (writes are far rarer than one per millisecond).
   */
  private readonly revisions = new Map<string, number>();
  private readonly initialRevision = Date.now();
  /**
   * Metadata (text + attachment metadata, no payloads) of every draft, so bulk hydration does not
   * re-read multi-MB files. Filled lazily by the first list(); writes keep it current.
   */
  private readonly index = new Map<string, IndexEntry>();
  private indexLoad: Promise<void> | null = null;
  /** Keys written while a scan runs: the scan must not overwrite them with what it read. */
  private scanTouched: Set<string> | null = null;

  constructor(config: Config) {
    super();
    this.config = config;
    this.creationRoot = path.join(config.rootDir, CREATION_DRAFTS_DIR_NAME);
  }

  /** Every draft as metadata (no attachment payloads). */
  async list(): Promise<DraftSummary[]> {
    await this.ensureIndex();
    const summaries: DraftSummary[] = [];
    for (const [key, entry] of [...this.index]) {
      // Session dirs are deleted by workspace removal without telling this service; drop entries
      // whose file is gone so removed workspaces do not linger in hydration.
      try {
        await fs.access(entry.filePath);
      } catch (error) {
        if (hasErrorCode(error, "ENOENT") && this.index.get(key) === entry) {
          this.index.delete(key);
          continue;
        }
      }
      summaries.push(entry.summary);
    }
    return summaries;
  }

  /** Full draft including attachment payloads; empty for a scope without a draft. */
  async get(scope: DraftScope): Promise<DraftGetOutput> {
    const key = draftScopeKey(scope);
    // Revision BEFORE the file: a write landing in between leaves content newer than its
    // revision (harmless), never an old file labelled with the new write's revision.
    const revision = this.getRevision(key);
    // No lock: writes are atomic renames, so a read sees either the old or the new file.
    const draft = (await this.load(scope)) ?? createEmptyDraft();
    return { ...draft, revision };
  }

  /**
   * Partial update: omitted fields keep their stored value. A draft that ends up empty is
   * deleted. A write for a scope without an owner (unregistered workspace, unconfigured project)
   * is skipped and returns the current revision.
   */
  async update(input: DraftUpdateInput): Promise<{ revision: number }> {
    const { scope } = input;
    const filePath = this.filePathFor(scope);
    return this.withWriteLock(scope, async () => {
      const current = (await this.load(scope)) ?? createEmptyDraft();
      const next: Draft = {
        text: input.text ?? current.text,
        attachments: input.attachments ?? current.attachments,
      };
      const bytes = draftJsonBytes(next);
      if (bytes > MAX_DRAFT_JSON_BYTES) {
        throw new Error(draftTooLargeMessage(bytes));
      }
      if (!(await this.hasOwner(scope))) {
        return { revision: this.getRevision(draftScopeKey(scope)) };
      }
      return { revision: await this.persist(scope, filePath, next) };
    });
  }

  /** Delete a draft. No owner check: removing data is always allowed. */
  async delete(scope: DraftScope): Promise<{ revision: number }> {
    const filePath = this.filePathFor(scope);
    return this.withWriteLock(scope, async () => ({
      revision: await this.persist(scope, filePath, createEmptyDraft()),
    }));
  }

  /**
   * Non-clobbering one-way migration of a legacy localStorage draft: stored only when the backend
   * has no draft for the scope. localStorage is per origin (desktop app vs browser tab) while this
   * store is shared, so another origin may already have imported (or since edited) this scope.
   */
  async importLegacy(input: DraftUpdateInput): Promise<DraftImportLegacyOutput> {
    const { scope } = input;
    let filePath: string;
    try {
      filePath = this.filePathFor(scope);
    } catch (error) {
      if (error instanceof InvalidDraftScopeError) {
        return { result: "orphaned", revision: this.initialRevision };
      }
      throw error;
    }
    // Sanitize with the file loader's rules: the client drops malformed entries too, but this is
    // untrusted input and must never write a file the loader would reject.
    const legacy = sanitizeDraft({
      text: input.text ?? "",
      attachments: input.attachments ?? [],
    }).draft;
    const bytes = draftJsonBytes(legacy);
    if (bytes > MAX_DRAFT_JSON_BYTES) {
      throw new Error(draftTooLargeMessage(bytes));
    }
    return this.withWriteLock(scope, async () => {
      const key = draftScopeKey(scope);
      const current = await this.load(scope);
      if (current !== null && !isDraftEmpty(current)) {
        return { result: "present", revision: this.getRevision(key) };
      }
      if (!(await this.hasOwner(scope))) {
        return { result: "orphaned", revision: this.getRevision(key) };
      }
      if (isDraftEmpty(legacy)) {
        return { result: "applied", revision: this.getRevision(key) };
      }
      return { result: "applied", revision: await this.persist(scope, filePath, legacy) };
    });
  }

  /**
   * Copy a workspace draft into a fork's session dir. Staged attachments point at files in the
   * source worktree, which the fork does not share, so they are dropped. Runs while the fork is
   * being set up, before the new workspace is registered, so no owner check applies.
   */
  async copyWorkspaceDraftForFork(
    sourceWorkspaceId: string,
    newWorkspaceId: string
  ): Promise<void> {
    const source: WorkspaceScope = { kind: "workspace", workspaceId: sourceWorkspaceId };
    const target: WorkspaceScope = { kind: "workspace", workspaceId: newWorkspaceId };
    const draft = await this.load(source);
    if (draft === null) return;
    const forked: Draft = { ...draft, attachments: stripStagedDraftAttachments(draft.attachments) };
    if (isDraftEmpty(forked)) return;
    const filePath = this.filePathFor(target);
    await this.withWriteLock(target, () => this.persist(target, filePath, forked));
  }

  /**
   * Delete every creation draft of a removed project (server-side, not only in a renderer). The
   * whole hashed dir goes, so unparseable files (which name no project) do not outlive it.
   */
  async deleteProjectDrafts(projectPath: string): Promise<void> {
    assert(projectPath.length > 0, "DraftService.deleteProjectDrafts requires a projectPath");
    const dirName = projectDraftsDirName(projectPath);
    const projectDir = path.join(this.creationRoot, dirName);
    await withTargetMutationLock(this.config.rootDir, projectDir, async () => {
      // The same recheck as the GC: this runs after the removal's config write, so the path may
      // be registered again (with a new creation draft) by now; its drafts are owned again.
      if (this.configuredProjectDirNames().has(dirName)) return;
      await this.clearProjectDir(projectDir);
    });
  }

  /**
   * Startup GC: delete the drafts dirs of projects that are no longer configured (e.g. removed
   * while this build was not running), including files too broken to name their project. The
   * scratch pseudo-project is always kept: it is only added to the config when its first workspace
   * is created. Best-effort; never throws.
   */
  async collectOrphanedCreationDrafts(): Promise<void> {
    try {
      for (const dirName of await readDirNames(this.creationRoot, { dirsOnly: true })) {
        if (this.configuredProjectDirNames().has(dirName)) continue;
        const projectDir = path.join(this.creationRoot, dirName);
        await withTargetMutationLock(this.config.rootDir, projectDir, async () => {
          // Re-check under the lock creation-draft writes take: a project re-added since the
          // check above (e.g. while an earlier dir was being deleted) keeps its new drafts.
          if (this.configuredProjectDirNames().has(dirName)) return;
          await this.clearProjectDir(projectDir);
        });
      }
    } catch (error) {
      log.warn("Failed to collect orphaned creation drafts", { error });
    }
  }

  /** The event a new subscription starts with. */
  async getSnapshotEvent(): Promise<Extract<DraftEvent, { type: "snapshot" }>> {
    return { type: "snapshot", drafts: await this.list() };
  }

  private getRevision(key: string): number {
    return this.revisions.get(key) ?? this.initialRevision;
  }

  private filePathFor(scope: DraftScope): string {
    if (scope.kind === "workspace") {
      assert(scope.workspaceId.length > 0, "Draft scope requires a workspaceId");
      const sessionDir = path.join(this.config.sessionsDir, scope.workspaceId);
      // IDs arrive over the API and must not reach other paths (e.g. `../x`).
      if (path.dirname(path.resolve(sessionDir)) !== path.resolve(this.config.sessionsDir)) {
        throw new InvalidDraftScopeError(
          `Invalid workspace id for a draft: ${JSON.stringify(scope.workspaceId)}`
        );
      }
      return path.join(sessionDir, DRAFT_FILE_NAME);
    }
    // The schema validates draftId too; re-check because the service is also called directly.
    if (!DRAFT_ID_PATTERN.test(scope.draftId) || scope.projectPath.length === 0) {
      throw new InvalidDraftScopeError(`Invalid creation draft scope: ${JSON.stringify(scope)}`);
    }
    return path.join(
      this.creationRoot,
      projectDraftsDirName(scope.projectPath),
      `${scope.draftId}.json`
    );
  }

  /**
   * Missing file: null. Unparseable or malformed: self-heal (empty or sanitized, with a warning).
   * Any other read failure (EACCES, EIO, EISDIR...) throws: treating it as empty would let the
   * next write replace data that exists but could not be read, while a rejection makes the
   * client keep its change and retry.
   */
  private async load(scope: DraftScope): Promise<Draft | null> {
    const filePath = this.filePathFor(scope);
    let text: string;
    try {
      text = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return null;
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      log.warn(`Ignoring unparseable draft file ${filePath}`, { error });
      return createEmptyDraft();
    }
    if (
      scope.kind === "creation" &&
      (raw as { projectPath?: unknown } | null)?.projectPath !== scope.projectPath
    ) {
      // A hash collision (or a hand-moved file) belongs to another project: not this draft.
      log.warn(`Ignoring creation draft file for another project ${filePath}`);
      return null;
    }
    const { draft, droppedEntries } = sanitizeDraft(raw);
    if (droppedEntries > 0) {
      log.warn(`Dropped malformed entries from draft file ${filePath}`, { droppedEntries });
    }
    return draft;
  }

  /**
   * Serialize a read-modify-write per storage dir on the target mutation lock (in-process mutex +
   * cross-process file lock). For workspace drafts it is the lock workspace removal holds while it
   * publishes its tombstone and deletes the session dir (like ReviewState/DevTools writers).
   */
  private withWriteLock<T>(scope: DraftScope, fn: () => Promise<T>): Promise<T> {
    return withTargetMutationLock(this.config.rootDir, path.dirname(this.filePathFor(scope)), fn);
  }

  /**
   * Whether a write may create the draft. Refuses (throws) for a workspace being removed: the
   * tombstone probe fails closed and a removal can roll back, so the client keeps its change and
   * retries. Config reads are strict (an unreadable config throws) for the same reason; only a
   * conclusive "not registered" returns false.
   */
  private async hasOwner(scope: DraftScope): Promise<boolean> {
    if (scope.kind === "workspace") {
      if (await isWorkspaceRemovalTombstoned(this.config.rootDir, scope.workspaceId)) {
        throw new Error(`Draft write refused: workspace ${scope.workspaceId} is being removed`);
      }
      return this.config.findWorkspace(scope.workspaceId, { throwOnError: true }) != null;
    }
    if (scope.projectPath === SCRATCH_PROJECT_CONFIG_KEY) return true;
    return this.config.loadConfigOrDefault({ throwOnError: true }).projects.has(scope.projectPath);
  }

  /**
   * Write (or delete, for an empty draft) under withWriteLock, update the index and notify
   * subscribers. Returns the new revision, or the current one when nothing changed.
   */
  private async persist(scope: DraftScope, filePath: string, draft: Draft): Promise<number> {
    const key = draftScopeKey(scope);
    // A running scan skips keys written meanwhile (the write's entry is newer), so a key is marked
    // only once its write landed: a failed write must not hide the draft still on disk.
    if (isDraftEmpty(draft)) {
      let existed = true;
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw error;
        existed = false;
      }
      this.scanTouched?.add(key);
      if (!existed && !this.index.has(key)) return this.getRevision(key);
      const revision = this.bumpRevision(key);
      this.index.delete(key);
      const event: DraftEvent = { type: "deleted", scope, revision };
      this.emit(DraftService.CHANGE_EVENT, event);
      return revision;
    }
    const file =
      scope.kind === "creation"
        ? { version: DRAFT_FILE_VERSION, projectPath: scope.projectPath, draftId: scope.draftId }
        : { version: DRAFT_FILE_VERSION };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writeFileAtomic(filePath, JSON.stringify({ ...file, ...draft }));
    this.scanTouched?.add(key);
    const revision = this.bumpRevision(key);
    const summary = summarizeDraft(scope, draft, revision);
    this.index.set(key, { summary, filePath });
    const event: DraftEvent = { type: "changed", ...summary };
    this.emit(DraftService.CHANGE_EVENT, event);
    return revision;
  }

  private bumpRevision(key: string): number {
    const revision = this.getRevision(key) + 1;
    this.revisions.set(key, revision);
    return revision;
  }

  private ensureIndex(): Promise<void> {
    this.indexLoad ??= this.scanIndex().catch((error: unknown) => {
      // Retry on the next list instead of caching the failure.
      this.indexLoad = null;
      throw error;
    });
    return this.indexLoad;
  }

  /** Read every draft file once. Keys written meanwhile keep the write's (newer) entry. */
  private async scanIndex(): Promise<void> {
    const touched = new Set<string>();
    this.scanTouched = touched;
    try {
      const found = new Map<string, IndexEntry>();
      const add = (scope: DraftScope, filePath: string, draft: Draft | null) => {
        if (draft === null || isDraftEmpty(draft)) return;
        const key = draftScopeKey(scope);
        found.set(key, { summary: summarizeDraft(scope, draft, this.getRevision(key)), filePath });
      };

      for (const workspaceId of await readDirNames(this.config.sessionsDir, { dirsOnly: true })) {
        const scope: WorkspaceScope = { kind: "workspace", workspaceId };
        try {
          add(scope, this.filePathFor(scope), await this.load(scope));
        } catch (error) {
          // One unreadable file must not hide every other draft; a write to it still fails.
          log.warn(`Skipping unreadable draft for workspace ${workspaceId}`, { error });
        }
      }
      for (const dirName of await readDirNames(this.creationRoot, { dirsOnly: true })) {
        // One file at a time: only its metadata is kept, so near-limit payloads never pile up.
        for await (const file of this.readCreationDraftFiles(
          path.join(this.creationRoot, dirName)
        )) {
          add(file.scope, file.filePath, file.draft);
        }
      }

      for (const [key, entry] of found) {
        if (!touched.has(key)) this.index.set(key, entry);
      }
    } finally {
      this.scanTouched = null;
    }
  }

  /**
   * The well-formed creation draft files of one project dir, read one at a time (unreadable ones
   * are skipped).
   */
  private async *readCreationDraftFiles(projectDir: string): AsyncGenerator<{
    scope: CreationScope;
    projectPath: string;
    draftId: string;
    filePath: string;
    draft: Draft | null;
  }> {
    for (const name of await readDirNames(projectDir)) {
      if (!name.endsWith(".json")) continue;
      const filePath = path.join(projectDir, name);
      let raw: unknown;
      try {
        raw = JSON.parse(await fs.readFile(filePath, "utf-8"));
      } catch (error) {
        log.warn(`Skipping unreadable creation draft file ${filePath}`, { error });
        continue;
      }
      const record = raw as { projectPath?: unknown; draftId?: unknown } | null;
      const projectPath = record?.projectPath;
      const draftId = record?.draftId;
      if (
        typeof projectPath !== "string" ||
        projectPath.length === 0 ||
        typeof draftId !== "string" ||
        `${draftId}.json` !== name ||
        !DRAFT_ID_PATTERN.test(draftId) ||
        projectDraftsDirName(projectPath) !== path.basename(projectDir)
      ) {
        log.warn(`Skipping malformed creation draft file ${filePath}`);
        continue;
      }
      const { draft, droppedEntries } = sanitizeDraft(raw);
      if (droppedEntries > 0) {
        log.warn(`Dropped malformed entries from draft file ${filePath}`, { droppedEntries });
      }
      yield {
        scope: { kind: "creation" as const, projectPath, draftId },
        projectPath,
        draftId,
        filePath,
        draft,
      };
    }
  }

  /** Hashed dir names of the configured projects plus scratch. */
  private configuredProjectDirNames(): Set<string> {
    // Strict: an unreadable config must never be mistaken for "no projects".
    const projects = this.config.loadConfigOrDefault({ throwOnError: true }).projects;
    const names = new Set([projectDraftsDirName(SCRATCH_PROJECT_CONFIG_KEY)]);
    for (const projectPath of projects.keys()) names.add(projectDraftsDirName(projectPath));
    return names;
  }

  /**
   * Under the dir's write lock: delete its drafts (index entries and well-formed files, so
   * subscribers see each deletion), then the whole dir with any unparseable or temp files.
   */
  private async clearProjectDir(projectDir: string): Promise<void> {
    const scopes = new Map<string, CreationScope>();
    for (const [key, entry] of this.index) {
      const scope = entry.summary.scope;
      if (scope.kind === "creation" && path.dirname(entry.filePath) === projectDir) {
        scopes.set(key, scope);
      }
    }
    for await (const file of this.readCreationDraftFiles(projectDir)) {
      scopes.set(draftScopeKey(file.scope), file.scope);
    }
    for (const scope of scopes.values()) {
      await this.persist(scope, this.filePathFor(scope), createEmptyDraft());
    }
    await fs.rm(projectDir, { recursive: true, force: true });
  }
}

/** Entry names of a directory; empty when it does not exist. */
async function readDirNames(dir: string, options?: { dirsOnly: boolean }): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => options?.dirsOnly !== true || entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
}
