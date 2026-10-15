import { useSyncExternalStore } from "react";
import { ORPCError } from "@orpc/client";
import type { APIClient } from "@/browser/contexts/API";
import {
  listPersistedKeys,
  readPersistedState,
  readPersistedString,
} from "@/browser/hooks/usePersistedState";
import { getUserPreferences } from "@/browser/stores/AppConfigStore";
import { deleteWorkspaceStorage } from "@/browser/utils/workspaceStorage";
import {
  getDraftScopeId,
  getInputAttachmentsKey,
  getInputKey,
  getPendingScopeId,
  getWorkspaceNameStateKey,
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
  ownExecution,
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
  status: "loading" | "ready" | "failed";
  importError: string | null;
}

interface Entry {
  draft: CreationDraft | null;
  /** Where a blank draft goes when the read finds no record. */
  blank: { projectPath: string; subProjectPath: string | null };
  load: CreationDraftLoad;
  /** Whether the backend holds a record: until then, a save sends every field (a create). */
  persisted: boolean;
  /** Changed fields not sent yet. */
  pending: CreationDraftPatch;
  /** Never rejects (save records its error). */
  inFlight: Promise<void> | null;
  saving: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  saveError: string | null;
  /** A transport failure: retried on reconnect (a refusal needs a correction or a reload). */
  retryOnReconnect: boolean;
  view: CreationDraftView;
}

