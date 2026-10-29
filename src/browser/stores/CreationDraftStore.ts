import { useSyncExternalStore } from "react";
import type { APIClient } from "@/browser/contexts/API";
import {
  listPersistedKeys,
  readPersistedState,
  readPersistedString,
  updatePersistedState,
} from "@/browser/hooks/usePersistedState";
import { getUserPreferences } from "@/browser/stores/AppConfigStore";
import { retryDelayMs } from "@/browser/stores/DraftStore";
import { deleteWorkspaceStorage } from "@/browser/utils/workspaceStorage";
import {
  getDraftScopeId,
  getInputAttachmentsKey,
  getInputKey,
  getPendingScopeId,
  getWorkspaceNameStateKey,
  WORKSPACE_DRAFTS_BY_PROJECT_KEY,
} from "@/common/constants/storage";
import type {
  CreationDraft,
  CreationDraftExecution,
  CreationDraftSummary,
} from "@/common/orpc/schemas/drafts";
import { coerceThinkingLevel } from "@/common/types/thinking";
import { getErrorMessage } from "@/common/utils/errors";
import {
  createDraftId,
  sanitizeDraftAttachments,
  summarizeCreationDraft,
} from "@/common/utils/drafts";
import {
  CREATION_DRAFT_NAME_MAX_CHARS,
  DEFAULT_CREATION_DRAFT_ID,
  DRAFT_ID_PATTERN,
  DRAFT_STORE_READY_TIMEOUT_MS,
} from "@/constants/drafts";

/**
 * Creation drafts ("new workspace" composer), one backend record each (CreationDraftService).
 * The draft id is the identity: changing the project is an ordinary update of the same draft.
 *
 * One active editor per draft is the contract. There is deliberately no subscription, revision
 * or tombstone: another window's changes show after a reload, concurrent saves of one field are
 * last-write-wins, and Send/Delete in one window can remove another window's unsent edits.
 */
export type CreationDraftLoad =
  | { status: "loading" }
  | { status: "loadFailed"; message: string }
  | { status: "ready" };

export interface CreationDraftView {
  load: CreationDraftLoad;
  /** Null until loaded. */
  draft: CreationDraft | null;
  /** Local changes the backend has not confirmed (Send waits for them). */
  unsaved: boolean;
  saveError: string | null;
}

export type CreationDraftPatch = Partial<Omit<CreationDraft, "id">>;

export interface CreationDraftListState {
  /** A failed list counts as ready with no rows (logged; retried on reconnect). */
  status: "loading" | "ready";
}

interface Entry {
  draft: CreationDraft | null;
  /** Where a blank draft goes when the read finds no record. */
  blank: { projectPath: string; subProjectPath: string | null };
  load: CreationDraftLoad;
  /** Whether the backend holds a record: until then, a save sends every field (a create). */
  persisted: boolean;
  /** A failed save may still have written the record (its reply was lost), so a clear saves too. */
  maybeSaved: boolean;
  /**
   * The record as this window last knew it (read, or sent in a save that landed or may have). A
   * delete retry removes the record only while it still holds this (F202).
   */
  stored: CreationDraft | null;
  /** Changed fields not sent yet. */
  pending: CreationDraftPatch;
  /** Never rejects (save records its error). */
  inFlight: Promise<void> | null;
  saving: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  saveError: string | null;
  view: CreationDraftView;
}

const SAVE_DEBOUNCE_MS = 300;
const NO_EXECUTION_CHOICES: CreationDraftExecution = {
  agent: null,
  runtime: null,
  trunkBranch: null,
};
const LOADING_VIEW: CreationDraftView = {
  load: { status: "loading" },
  draft: null,
  unsaved: false,
  saveError: null,
};

/** Project defaults only seed a new draft; afterwards the draft owns its choices. */
function seedAi(projectPath: string): CreationDraft["ai"] {
  const { projectDefaults, globalDefaults } = getUserPreferences().ai ?? {};
  const project = projectDefaults?.[projectPath] ?? {};
  return {
    model: project.model?.trim() ? project.model : undefined,
    thinkingLevel: coerceThinkingLevel(project.thinkingLevel ?? globalDefaults?.thinkingLevel),
  };
}

