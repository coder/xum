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
import {
  DEFAULT_CREATION_DRAFT_ID,
  DRAFT_ID_PATTERN,
  MAX_DRAFT_JSON_BYTES,
} from "@/constants/drafts";
import {
  DraftListEntrySchema,
  type Draft,
  type DraftEvent,
  type DraftGetOutput,
  type DraftImportLegacyOutput,
  type DraftList,
  type DraftListEntry,
  type DraftScope,
  type DraftSummary,
  type DraftUpdateInput,
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
 * - The creation draft list (sidebar rows, including empty drafts): `<xumRoot>/drafts/list.json`.
 *   Only `delete`, putListEntry, importLegacyList, project removal and the GC change it; clearing a
 *   draft's text never delists it. `delete` removes the body, then the entry, under the body lock
 *   (the only nesting: body lock, then list lock). A crash in between leaves an empty listed row,
 *   never an unlisted body.
 */
const DRAFT_FILE_NAME = "draft.json";
const CREATION_DRAFTS_DIR_NAME = "drafts";
const DRAFT_FILE_VERSION = 1;
const LIST_FILE_NAME = "list.json";
const LIST_FILE_VERSION = 1;

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
  private listRevision = this.initialRevision;
  /**
   * Metadata (text + attachment metadata, no payloads) of every draft, so bulk hydration does not
   * re-read multi-MB files. Filled lazily by the first list(); writes keep it current.
   */
  private readonly index = new Map<string, IndexEntry>();
  private indexLoad: Promise<void> | null = null;
  /** Keys written while a scan runs: the scan must not overwrite them with what it read. */
  private scanTouched: Set<string> | null = null;

  private readonly listFile: string;

  constructor(config: Config) {
    super();
    this.config = config;
    this.creationRoot = path.join(config.rootDir, CREATION_DRAFTS_DIR_NAME);
    this.listFile = path.join(this.creationRoot, LIST_FILE_NAME);
  }

  /**
   * The creation draft list, read from disk every time: it is small, and a sibling backend on the
   * same root may have changed it (no lock: writes are atomic renames).
   */
  async getList(options?: { strict?: boolean }): Promise<DraftList> {
    const { entries, state } = await this.readListFile();
    // Strict readers (the renderer's storage GC) must never mistake a damaged list for the truth.
    if (options?.strict === true && state === "damaged") {
      throw new Error(`Creation draft list ${this.listFile} is damaged`);
    }
    return { entries, revision: this.listRevision };
  }

  /**
   * List a creation draft, or update a listed draft's sub-project (its createdAt is kept). Skipped
   * for a project without an owner (like `update`) and for the default draft, which is never
   * listed. Returns the list revision.
   */
  async putListEntry(entry: DraftListEntry): Promise<{ revision: number }> {
    assert(DRAFT_ID_PATTERN.test(entry.draftId), "putListEntry requires a valid draftId");
    const scope: CreationScope = { kind: "creation", ...entry };
    if (entry.draftId === DEFAULT_CREATION_DRAFT_ID) return { revision: this.listRevision };
    return {
      revision: await this.mutateList(async (entries) => {
        // Under the list lock, so a project removal's cleanup cannot run in between.
        if (!(await this.hasOwner(scope))) return null;
        const index = entries.findIndex((listed) => isSameListEntry(listed, entry));
        if (index === -1) return [...entries, entry];
        if (entries[index].subProjectPath === entry.subProjectPath) return null;
        const next = [...entries];
        next[index] = { ...entries[index], subProjectPath: entry.subProjectPath };
        return next;
      }),
    };
  }

  /**
   * One-way import of a renderer's legacy localStorage list: adds only entries the list lacks
   * (another origin may have imported or edited them already) and skips unowned projects. The
   * first import (no list.json yet) also lists every non-empty creation draft body without an
   * entry: the legacy list dropped newer entries once it outgrew its localStorage budget (#5225),
   * leaving their bodies unreachable. Returns the list revision.
   */
  async importLegacyList(legacy: DraftListEntry[]): Promise<{ revision: number }> {
    return {
      revision: await this.mutateList(async (entries, exists) => {
        // Under the list lock, so a project removal's cleanup cannot run in between.
        const configured = this.configuredProjectDirNames();
        const next = [...entries];
        for (const entry of legacy) {
          const owned =
            entry.projectPath === SCRATCH_PROJECT_CONFIG_KEY ||
            configured.has(projectDraftsDirName(entry.projectPath));
          if (
            owned &&
            entry.draftId !== DEFAULT_CREATION_DRAFT_ID &&
            !next.some((listed) => isSameListEntry(listed, entry))
          ) {
            next.push(entry);
          }
        }
        // Every import also lists owned bodies without a row: origins migrate at different times,
        // and an origin's legacy bodies can be imported after another origin created the list.
        next.push(...(await this.findUnlistedCreationDrafts(next)));
        return exists && next.length === entries.length ? null : next;
      }),
    };
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

  /**
   * Delete a draft; a creation draft is also delisted (after its body, see the class comment).
   * No owner check: removing data is always allowed.
   */
  async delete(scope: DraftScope): Promise<{ revision: number }> {
    const filePath = this.filePathFor(scope);
    return this.withWriteLock(scope, async () => {
      const revision = await this.persist(scope, filePath, createEmptyDraft());
      // Delisted under the body lock too (body lock, then list lock; nothing takes them in the
      // other order), so no write can recreate the body between the two steps.
      if (scope.kind === "creation") {
        await this.mutateList((entries) => {
          const next = entries.filter((listed) => !isSameListEntry(listed, scope));
          return next.length === entries.length ? null : next;
        });
      }
      return { revision };
    });
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
      // Delisted under the same lock (dir lock, then list lock, as in `delete`): once the bodies
      // are gone the rows go too, even if the path is registered again right after.
      await this.mutateList((entries) => {
        const next = entries.filter((entry) => entry.projectPath !== projectPath);
        return next.length === entries.length ? null : next;
      });
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
      // Empty listed drafts have no body, hence no dir: collect their entries separately.
      await this.removeUnownedListEntries();
    } catch (error) {
      log.warn("Failed to collect orphaned creation drafts", { error });
    }
  }

  /** The event a new subscription starts with. */
  async getSnapshotEvent(): Promise<Extract<DraftEvent, { type: "snapshot" }>> {
    let list: DraftList;
    try {
      list = await this.getList();
    } catch (error) {
      // An unreadable list file (EACCES, EISDIR...) must not block every draft body: the list
      // shows empty until it is readable again (writes to it keep failing and are retried).
      log.warn("Failed to read the creation draft list", { error });
      list = { entries: [], revision: this.listRevision };
    }
    return { type: "snapshot", drafts: await this.list(), list };
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

  /**
   * "missing": no list.json yet. "damaged": unparseable, a malformed structure or dropped malformed
   * entries (the valid entries are kept, with a warning); the next mutation rebuilds it (see
   * mutateList). Other read failures throw, so a write never replaces a list it could not read.
   */
  private async readListFile(): Promise<{
    entries: DraftListEntry[];
    state: "ok" | "missing" | "damaged";
    /** Written by a newer version: readable, but never rewritten by this one. */
    newer: boolean;
  }> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.listFile, "utf-8"));
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return { entries: [], state: "missing", newer: false };
      if (!(error instanceof SyntaxError)) throw error;
      log.warn(`Rebuilding unparseable creation draft list ${this.listFile}`, { error });
      return { entries: [], state: "damaged", newer: false };
    }
    const file = (raw ?? {}) as { version?: unknown; entries?: unknown };
    const newer = typeof file.version === "number" && file.version > LIST_FILE_VERSION;
    const rawEntries = file.entries;
    const entries: DraftListEntry[] = [];
    for (const rawEntry of Array.isArray(rawEntries) ? rawEntries : []) {
      const parsed = DraftListEntrySchema.safeParse(rawEntry);
      if (parsed.success) entries.push(parsed.data);
    }
    const intact = Array.isArray(rawEntries) && entries.length === rawEntries.length;
    if (!intact && !newer) log.warn(`Rebuilding malformed creation draft list ${this.listFile}`);
    return { entries, state: intact ? "ok" : "damaged", newer };
  }

  /**
   * Read-modify-write list.json under its own lock (taken inside a body lock only by `delete`,
   * never the other way round). `change` returns the new entries, or null for no change. Writing a
   * missing list, and every mutation of a damaged one (even a no-op), also lists each owned,
   * non-empty creation body without an entry. A missing list is not created by a no-op: on
   * upgrade the startup GC runs before the renderer's legacy import, whose sub-projects must win.
   * Returns the (new) list revision.
   */
  private mutateList(
    change: (
      entries: DraftListEntry[],
      exists: boolean
    ) => DraftListEntry[] | null | Promise<DraftListEntry[] | null>
  ): Promise<number> {
    return withTargetMutationLock(this.config.rootDir, this.listFile, async () => {
      const { entries, state, newer } = await this.readListFile();
      if (newer) {
        // A downgrade: rewriting a newer version's file would silently drop or contradict its
        // data. Refuse; clients keep their change and retry, and the next upgrade can write it.
        throw new Error(`Creation draft list ${this.listFile} was written by a newer version`);
      }
      let next = await change(entries, state === "ok");
      if (next === null && state !== "damaged") return this.listRevision;
      next ??= entries;
      if (state !== "ok") next = [...next, ...(await this.findUnlistedCreationDrafts(next))];
      await fs.mkdir(this.creationRoot, { recursive: true });
      await writeFileAtomic(
        this.listFile,
        JSON.stringify({ version: LIST_FILE_VERSION, entries: next })
      );
      this.listRevision++;
      const event: DraftEvent = { type: "list", entries: next, revision: this.listRevision };
      this.emit(DraftService.CHANGE_EVENT, event);
      return this.listRevision;
    });
  }

  /** Drop the entries of projects that are no longer configured (scratch is always owned). */
  private async removeUnownedListEntries(): Promise<void> {
    await this.mutateList((entries) => {
      const owned = this.configuredProjectDirNames();
      const next = entries.filter(
        (entry) =>
          entry.projectPath === SCRATCH_PROJECT_CONFIG_KEY ||
          owned.has(projectDraftsDirName(entry.projectPath))
      );
      return next.length === entries.length ? null : next;
    });
  }

  /**
   * Non-empty creation draft bodies of owned projects without a list entry (never the default
   * draft), oldest first.
   */
  private async findUnlistedCreationDrafts(listed: DraftListEntry[]): Promise<DraftListEntry[]> {
    await this.ensureIndex();
    const owned = this.configuredProjectDirNames();
    const found: DraftListEntry[] = [];
    for (const { summary, filePath } of [...this.index.values()]) {
      const scope = summary.scope;
      if (scope.kind !== "creation" || scope.draftId === DEFAULT_CREATION_DRAFT_ID) continue;
      if (!owned.has(projectDraftsDirName(scope.projectPath))) continue;
      if (listed.some((entry) => isSameListEntry(entry, scope))) continue;
      let createdAt: number;
      try {
        createdAt = (await fs.stat(filePath)).mtimeMs;
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) continue;
        throw error;
      }
      found.push({
        projectPath: scope.projectPath,
        draftId: scope.draftId,
        subProjectPath: null,
        createdAt,
      });
    }
    return found.sort((a, b) => a.createdAt - b.createdAt);
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

function isSameListEntry(
  a: { projectPath: string; draftId: string },
  b: { projectPath: string; draftId: string }
): boolean {
  return a.projectPath === b.projectPath && a.draftId === b.draftId;
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