const SAVE_DEBOUNCE_MS = 300;
const NO_EXECUTION_CHOICES: Omit<CreationDraftExecution, "projectPath"> = {
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

/** A backend refusal (validation, ownership, size): permanent until the draft changes. */
function isRefusal(error: unknown): boolean {
  return error instanceof ORPCError && error.code === "BAD_REQUEST";
}

/** Project defaults only seed a new draft; afterwards the draft owns its choices. */
function seedAi(projectPath: string): CreationDraft["ai"] {
  const { projectDefaults, globalDefaults } = getUserPreferences().ai ?? {};
  const project = projectDefaults?.[projectPath] ?? {};
  return {
    model: project.model?.trim() ? project.model : undefined,
    thinkingLevel: coerceThinkingLevel(project.thinkingLevel ?? globalDefaults?.thinkingLevel),
  };
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

/** Import one old scope; its keys go unless a newer draft differs (or the call fails). */
async function importLegacyDraft(
  client: APIClient,
  scopeId: string
): Promise<"imported" | "conflict" | "skipped"> {
  const scope = parseLegacyScope(scopeId);
  if (!scope) return "skipped";
  const content = readLegacyContent(scopeId);
  const hasContent =
    content.text.length > 0 || content.attachments.length > 0 || content.manualName.length > 0;
  const reply = hasContent
    ? await client.drafts.importLegacyCreation({ ...scope, ...content })
    : null;
  if (reply?.result === "conflict") return "conflict";
  // Imported, orphaned, or nothing to import: the old scope's settings keys go with it.
  deleteWorkspaceStorage(scopeId);
  return reply ? "imported" : "skipped";
}

export class CreationDraftStore {
  private client: APIClient | null = null;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly listListeners = new Set<() => void>();
  private summaries = new Map<string, CreationDraftSummary>();
  private byProject: Record<string, CreationDraftSummary[]> = {};
  private listState: CreationDraftListState = { status: "loading", importError: null };
  private listedClient: APIClient | null = null;
  private readonly blankIds = new Map<string, string>();

  setClient(client: APIClient | null): void {
    if (client === this.client) return;
    this.client = client;
    if (!client) return;
    this.loadList(client);
    for (const [id, entry] of this.entries) {
      if (entry.load.status === "loadFailed") this.retryLoad(id);
      else if (entry.retryOnReconnect) this.flushInBackground(id);
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
   * stable until its first edit saves it (then it is the newest).
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

  retryList(): void {
    if (this.client) this.loadList(this.client);
  }

  private loadList(client: APIClient): void {
    this.listedClient = client;
    this.listState = { ...this.listState, status: "loading" };
    this.recomputeList();
    const run = async () => {
      const list = await client.drafts.listCreation();
      if (this.listedClient !== client) return;
      this.summaries = new Map(list.drafts.map((summary) => [summary.draftId, summary]));
      // A local copy is newer than the backend's row.
      for (const [id, entry] of this.entries) {
        if (entry.draft && entry.persisted)
          this.summaries.set(id, summarizeCreationDraft(entry.draft));
      }
      const legacyError = await this.importLegacyDrafts(client);
      this.listState = { status: "ready", importError: list.importError ?? legacyError };
      this.recomputeList();
    };
    run().catch((error: unknown) => {
      console.error("Failed to load creation drafts:", error);
      if (this.listedClient !== client) return;
      this.listState = { ...this.listState, status: "failed" };
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
   * of old creation scopes). Keys go only once the backend confirmed the import. Returns an error
   * to show when an import conflicted with a newer draft (its keys stay).
   */
  private async importLegacyDrafts(client: APIClient): Promise<string | null> {
    const counts = { imported: 0, conflict: 0, skipped: 0 };
    for (const scopeId of legacyScopeIds()) {
      try {
        counts[await importLegacyDraft(client, scopeId)]++;
      } catch (error) {
        console.warn("Failed to import a legacy creation draft; will retry on next start:", error);
      }
    }
    if (counts.imported > 0) {
      const list = await client.drafts.listCreation();
      for (const summary of list.drafts) {
        if (!this.summaries.has(summary.draftId)) this.summaries.set(summary.draftId, summary);
      }
    }
    return counts.conflict > 0
      ? `${counts.conflict} older draft(s) were not imported because a newer draft differs. They stay in this browser.`
      : null;
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
   * of `projectPath`, saved by its first edit. A failed or timed-out read shows Retry and no
   * editor: treating it as absent could write over a record this window never saw.
   */
  open(id: string, projectPath: string, subProjectPath: string | null = null): void {
    if (this.entries.has(id)) return;
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
      entry.load = { status: "ready" };
      this.recompute(id, entry);
    };
    run().catch((error: unknown) => {
      const entry = this.entries.get(id);
      if (entry?.load.status !== "loading") return;
      entry.load = { status: "loadFailed", message: getErrorMessage(error) };
      this.recompute(id, entry);
    });
  }

  /** A new draft with a fresh id (explicit New). `persist` saves its empty row at once. */
  create(
    projectPath: string,
    subProjectPath: string | null,
    options?: { persist?: boolean; text?: string }
  ): string {
    const id = createDraftId();
    const draft = { ...createBlankCreationDraft(id, projectPath, subProjectPath) };
    if (options?.text) draft.text = options.text;
    const entry = this.newEntry(draft, { status: "ready" }, false);
    this.entries.set(id, entry);
    if (options?.persist === true || draft.text.length > 0) {
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
    entry.retryOnReconnect = false;
    this.recompute(id, entry);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.flushInBackground(id);
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Set execution choices. They are grouped with the project they were made for, so the backend
   * refuses them for another project; choices made for a previous project are not kept.
   */
  updateExecution(id: string, patch: Partial<Omit<CreationDraftExecution, "projectPath">>): void {
    const draft = this.entries.get(id)?.draft;
    if (!draft) return;
    this.update(id, {
      execution: {
        ...(ownExecution(draft) ?? NO_EXECUTION_CHOICES),
        ...patch,
        projectPath: draft.projectPath,
      },
    });
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
      // A blank draft nobody edited is never saved (no row until its first edit).
      if (!entry.draft || Object.keys(entry.pending).length === 0) return;
      entry.inFlight = this.save(id, entry).finally(() => {
        entry.inFlight = null;
      });
      await entry.inFlight;
      if (entry.saveError !== null) throw new Error(entry.saveError);
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
    try {
      if (!this.client) throw new Error("Not connected.");
      await this.client.drafts.updateCreation({
        scope: { kind: "creation", draftId: id },
        ...patch,
      });
      entry.saving = false;
      entry.persisted = true;
      entry.saveError = null;
      entry.retryOnReconnect = false;
      if (this.entries.get(id) !== entry) return;
      this.summaries.set(id, summarizeCreationDraft(entry.draft ?? draft));
      this.recomputeList();
    } catch (error) {
      entry.saving = false;
      if (this.entries.get(id) !== entry) return;
      // Later edits win over the fields this save carried.
      entry.pending = { ...patch, ...entry.pending };
      entry.saveError = getErrorMessage(error);
      entry.retryOnReconnect = !isRefusal(error);
    }
    this.recompute(id, entry);
  }

  /** Delete a draft (Send success, sidebar Delete). Another window's unsent edits go too. */
  async delete(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry?.timer) clearTimeout(entry.timer);
    this.entries.delete(id);
    this.notify(id);
    this.summaries.delete(id);
    this.recomputeList();
    // Let a save in flight land first, so it cannot recreate the file after the delete.
    await entry?.inFlight;
    if (!entry || entry.persisted) {
      await this.client?.drafts.deleteCreation({ scope: { kind: "creation", draftId: id } });
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
      pending: {},
      inFlight: null,
      saving: false,
      timer: null,
      saveError: null,
      retryOnReconnect: false,
      view: LOADING_VIEW,
    };
    entry.view = this.viewOf(entry);
    return entry;
  }

  private viewOf(entry: Entry): CreationDraftView {
    return {
      load: entry.load,
      draft: entry.draft,
      unsaved: entry.saving || entry.timer !== null || Object.keys(entry.pending).length > 0,
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

export function useCreationDraftsByProject(): Record<string, CreationDraftSummary[]> {
  const s = getCreationDraftStore();
  return useSyncExternalStore(s.subscribeList, s.getDraftsByProject);
}

export function useCreationDraftListState(): CreationDraftListState {
  const s = getCreationDraftStore();
  return useSyncExternalStore(s.subscribeList, s.getListState);
}