/**
 * What the user wrote: text, an attachment or a workspace name. A draft with none of it is not
 * saved, so New and an untouched composer add no sidebar row (AI and runtime picks wait in memory).
 */
function hasCreationDraftContent(draft: CreationDraft): boolean {
  return (
    draft.text.trim().length > 0 ||
    draft.attachments.length > 0 ||
    draft.manualName.trim().length > 0
  );
}

/**
 * The backend refused the save and wrote nothing. The router sends every creation draft refusal
 * (too large, unregistered project, deleted draft, invalid fields) as BAD_REQUEST.
 */
function isSaveRefusal(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === "BAD_REQUEST";
}

/** Changes the backend has not got yet that are due to be saved. */
function hasChangesToSave(entry: Entry): boolean {
  if (!entry.draft || Object.keys(entry.pending).length === 0) return false;
  return entry.persisted || entry.maybeSaved || hasCreationDraftContent(entry.draft);
}

export function createBlankCreationDraft(
  id: string,
  projectPath: string,
  subProjectPath: string | null
): CreationDraft {
  return {
    id,
    projectPath,
    subProjectPath,
    createdAt: Date.now(),
    text: "",
    attachments: [],
    manualName: "",
    ai: seedAi(projectPath),
    intent: {},
    auto: {},
    execution: null,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The draft did not load in time.")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(getErrorMessage(error)));
      }
    );
  });
}

/** An old renderer creation scope id: `__draft__/<project>/<id>` or `__pending__<project>`. */
function parseLegacyScope(scopeId: string): { projectPath: string; legacyDraftId: string } | null {
  const pendingPrefix = getPendingScopeId("");
  if (scopeId.startsWith(pendingPrefix)) {
    const projectPath = scopeId.slice(pendingPrefix.length);
    return projectPath.length > 0
      ? { projectPath, legacyDraftId: DEFAULT_CREATION_DRAFT_ID }
      : null;
  }
  const draftPrefix = getDraftScopeId("", "").slice(0, -1);
  if (!scopeId.startsWith(draftPrefix)) return null;
  const rest = scopeId.slice(draftPrefix.length);
  const separator = rest.lastIndexOf("/");
  const legacyDraftId = rest.slice(separator + 1);
  return separator > 0 && DRAFT_ID_PATTERN.test(legacyDraftId)
    ? { projectPath: rest.slice(0, separator), legacyDraftId }
    : null;
}

/** Scope ids of every old creation composer that left text, attachments or a typed name. */
function legacyScopeIds(): Set<string> {
  const scopeIds = new Set<string>();
  for (const prefix of [
    getInputKey(""),
    getInputAttachmentsKey(""),
    getWorkspaceNameStateKey(""),
  ]) {
    for (const key of listPersistedKeys(prefix)) scopeIds.add(key.slice(prefix.length));
  }
  return scopeIds;
}

/** An old composer's content (a generated name is a preview: discarded). */
function readLegacyContent(scopeId: string) {
  const nameState = readPersistedState<{ autoGenerate?: unknown; manualName?: unknown } | null>(
    getWorkspaceNameStateKey(scopeId),
    null
  );
  const manualName =
    nameState?.autoGenerate === false && typeof nameState.manualName === "string"
      ? nameState.manualName.slice(0, CREATION_DRAFT_NAME_MAX_CHARS)
      : "";
  const { attachments } = sanitizeDraftAttachments(
    readPersistedState<unknown>(getInputAttachmentsKey(scopeId), undefined)
  );
  return { text: readPersistedString(getInputKey(scopeId)) ?? "", attachments, manualName };
}

interface LegacyListRow {
  subProjectPath: string | null;
  createdAt?: number;
}

/**
 * The oldest builds listed drafts in localStorage (`workspaceDraftsByProject`): the row holds a
 * draft's sub-project and creation time, which its content keys lack. Keyed by legacyListKey.
 */
function readLegacyListRows(): Map<string, LegacyListRow> {
  const rows = new Map<string, LegacyListRow>();
  const raw = readPersistedState<unknown>(WORKSPACE_DRAFTS_BY_PROJECT_KEY, undefined);
  if (typeof raw !== "object" || raw === null) return rows;
  for (const [projectPath, drafts] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(drafts)) continue;
    for (const draft of drafts as Array<Record<string, unknown> | null>) {
      if (typeof draft?.draftId !== "string") continue;
      const { subProjectPath, createdAt } = draft;
      rows.set(legacyListKey(projectPath, draft.draftId), {
        subProjectPath:
          typeof subProjectPath === "string" && subProjectPath.length > 0 ? subProjectPath : null,
        createdAt:
          typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : undefined,
      });
    }
  }
  return rows;
}

function legacyListKey(projectPath: string, legacyDraftId: string): string {
  return JSON.stringify([projectPath, legacyDraftId]);
}

/** Import one old scope; its keys (settings included) go once the backend took it. */
async function importLegacyDraft(
  client: APIClient,
  scopeId: string,
  listRows: Map<string, LegacyListRow>
): Promise<void> {
  const scope = parseLegacyScope(scopeId);
  if (!scope) return;
  const content = readLegacyContent(scopeId);
  const hasContent =
    content.text.length > 0 || content.attachments.length > 0 || content.manualName.length > 0;
  const row = listRows.get(legacyListKey(scope.projectPath, scope.legacyDraftId));
  if (hasContent) await client.drafts.importLegacyCreation({ ...scope, ...content, ...row });
  deleteWorkspaceStorage(scopeId);
}

export class CreationDraftStore {
  private client: APIClient | null = null;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly listListeners = new Set<() => void>();
  private summaries = new Map<string, CreationDraftSummary>();
  private byProject: Record<string, CreationDraftSummary[]> = {};
  private listState: CreationDraftListState = { status: "loading" };
  private listedClient: APIClient | null = null;
  private readonly blankIds = new Map<string, string>();
  /**
   * Deletes the backend has not confirmed (#7551): retried on failure and on each new client.
   * In memory only, as DraftStore's were before #6620. The value is the record the delete is for
   * (Entry.stored): a retry runs later, so it must not remove another window's later save. Null:
   * this window never knew the record, so only the first try deletes.
   */
  private readonly pendingDeletes = new Map<string, Omit<CreationDraft, "id"> | null>();
  /**
   * Ids deleted in this session, confirmed or not. A delete is final: a list never shows them (even
   * one read before the delete), and opening one again gives a blank draft.
   */
  private readonly deletedIds = new Set<string>();
  /** Backoff timers of failed deletes. A new client (or none) clears them: it retries at once. */
  private readonly deleteTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    // The save debounce is the only unload risk (main wrote localStorage at once): save as soon
    // as the page goes away, as DraftStore does.
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("beforeunload", () => this.flushDebounced());
    }
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") this.flushDebounced();
      });
    }
  }

  setClient(client: APIClient | null): void {
    if (client === this.client) return;
    this.client = client;
    for (const timer of this.deleteTimers.values()) clearTimeout(timer);
    this.deleteTimers.clear();
    if (!client) return;
    this.loadList(client);
    for (const id of this.pendingDeletes.keys()) {
      this.sendDelete(id, 0, true).catch(() => undefined);
    }
    for (const [id, entry] of this.entries) {
      if (entry.load.status === "loadFailed") this.retryLoad(id);
      else if (entry.saveError !== null) this.flushInBackground(id);
    }
  }

  // --- List (sidebar rows): loaded once per client; local edits update it locally. ---

  subscribeList = (listener: () => void): (() => void) => {
    this.listListeners.add(listener);
    return () => this.listListeners.delete(listener);
  };

  getDraftsByProject = (): Record<string, CreationDraftSummary[]> => this.byProject;

  getListState = (): CreationDraftListState => this.listState;

  /** The project's newest draft (by createdAt), or null. */
  newestDraftId(projectPath: string): string | null {
    const drafts = this.byProject[projectPath] ?? [];
    return (
      drafts.reduce<CreationDraftSummary | null>(
        (newest, draft) => (newest === null || draft.createdAt > newest.createdAt ? draft : newest),
        null
      )?.draftId ?? null
    );
  }

  /**
   * The draft a bare project page opens: the project's newest, else a blank one whose id stays
   * stable until it has content and is saved (then it is the newest).
   */
  draftIdForProject(projectPath: string): string {
    const newest = this.newestDraftId(projectPath);
    if (newest !== null) return newest;
    let id = this.blankIds.get(projectPath);
    if (id === undefined) {
      id = createDraftId();
      this.blankIds.set(projectPath, id);
    }
    return id;
  }

  private releaseBlankId(id: string): void {
    for (const [projectPath, blankId] of this.blankIds) {
      if (blankId === id) this.blankIds.delete(projectPath);
    }
  }

  private loadList(client: APIClient): void {
    this.listedClient = client;
    // A reconnect refreshes the rows behind the shown ones: going back to "loading" would unmount
    // the open composer (and its in-progress voice input or file reads).
    const run = async () => {
      // Before the list, so it includes what this imports.
      await this.importLegacyDrafts(client);
      const list = await client.drafts.listCreation();
      if (this.listedClient !== client) return;
      this.summaries = new Map(
        list.drafts
          .filter((summary) => !this.deletedIds.has(summary.draftId))
          .map((summary) => [summary.draftId, summary])
      );
      // A local copy is newer than the backend's row, and a first save still running (the list
      // can land after its timeout) has no row yet.
      for (const [id, entry] of this.entries) {
        if (this.deletedIds.has(id)) continue;
        if (entry.draft && (entry.persisted || entry.view.unsaved))
          this.summaries.set(id, summarizeCreationDraft(entry.draft));
      }
      this.listState = { status: "ready" };
      this.recomputeList();
    };
    // Failed or slow: composers open without rows (a new draft still works). A slow list still
    // lands in the background; a failed one is retried by the next connection.
    withTimeout(run(), DRAFT_STORE_READY_TIMEOUT_MS).catch((error: unknown) => {
      console.error("Failed to load creation drafts:", error);
      if (this.listedClient !== client || this.listState.status !== "loading") return;
      this.listState = { status: "ready" };
      this.recomputeList();
    });
  }

  private recomputeList(): void {
    const byProject: Record<string, CreationDraftSummary[]> = {};
    for (const summary of this.summaries.values()) {
      (byProject[summary.projectPath] ??= []).push(summary);
    }
    for (const drafts of Object.values(byProject)) drafts.sort((a, b) => a.createdAt - b.createdAt);
    this.byProject = byProject;
    this.listState = { ...this.listState };
    for (const listener of this.listListeners) listener();
  }

  /**
   * One-way import of pre-record renderer drafts (localStorage text, attachments and typed names
   * of old creation scopes). Keys go only once the backend confirmed the import.
   */
  private async importLegacyDrafts(client: APIClient): Promise<void> {
    const listRows = readLegacyListRows();
    let failed = false;
    for (const scopeId of legacyScopeIds()) {
      try {
        await importLegacyDraft(client, scopeId, listRows);
      } catch (error) {
        failed = true;
        console.warn("Failed to import a legacy creation draft; will retry on next start:", error);
      }
    }
    // A row without content keys was an empty draft: nothing to keep.
    if (!failed && readPersistedString(WORKSPACE_DRAFTS_BY_PROJECT_KEY) !== undefined) {
      updatePersistedState(WORKSPACE_DRAFTS_BY_PROJECT_KEY, undefined);
    }
  }

  // --- One draft ---

  subscribe = (id: string, listener: () => void): (() => void) => {
    const set = this.listeners.get(id) ?? new Set();
    set.add(listener);
    this.listeners.set(id, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(id);
    };
  };

  getView = (id: string): CreationDraftView => this.entries.get(id)?.view ?? LOADING_VIEW;

  /**
   * Load a draft for an editor. Found: its record. Absent (never saved, or deleted): a blank draft
   * of `projectPath`, saved once it has content. A failed or timed-out read shows Retry and no
   * editor: treating it as absent could write over a record this window never saw.
   */
  open(id: string, projectPath: string, subProjectPath: string | null = null): void {
    if (this.entries.has(id)) return;
    if (this.deletedIds.has(id)) {
      // Not read back: a pending delete still holds the sent record (#7551).
      const blank = createBlankCreationDraft(id, projectPath, subProjectPath);
      this.entries.set(id, this.newEntry(blank, { status: "ready" }, false));
      this.notify(id);
      return;
    }
    const entry = this.newEntry(null, { status: "loading" }, true);
    entry.blank = { projectPath, subProjectPath };
    this.entries.set(id, entry);
    this.fetch(id);
  }

  retryLoad(id: string): void {
    const entry = this.entries.get(id);
    if (entry?.load.status !== "loadFailed") return;
    entry.load = { status: "loading" };
    this.recompute(id, entry);
    this.fetch(id);
  }

  private fetch(id: string): void {
    const client = this.client;
    const run = async () => {
      if (!client) throw new Error("Not connected.");
      const record = await withTimeout(
        client.drafts.getCreation({ scope: { kind: "creation", draftId: id } }),
        DRAFT_STORE_READY_TIMEOUT_MS
      );
      const entry = this.entries.get(id);
      if (entry?.load.status !== "loading") return;
      entry.draft =
        record ?? createBlankCreationDraft(id, entry.blank.projectPath, entry.blank.subProjectPath);
      entry.persisted = record !== null;
      entry.stored = record;
      entry.load = { status: "ready" };
      this.recompute(id, entry);
    };
    run().catch((error: unknown) => {
      const entry = this.entries.get(id);
      if (entry?.load.status !== "loading") return;
      // Lost with a connection that was replaced meanwhile (the reconnect skipped it as loading).
      if (this.client && this.client !== client) {
        this.fetch(id);
        return;
      }
      entry.load = { status: "loadFailed", message: getErrorMessage(error) };
      this.recompute(id, entry);
    });
  }

  /** A new draft with a fresh id (explicit New). Prefilled text lists its row at once. */
  create(projectPath: string, subProjectPath: string | null, options?: { text?: string }): string {
    const id = createDraftId();
    const draft = { ...createBlankCreationDraft(id, projectPath, subProjectPath) };
    if (options?.text) draft.text = options.text;
    const entry = this.newEntry(draft, { status: "ready" }, false);
    this.entries.set(id, entry);
    if (hasCreationDraftContent(draft)) {
      const { id: _id, ...all } = draft;
      entry.pending = all;
      this.summaries.set(id, summarizeCreationDraft(draft));
      this.recomputeList();
      this.flushInBackground(id);
    }
    return id;
  }

  /** Apply an edit at once; saved after a short debounce (changed fields only). */
  update(id: string, patch: CreationDraftPatch): void {
    const entry = this.entries.get(id);
    if (!entry?.draft) return;
    entry.draft = { ...entry.draft, ...patch };
    entry.pending = { ...entry.pending, ...patch };
    // A blank draft moved to another project is no longer its old project's blank draft.
    if (patch.projectPath !== undefined) this.releaseBlankId(id);
    // An edit may correct a refused save: try again with it.
    entry.saveError = null;
    this.recompute(id, entry);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.flushInBackground(id);
    }, SAVE_DEBOUNCE_MS);
  }

  /** Set execution choices (one group: a project change replaces it, changeCreationDraftProject). */
  updateExecution(id: string, patch: Partial<CreationDraftExecution>): void {
    const draft = this.entries.get(id)?.draft;
    if (!draft) return;
    this.update(id, { execution: { ...(draft.execution ?? NO_EXECUTION_CHOICES), ...patch } });
  }

  /** Save now and wait until every local change is confirmed; rejects with the save error. */
  async flush(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    for (;;) {
      if (entry.inFlight) {
        await entry.inFlight;
        continue;
      }
      // A draft without content is not saved, so it has no row (hasCreationDraftContent).
      if (!hasChangesToSave(entry)) return;
      entry.inFlight = this.save(id, entry).finally(() => {
        entry.inFlight = null;
      });
      await entry.inFlight;
      if (entry.saveError !== null) throw new Error(entry.saveError);
    }
  }

  private flushDebounced(): void {
    for (const [id, entry] of this.entries) {
      if (entry.timer) this.flushInBackground(id);
    }
  }

  private flushInBackground(id: string): void {
    this.flush(id).catch((error: unknown) =>
      console.warn("Failed to save a creation draft:", error)
    );
  }

  /** One save in flight per draft; its reply never touches the local copy (edits made since win). */
  private async save(id: string, entry: Entry): Promise<void> {
    const draft = entry.draft;
    if (!draft) return;
    const { id: _id, ...all } = draft;
    const patch = entry.persisted ? entry.pending : all;
    entry.pending = {};
    entry.saving = true;
    this.recompute(id, entry);
    const client = this.client;
    try {
      if (!client) throw new Error("Not connected.");
      await client.drafts.updateCreation({
        scope: { kind: "creation", draftId: id },
        ...patch,
      });
      entry.saving = false;
      entry.persisted = true;
      entry.stored = draft;
      entry.saveError = null;
      if (this.entries.get(id) !== entry) return;
      if (!this.deletedIds.has(id)) {
        this.summaries.set(id, summarizeCreationDraft(entry.draft ?? draft));
        this.recomputeList();
      }
    } catch (error) {
      entry.saving = false;
      if (this.entries.get(id) !== entry) return;
      this.keepFailedSave(entry, draft, patch, client, error);
    }
    this.recompute(id, entry);
  }

  /** A failed save: its fields wait for the next save. */
  private keepFailedSave(
    entry: Entry,
    draft: CreationDraft,
    patch: CreationDraftPatch,
    client: APIClient | null,
    error: unknown
  ): void {
    // A refused save wrote nothing; other failures may have (most often the reply was lost).
    if (client && !isSaveRefusal(error)) {
      entry.maybeSaved = true;
      entry.stored = draft;
    }
    // Later edits win over the fields this save carried.
    entry.pending = { ...patch, ...entry.pending };
    // Lost with a connection that was replaced meanwhile: no error, so flush() saves it again on
    // the new one (a Send awaiting it waits for that save instead of failing).
    entry.saveError = this.client && this.client !== client ? null : getErrorMessage(error);
  }

  /**
   * Delete a draft (Send success, sidebar Delete). Another window's unsent edits go too. Never
   * rejects: a failed delete is retried, or the record would be listed again with sent text.
   */
  async delete(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry?.timer) clearTimeout(entry.timer);
    this.entries.delete(id);
    // A bare project page that showed it opens a new blank draft, not the deleted id.
    this.releaseBlankId(id);
    this.notify(id);
    this.summaries.delete(id);
    this.recomputeList();
    // Before the wait, so a list that lands meanwhile cannot show the record again.
    this.deletedIds.add(id);
    // Let a save in flight land first, so it cannot recreate the file after the delete. Pending
    // (resent by a new client) only after it: a resend must not overtake that save either.
    await entry?.inFlight;
    // Read after the wait: the save that landed meanwhile is what the record holds.
    const stored = entry?.stored ?? null;
    let ifStored: Omit<CreationDraft, "id"> | null = null;
    if (stored) {
      const { id: _id, ...fields } = stored;
      ifStored = fields;
    }
    this.pendingDeletes.set(id, ifStored);
    await this.sendDelete(id, 0, false);
  }

  /**
   * `conditional`: a retry or a resend. It deletes only the record this window knew, so another
   * window's save that landed after the first try survives. The first try deletes whatever is there.
   */
  private async sendDelete(id: string, attempt: number, conditional: boolean): Promise<void> {
    const client = this.client;
    const ifStored = this.pendingDeletes.get(id);
    // Without a client the next one retries it (setClient).
    if (!client || ifStored === undefined) return;
    if (conditional && ifStored === null) {
      this.pendingDeletes.delete(id);
      return;
    }
    try {
      await client.drafts.deleteCreation({
        scope: { kind: "creation", draftId: id },
        ...(conditional && ifStored ? { ifStored } : {}),
      });
      this.pendingDeletes.delete(id);
    } catch (error) {
      console.warn("Failed to delete a creation draft; retrying:", error);
      // A client change while the request ran already resent it (setClient).
      if (this.client !== client || !this.pendingDeletes.has(id)) return;
      clearTimeout(this.deleteTimers.get(id));
      const timer = setTimeout(() => {
        this.deleteTimers.delete(id);
        this.sendDelete(id, attempt + 1, true).catch(() => undefined);
      }, retryDelayMs(attempt));
      this.deleteTimers.set(id, timer);
    }
  }

  /** Drop local state of a removed project's drafts (the backend deletes their records). */
  forgetProject(projectPath: string): void {
    for (const [id, entry] of [...this.entries]) {
      if (entry.draft?.projectPath !== projectPath) continue;
      if (entry.timer) clearTimeout(entry.timer);
      this.entries.delete(id);
      this.notify(id);
    }
    for (const [id, summary] of [...this.summaries]) {
      if (summary.projectPath === projectPath) this.summaries.delete(id);
    }
    this.recomputeList();
  }

  private newEntry(
    draft: CreationDraft | null,
    load: CreationDraftLoad,
    persisted: boolean
  ): Entry {
    const entry: Entry = {
      draft,
      blank: {
        projectPath: draft?.projectPath ?? "",
        subProjectPath: draft?.subProjectPath ?? null,
      },
      load,
      persisted,
      maybeSaved: false,
      stored: null,
      pending: {},
      inFlight: null,
      saving: false,
      timer: null,
      saveError: null,
      view: LOADING_VIEW,
    };
    entry.view = this.viewOf(entry);
    return entry;
  }

  private viewOf(entry: Entry): CreationDraftView {
    return {
      load: entry.load,
      draft: entry.draft,
      unsaved: entry.saving || hasChangesToSave(entry),
      saveError: entry.saveError,
    };
  }

  private recompute(id: string, entry: Entry): void {
    // The sidebar row follows confirmed saves (save()), not every keystroke.
    entry.view = this.viewOf(entry);
    this.notify(id);
  }

  private notify(id: string): void {
    for (const listener of this.listeners.get(id) ?? []) listener();
  }
}

let store: CreationDraftStore | null = null;

export function getCreationDraftStore(): CreationDraftStore {
  store ??= new CreationDraftStore();
  return store;
}

export function useCreationDraft(id: string): CreationDraftView {
  const s = getCreationDraftStore();
  return useSyncExternalStore(
    (listener) => s.subscribe(id, listener),
    () => s.getView(id)
  );
}

/** Where a loaded draft lives (undefined while it loads); re-renders only when that changes. */
export function useCreationDraftField<K extends "projectPath" | "subProjectPath">(
  id: string,
  key: K
): CreationDraft[K] | undefined {
  const s = getCreationDraftStore();
  return useSyncExternalStore(
    (listener) => s.subscribe(id, listener),
    () => s.getView(id).draft?.[key]
  );
}

export function useCreationDraftsByProject(): Record<string, CreationDraftSummary[]> {
  const s = getCreationDraftStore();
  return useSyncExternalStore(s.subscribeList, s.getDraftsByProject);
}

export function useCreationDraftListState(): CreationDraftListState {
  const s = getCreationDraftStore();
  return useSyncExternalStore(s.subscribeList, s.getListState);
}
