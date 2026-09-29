import { useSyncExternalStore } from "react";
import type { APIClient } from "@/browser/contexts/API";
import type { ChatAttachment } from "@/browser/features/ChatInput/ChatAttachments";
import {
  listPersistedKeys,
  readPersistedState,
  readPersistedString,
  updatePersistedState,
} from "@/browser/hooks/usePersistedState";
import { isAbortError } from "@/browser/utils/isAbortError";
import {
  getDraftScopeId,
  getInputAttachmentsKey,
  getInputKey,
  getPendingScopeId,
  getProjectScopeId,
  GLOBAL_SCOPE_ID,
  migrateWorkspaceStorage,
  WORKSPACE_DRAFTS_BY_PROJECT_KEY,
} from "@/common/constants/storage";
import type {
  DraftAttachment,
  DraftAttachmentMetadata,
  DraftEvent,
  DraftScope,
  DraftSummary,
} from "@/common/orpc/schemas/drafts";
import {
  draftJsonBytes,
  draftScopeKey,
  draftTooLargeMessage,
  isDraftTooLargeError,
  sanitizeDraftAttachments,
  toDraftAttachmentMetadata,
} from "@/common/utils/drafts";
import { getErrorMessage } from "@/common/utils/errors";
import {
  DRAFT_ID_PATTERN,
  DRAFT_STORE_READY_TIMEOUT_MS,
  MAX_DRAFT_JSON_BYTES,
} from "@/constants/drafts";

/**
 * Frontend cache for composer drafts persisted by the backend DraftService (they used to live in
 * localStorage, where base64 attachments exhausted the quota).
 *
 * The in-memory state is the source of truth for rendering: setText/setAttachments update it
 * synchronously and schedule a debounced write, so typed text never depends on a storage write
 * succeeding (issue 5006: a full localStorage used to drop keystrokes on screen). Failed writes
 * keep the change and retry. Losing the last debounce window on a hard close is accepted.
 *
 * Every client of a backend (Electron window, browser tabs) shares the drafts: a subscription
 * keeps them live. Revisions order server state, and a field with an unconfirmed local change is
 * never overwritten by a server push (last write wins once the local write lands).
 */

/**
 * A memory-only scope that is never sent to the backend: a workspace composer that has no
 * workspace id yet, or a creation composer without a project. The legacy per-project pending
 * localStorage drafts (getPendingScopeId) also map to it before their one-time import.
 */
export interface PendingDraftScope {
  kind: "pending";
  projectPath: string;
}

export type DraftStoreScope = DraftScope | PendingDraftScope;

/**
 * Draft id of a project's default creation composer (the project page opened without a draft
 * id). Generated draft ids are UUIDs, so this fixed id never collides with a listed draft.
 */
const DEFAULT_CREATION_DRAFT_ID = "default";

/**
 * Draft id a legacy pending-scope draft is imported under. Fixed (not generated) so that an
 * import retried on a later start (see migrateLegacyDrafts) finds its earlier copy ("present")
 * instead of creating a second draft. Generated ids are UUIDs, so this never collides.
 */
const LEGACY_PENDING_DRAFT_ID = "legacy-pending";

/**
 * The scope the project's default creation composer edits. It is a real backend scope: on main
 * this text survived a reload in localStorage, and a memory-only scope lost it. WorkspaceContext
 * moves it into the first listed creation draft it creates (moveDraft).
 */
export function defaultCreationDraftScope(projectPath: string): DraftStoreScope {
  return projectPath.length > 0
    ? { kind: "creation", projectPath, draftId: DEFAULT_CREATION_DRAFT_ID }
    : { kind: "pending", projectPath };
}

export interface DraftView {
  text: string;
  /** Attachments with payloads; empty until the payloads of a hydrated draft are loaded. */
  attachments: ChatAttachment[];
  /** Attachments the draft holds, including ones whose payloads are still loading. */
  attachmentCount: number;
  payloadsLoaded: boolean;
}

// The backend schema mirrors the composer's attachment union; fail typecheck if they drift.
type Exactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type DraftAttachmentMatchesChatAttachment = Assert<Exactly<DraftAttachment, ChatAttachment>>;

type AttachmentUpdate = (previous: ChatAttachment[]) => ChatAttachment[];

interface Entry {
  scope: DraftStoreScope;
  text: string;
  attachments: ChatAttachment[];
  attachmentCount: number;
  payloadsLoaded: boolean;
  /** Bumped whenever the server's attachment list changes, invalidating a payload load. */
  payloadGeneration: number;
  payloadLoad: Promise<void> | null;
  /** Functional updates issued before the payloads arrived; applied onto them. */
  queuedAttachmentUpdates: AttachmentUpdate[];
  /** Newest server revision applied; reset by each subscription snapshot. */
  revision: number;
  textVersion: number;
  confirmedTextVersion: number;
  attachmentsVersion: number;
  confirmedAttachmentsVersion: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  flushAttempt: number;
  inFlight: Promise<void> | null;
  /** A write failed and has not succeeded since (one save-error notification per streak). */
  failing: boolean;
  view: DraftView;
}

const FLUSH_DEBOUNCE_MS = 300;
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 5_000;
const EMPTY_VIEW: DraftView = {
  text: "",
  attachments: [],
  attachmentCount: 0,
  payloadsLoaded: true,
};
const PENDING_SCOPE_PREFIX = "__pending__";
const DRAFT_SCOPE_PREFIX = "__draft__/";

function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
}

export function draftStoreScopeKey(scope: DraftStoreScope): string {
  return scope.kind === "pending" ? `pending:${scope.projectPath}` : draftScopeKey(scope);
}

function isTextDirty(entry: Entry): boolean {
  return entry.textVersion > entry.confirmedTextVersion;
}

function isAttachmentsDirty(entry: Entry): boolean {
  return entry.attachmentsVersion > entry.confirmedAttachmentsVersion;
}

/**
 * Whether loaded attachments match the server's list, metadata included: another client may
 * replace an attachment under the same id (e.g. a pending file that became staged).
 */
function matchesServerAttachments(
  local: readonly ChatAttachment[],
  server: readonly DraftAttachmentMetadata[]
): boolean {
  return (
    local.length === server.length &&
    local.every((attachment, index) => {
      const mine = toDraftAttachmentMetadata(attachment);
      const theirs = server[index];
      return (
        theirs !== undefined &&
        mine.id === theirs.id &&
        mine.kind === theirs.kind &&
        mine.mediaType === theirs.mediaType &&
        mine.filename === theirs.filename &&
        mine.sizeBytes === theirs.sizeBytes
      );
    })
  );
}

/**
 * Map a legacy localStorage scope id (getDraftScopeId/getPendingScopeId/workspace id) to the
 * store scope that now owns it. Null for ids that never held a draft of a known kind.
 */
function legacyScopeFor(scopeId: string): DraftStoreScope | null {
  if (scopeId.startsWith(PENDING_SCOPE_PREFIX)) {
    const projectPath = scopeId.slice(PENDING_SCOPE_PREFIX.length);
    return projectPath.length > 0 ? { kind: "pending", projectPath } : null;
  }
  if (scopeId.startsWith(DRAFT_SCOPE_PREFIX)) {
    const rest = scopeId.slice(DRAFT_SCOPE_PREFIX.length);
    const separator = rest.lastIndexOf("/");
    const projectPath = rest.slice(0, separator);
    const draftId = rest.slice(separator + 1);
    return separator > 0 && DRAFT_ID_PATTERN.test(draftId)
      ? { kind: "creation", projectPath, draftId }
      : null;
  }
  // Other ids are workspace ids, including legacy `<project basename>-<branch>` ids that start
  // with "__" (the backend answers "orphaned" for unknown ones). Only reserved scopes are skipped.
  if (
    scopeId.length === 0 ||
    scopeId === GLOBAL_SCOPE_ID ||
    scopeId.startsWith(getProjectScopeId(""))
  ) {
    return null;
  }
  return { kind: "workspace", workspaceId: scopeId };
}

/**
 * Parse a legacy localStorage value. A corrupt value is expected input here (the import drops it),
 * so it is a warning rather than readPersistedState's error log.
 */
function readLegacyJson(key: string): unknown {
  const raw = readPersistedString(key);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`Ignoring an unparseable legacy draft value for key "${key}":`, error);
    return undefined;
  }
}

/**
 * Add the imported legacy pending draft to its project's draft list (WorkspaceContext owns the
 * list; this is its one-time import). False when the list could not be written.
 */
function listLegacyPendingDraft(projectPath: string, draftId: string): boolean {
  const current = readPersistedState<Record<string, unknown>>(WORKSPACE_DRAFTS_BY_PROJECT_KEY, {});
  const lists = typeof current === "object" && current !== null ? current : {};
  const existing = Array.isArray(lists[projectPath]) ? (lists[projectPath] as unknown[]) : [];
  const listed = existing.some(
    (draft) =>
      typeof draft === "object" &&
      draft !== null &&
      (draft as { draftId?: unknown }).draftId === draftId
  );
  if (listed) return true;
  return updatePersistedState(WORKSPACE_DRAFTS_BY_PROJECT_KEY, {
    ...lists,
    [projectPath]: [...existing, { draftId, subProjectPath: null, createdAt: Date.now() }],
  });
}

export class DraftStore {
  private client: APIClient | null = null;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly readyListeners = new Set<() => void>();
  private readonly errorListeners = new Map<string, Set<(message: string) => void>>();
  /**
   * Deletes the backend has not confirmed, by scope key. Hydration must not bring such a draft
   * back, and a failed delete is retried: a discarded creation draft is unreachable from any UI
   * once its list entry is gone, so nothing else would ever remove its file.
   */
  private readonly pendingDeletes = new Map<string, DraftScope>();
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private subscription: AbortController | null = null;
  private resubscribeTimer: ReturnType<typeof setTimeout> | null = null;
  private resubscribeAttempt = 0;
  /** A real snapshot was applied: writes may go out (they could clobber unseen data before). */
  private hydrated = false;
  /** Composers may render: hydrated, or the first subscription failed (self-heal). */
  private ready = false;
  private resolveReady: () => void = () => undefined;
  private readonly readyPromise = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });

  constructor() {
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      // The debounce window is the only unload risk; flush as soon as the page goes away.
      window.addEventListener("beforeunload", () => this.flushAllInBackground());
    }
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") this.flushAllInBackground();
      });
    }
  }

  setClient(client: APIClient | null): void {
    if (client === this.client) return;
    this.client = client;
    this.stopSubscription();
    if (client) this.startSubscription(client);
  }

  isReady(): boolean {
    return this.ready;
  }

  subscribeReady = (listener: () => void): (() => void) => {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  };

  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  subscribe = (scope: DraftStoreScope, listener: () => void): (() => void) => {
    const key = draftStoreScopeKey(scope);
    const set = this.listeners.get(key) ?? new Set();
    set.add(listener);
    this.listeners.set(key, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(key);
    };
  };

  /** Save failures of one scope, reported once per failure streak. */
  subscribeSaveErrors(scope: DraftStoreScope, listener: (message: string) => void): () => void {
    const key = draftStoreScopeKey(scope);
    const set = this.errorListeners.get(key) ?? new Set();
    set.add(listener);
    this.errorListeners.set(key, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.errorListeners.delete(key);
    };
  }

  getView(scope: DraftStoreScope): DraftView {
    return this.entries.get(draftStoreScopeKey(scope))?.view ?? EMPTY_VIEW;
  }

  getText(scope: DraftStoreScope): string {
    return this.getView(scope).text;
  }

  getAttachments(scope: DraftStoreScope): ChatAttachment[] {
    return this.getView(scope).attachments;
  }

  setText(scope: DraftStoreScope, value: string | ((previous: string) => string)): void {
    const entry = this.getOrCreateEntry(scope);
    const next = typeof value === "function" ? value(entry.text) : value;
    if (next === entry.text) return;
    entry.text = next;
    entry.textVersion++;
    this.recompute(entry);
    this.scheduleFlush(entry);
  }

  /**
   * Replace the attachments, or update them functionally. A functional update issued while a
   * hydrated draft's payloads are still loading is queued and applied onto them, so it can never
   * drop attachments it has not seen.
   */
  setAttachments(scope: DraftStoreScope, value: ChatAttachment[] | AttachmentUpdate): void {
    const entry = this.getOrCreateEntry(scope);
    if (typeof value !== "function") {
      // A full replacement does not depend on the unloaded payloads.
      entry.payloadsLoaded = true;
      entry.queuedAttachmentUpdates = [];
      this.applyAttachments(entry, value);
      return;
    }
    if (!entry.payloadsLoaded) {
      entry.queuedAttachmentUpdates.push(value);
      this.ensurePayloads(scope).catch((error: unknown) => {
        console.warn("Failed to load draft attachments:", error);
      });
      return;
    }
    this.applyAttachments(entry, value(entry.attachments));
  }

  /**
   * Load the attachment payloads of a hydrated draft (bulk hydration carries only metadata).
   * Resolves at once when they are loaded; a send awaits this so it never goes out without them.
   */
  ensurePayloads(scope: DraftStoreScope): Promise<void> {
    const key = draftStoreScopeKey(scope);
    const entry = this.entries.get(key);
    if (!entry || entry.payloadsLoaded || entry.scope.kind === "pending") return Promise.resolve();
    if (entry.payloadLoad) return entry.payloadLoad;
    const client = this.client;
    if (!client) return Promise.reject(new Error("Draft attachments unavailable: not connected"));
    const backendScope = entry.scope;
    const generation = entry.payloadGeneration;
    // A holder: the load compares itself with entry.payloadLoad when it settles.
    const current: { load?: Promise<void> } = {};
    current.load = (async () => {
      try {
        const draft = await client.drafts.get({ scope: backendScope });
        if (this.entries.get(key) !== entry || entry.payloadsLoaded) return;
        if (entry.payloadGeneration !== generation) {
          // The server's list changed while loading: load the new one instead.
          entry.payloadLoad = null;
          await this.ensurePayloads(backendScope);
          return;
        }
        entry.payloadsLoaded = true;
        entry.attachments = draft.attachments;
        entry.attachmentCount = draft.attachments.length;
        const queued = entry.queuedAttachmentUpdates;
        entry.queuedAttachmentUpdates = [];
        if (queued.length > 0) {
          this.applyAttachments(
            entry,
            queued.reduce((attachments, update) => update(attachments), entry.attachments)
          );
        } else {
          this.recompute(entry);
        }
      } finally {
        if (entry.payloadLoad === current.load) entry.payloadLoad = null;
      }
    })();
    entry.payloadLoad = current.load;
    return current.load;
  }

  /**
   * Resolves once the backend confirmed the scope's current text and attachments (the #4448
   * restore ack waits for this). Rejects when a write fails or the drafts never hydrated; the
   * change stays in memory and is retried.
   */
  async flush(scope: DraftStoreScope): Promise<void> {
    if (scope.kind === "pending") return;
    const entry = this.entries.get(draftStoreScopeKey(scope));
    if (!entry) return;
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = null;
    }
    await this.readyPromise;
    if (!this.hydrated) throw new Error("Draft save failed: drafts are not loaded");
    await this.drain(entry);
  }

  /**
   * Delete a draft (e.g. a discarded creation draft) locally and on the backend. A failed backend
   * delete is retried until it succeeds or the scope is edited again.
   */
  async deleteDraft(scope: DraftStoreScope): Promise<void> {
    const key = draftStoreScopeKey(scope);
    const entry = this.dropEntry(key);
    if (scope.kind === "pending") return;
    // Let a write in flight land first, so it cannot recreate the file after the delete.
    await entry?.inFlight;
    if (this.entries.has(key)) return;
    this.pendingDeletes.set(key, scope);
    await this.sendDelete(key, 0);
  }

  private async sendDelete(key: string, attempt: number): Promise<void> {
    const scope = this.pendingDeletes.get(key);
    const client = this.client;
    // Without a client the next subscription snapshot retries it.
    if (!scope || !client) return;
    try {
      await client.drafts.delete({ scope });
      if (this.pendingDeletes.get(key) === scope) this.pendingDeletes.delete(key);
    } catch (error) {
      console.warn("Failed to delete draft; retrying:", error);
      setTimeout(() => {
        if (this.client === client) this.sendDelete(key, attempt + 1).catch(() => undefined);
      }, retryDelayMs(attempt));
    }
  }

  /**
   * Move a draft to another scope (default creation draft -> listed creation draft). The source
   * is deleted only once the backend confirmed the destination: if that write fails, both stay
   * (the destination keeps retrying) rather than risking the only persisted copy. Never rejects.
   */
  async moveDraft(from: DraftStoreScope, to: DraftStoreScope): Promise<void> {
    const key = draftStoreScopeKey(from);
    const source = this.entries.get(key);
    if (!source || (source.view.text.length === 0 && source.view.attachmentCount === 0)) return;
    this.setText(to, source.text);
    // Captured with the copy it describes: an edit during the payload load below must keep the
    // source (the text was copied before it).
    const textVersion = source.textVersion;
    if (!source.payloadsLoaded) {
      // A hydrated source may not have its attachment payloads yet. Deleting it before they
      // arrive would lose the attachments, so move them once loaded; on failure the source stays.
      try {
        await this.ensurePayloads(from);
      } catch (error) {
        console.warn("Failed to load draft attachments to move; keeping the source draft:", error);
        return;
      }
      if (this.entries.get(key) !== source || !source.payloadsLoaded) return;
    }
    if (source.attachments.length > 0) this.setAttachments(to, source.attachments);
    const attachmentsVersion = source.attachmentsVersion;
    try {
      await this.flush(to);
    } catch (error) {
      console.warn("Failed to save the moved draft; keeping the source draft:", error);
      return;
    }
    // An edit of the source meanwhile makes it a different draft: keep it.
    if (
      this.entries.get(key) !== source ||
      source.textVersion !== textVersion ||
      source.attachmentsVersion !== attachmentsVersion
    ) {
      return;
    }
    await this.deleteDraft(from);
  }

  /** Drop local state of a removed workspace (its session dir, and draft, are gone). */
  forgetWorkspace(workspaceId: string): void {
    this.dropEntry(draftScopeKey({ kind: "workspace", workspaceId }));
  }

  /** Drop local state of a removed project's creation drafts (the backend deletes the files). */
  forgetProject(projectPath: string): void {
    for (const [key, entry] of [...this.entries]) {
      const scope = entry.scope;
      if (scope.kind !== "workspace" && scope.projectPath === projectPath) this.dropEntry(key);
    }
  }

  private dropEntry(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
    this.entries.delete(key);
    this.notify(key);
    return entry;
  }

  private getOrCreateEntry(scope: DraftStoreScope): Entry {
    const key = draftStoreScopeKey(scope);
    const existing = this.entries.get(key);
    if (existing) return existing;
    const entry: Entry = {
      scope,
      text: "",
      attachments: [],
      attachmentCount: 0,
      payloadsLoaded: true,
      payloadGeneration: 0,
      payloadLoad: null,
      queuedAttachmentUpdates: [],
      revision: Number.NEGATIVE_INFINITY,
      textVersion: 0,
      confirmedTextVersion: 0,
      attachmentsVersion: 0,
      confirmedAttachmentsVersion: 0,
      flushTimer: null,
      flushAttempt: 0,
      inFlight: null,
      failing: false,
      view: EMPTY_VIEW,
    };
    if (this.pendingDeletes.delete(key)) {
      // Editing a scope whose delete is unconfirmed cancels that delete. Mark both fields
      // unconfirmed so the next write replaces the whole stored draft, not just the edited field.
      entry.textVersion = 1;
      entry.attachmentsVersion = 1;
    }
    this.entries.set(key, entry);
    return entry;
  }

  private applyAttachments(entry: Entry, next: ChatAttachment[]): void {
    if (next === entry.attachments) return;
    entry.attachments = next;
    entry.attachmentCount = next.length;
    entry.attachmentsVersion++;
    this.recompute(entry);
    this.scheduleFlush(entry);
  }

  private recompute(entry: Entry): void {
    entry.view = {
      text: entry.text,
      attachments: entry.attachments,
      attachmentCount: entry.attachmentCount,
      payloadsLoaded: entry.payloadsLoaded,
    };
    this.notify(draftStoreScopeKey(entry.scope));
  }

  private notify(key: string): void {
    for (const listener of this.listeners.get(key) ?? []) listener();
  }

  private markReady(): void {
    this.clearReadyTimer();
    if (this.ready) return;
    this.ready = true;
    this.resolveReady();
    for (const listener of this.readyListeners) listener();
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  /** Apply server state to the fields without an unconfirmed local change. */
  private applyServerState(
    entry: Entry,
    text: string,
    attachments: readonly DraftAttachmentMetadata[]
  ): void {
    if (!isTextDirty(entry)) entry.text = text;
    if (!isAttachmentsDirty(entry)) {
      if (attachments.length === 0) {
        const queued = entry.queuedAttachmentUpdates;
        entry.attachments = [];
        entry.attachmentCount = 0;
        entry.payloadsLoaded = true;
        entry.queuedAttachmentUpdates = [];
        entry.payloadGeneration++;
        // Updates queued for the payloads apply to the (now known) empty list, not dropped.
        if (queued.length > 0) {
          this.applyAttachments(
            entry,
            queued.reduce<ChatAttachment[]>((current, update) => update(current), [])
          );
        }
      } else if (
        !entry.payloadsLoaded ||
        !matchesServerAttachments(entry.attachments, attachments)
      ) {
        // New or changed attachments: payloads come from `get`. Meanwhile keep showing the ones
        // that are still present, so a removal elsewhere does not flash the whole list away.
        const serverIds = new Set(attachments.map(({ id }) => id));
        entry.attachments = entry.attachments.filter(({ id }) => serverIds.has(id));
        entry.attachmentCount = attachments.length;
        entry.payloadsLoaded = false;
        entry.payloadGeneration++;
        if ((this.listeners.get(draftStoreScopeKey(entry.scope))?.size ?? 0) > 0) {
          this.ensurePayloads(entry.scope).catch((error: unknown) => {
            console.warn("Failed to load draft attachments:", error);
          });
        }
      }
    }
    this.recompute(entry);
    // A change elsewhere can make a refused (too large) unconfirmed edit fit again; that refusal
    // schedules no retry, so try once more. A no-op without an unconfirmed field or when a save
    // is already scheduled.
    if (this.hydrated) this.scheduleFlush(entry);
  }

  private applySnapshot(drafts: DraftSummary[]): void {
    const seen = new Set<string>();
    for (const summary of drafts) {
      if (this.pendingDeletes.has(draftStoreScopeKey(summary.scope))) continue;
      const entry = this.getOrCreateEntry(summary.scope);
      seen.add(draftStoreScopeKey(summary.scope));
      // Each subscription restarts the revision sequence, so a restarted backend is never ignored.
      entry.revision = summary.revision;
      this.applyServerState(entry, summary.text, summary.attachments);
    }
    for (const [key, entry] of this.entries) {
      if (entry.scope.kind !== "pending" && !seen.has(key)) {
        entry.revision = Number.NEGATIVE_INFINITY;
        this.applyServerState(entry, "", []);
      }
    }
  }

  private applyEvent(event: Exclude<DraftEvent, { type: "snapshot" }>): void {
    const key = draftScopeKey(event.scope);
    if (this.pendingDeletes.has(key)) return;
    const existing = this.entries.get(key);
    // Pushes that trail a newer write reply (or the snapshot) are stale.
    if (existing && event.revision <= existing.revision) return;
    if (event.type === "deleted") {
      if (!existing) return;
      existing.revision = event.revision;
      this.applyServerState(existing, "", []);
      return;
    }
    const entry = existing ?? this.getOrCreateEntry(event.scope);
    entry.revision = event.revision;
    this.applyServerState(entry, event.text, event.attachments);
  }

  private startSubscription(client: APIClient): void {
    if (this.resubscribeTimer) {
      clearTimeout(this.resubscribeTimer);
      this.resubscribeTimer = null;
    }
    const controller = new AbortController();
    this.subscription = controller;
    const { signal } = controller;
    if (!this.ready && !this.readyTimer) {
      // Startup must never hang on drafts (a subscription that never yields, a stuck legacy
      // import): let composers render after a bound. Writes still wait for hydration, and a late
      // snapshot never overwrites a field with an unconfirmed local change.
      this.readyTimer = setTimeout(() => {
        this.readyTimer = null;
        if (this.ready) return;
        console.warn(
          `Drafts did not load within ${DRAFT_STORE_READY_TIMEOUT_MS} ms; continuing while they load`
        );
        this.markReady();
      }, DRAFT_STORE_READY_TIMEOUT_MS);
    }

    const run = async () => {
      let iterator: AsyncIterator<DraftEvent> | null = null;
      try {
        const events = await client.drafts.subscribe(undefined, { signal });
        iterator = events;
        for await (const event of events) {
          if (signal.aborted) break;
          this.resubscribeAttempt = 0;
          if (event.type === "snapshot") {
            this.applySnapshot(event.drafts);
            // Before `ready`: composers must not start editing a scope whose legacy draft is still
            // being imported (the import would then find a backend draft and drop it). Runs on
            // every (re)subscription: keys whose import failed are retried, and without keys the
            // scan is cheap.
            await this.migrateLegacyDrafts(client);
            this.hydrated = true;
            this.markReady();
            for (const entry of this.entries.values()) this.scheduleFlush(entry);
            for (const key of [...this.pendingDeletes.keys()]) {
              this.sendDelete(key, 0).catch(() => undefined);
            }
          } else {
            this.applyEvent(event);
          }
        }
      } catch (error) {
        if (!signal.aborted && !isAbortError(error)) {
          console.error("Failed to subscribe to drafts:", error);
          // Self-heal: never hold the app on a broken subscription. Writes wait for hydration.
          this.markReady();
        }
      } finally {
        if (this.subscription === controller) this.subscription = null;
        if (!signal.aborted && this.client === client) {
          const delay = retryDelayMs(this.resubscribeAttempt++);
          this.resubscribeTimer = setTimeout(() => {
            this.resubscribeTimer = null;
            if (this.client === client && !this.subscription) this.startSubscription(client);
          }, delay);
        }
        try {
          // Close the iterator so the backend drops its listener.
          await iterator?.return?.();
        } catch {
          // Already closed.
        }
      }
    };
    run().catch((error: unknown) => console.error("Draft subscription failed:", error));
  }

  private stopSubscription(): void {
    this.clearReadyTimer();
    this.subscription?.abort();
    this.subscription = null;
    if (this.resubscribeTimer) {
      clearTimeout(this.resubscribeTimer);
      this.resubscribeTimer = null;
    }
  }

  /**
   * One-way migration of the legacy `input:<scope>` / `inputAttachments:<scope>` keys. The
   * backend stores a draft only when it has none (another origin, whose localStorage is separate,
   * may have imported or edited it already), and the keys are removed only after it answered.
   * On failure they stay and the next start retries. Legacy pending-scope drafts become new
   * creation drafts of their project, so the text stays visible; drafts of unknown workspaces or
   * projects are dropped ("orphaned").
   */
  private async migrateLegacyDrafts(client: APIClient): Promise<void> {
    const inputPrefix = getInputKey("");
    const attachmentsPrefix = getInputAttachmentsKey("");
    let scopeIds: Set<string>;
    try {
      scopeIds = new Set([
        ...listPersistedKeys(inputPrefix).map((key) => key.slice(inputPrefix.length)),
        ...listPersistedKeys(attachmentsPrefix).map((key) => key.slice(attachmentsPrefix.length)),
      ]);
    } catch (error) {
      console.warn("localStorage is unavailable; skipping the legacy draft import:", error);
      return;
    }
    for (const scopeId of scopeIds) {
      const inputKey = getInputKey(scopeId);
      const attachmentsKey = getInputAttachmentsKey(scopeId);
      const removeKeys = () => {
        updatePersistedState(inputKey, undefined);
        updatePersistedState(attachmentsKey, undefined);
      };
      const text = readPersistedString(inputKey) ?? "";
      // Malformed entries are dropped (the rest still migrates); unparseable values read as none.
      const { attachments } = sanitizeDraftAttachments(readLegacyJson(attachmentsKey));
      const legacyScope = legacyScopeFor(scopeId);
      if (legacyScope === null || (text.length === 0 && attachments.length === 0)) {
        removeKeys();
        continue;
      }
      const scope: DraftScope =
        legacyScope.kind === "pending"
          ? {
              kind: "creation",
              projectPath: legacyScope.projectPath,
              draftId: LEGACY_PENDING_DRAFT_ID,
            }
          : legacyScope;
      try {
        const reply = await client.drafts.importLegacy({ scope, text, attachments });
        if (reply.result === "applied") {
          const entry = this.getOrCreateEntry(scope);
          if (reply.revision > entry.revision) {
            entry.revision = reply.revision;
            if (!isTextDirty(entry)) entry.text = text;
            if (!isAttachmentsDirty(entry)) {
              entry.attachments = attachments;
              entry.attachmentCount = attachments.length;
              entry.payloadsLoaded = true;
            }
            this.recompute(entry);
          }
        }
        if (legacyScope.kind === "pending" && scope.kind === "creation") {
          if (reply.result !== "orphaned") {
            // Only a draft list entry leads a composer to the imported draft. Free the (large)
            // attachments key first so the entry fits in a full origin; if it still cannot be
            // written, keep the input key so the next start retries (the fixed draft id makes
            // the re-import find this copy).
            updatePersistedState(attachmentsKey, undefined);
            if (!listLegacyPendingDraft(scope.projectPath, scope.draftId)) {
              console.warn("Could not list an imported legacy draft; will retry on next start");
              continue;
            }
          }
          removeKeys();
          if (reply.result !== "orphaned") {
            // Scope-bound composer settings (model, workspace name...) follow the draft, as when
            // createWorkspaceDraft moves the default draft. Best-effort: settings, not the draft.
            try {
              migrateWorkspaceStorage(
                getPendingScopeId(scope.projectPath),
                getDraftScopeId(scope.projectPath, scope.draftId)
              );
            } catch (error) {
              console.warn("Failed to move legacy pending draft settings:", error);
            }
          }
          continue;
        }
        removeKeys();
      } catch (error) {
        console.warn("Failed to import a legacy draft; will retry on next start:", error);
        // The backend could not be consulted, so this bypasses the non-clobber rule on purpose:
        // if the snapshot has no draft for the scope, show the legacy one and let the normal write
        // path save it. Otherwise the composer starts empty, the user types, and the next import
        // answers "present" and drops the legacy keys: a guaranteed loss. The keys stay until a
        // later import confirms.
        const existing = this.entries.get(draftStoreScopeKey(scope));
        if (!existing || (existing.text.length === 0 && existing.attachmentCount === 0)) {
          this.setText(scope, text);
          this.setAttachments(scope, attachments);
        }
      }
    }
  }

  private scheduleFlush(entry: Entry): void {
    if (entry.scope.kind === "pending" || entry.flushTimer) return;
    if (!isTextDirty(entry) && !isAttachmentsDirty(entry)) return;
    entry.flushTimer = setTimeout(() => {
      entry.flushTimer = null;
      this.flushInBackground(entry);
    }, FLUSH_DEBOUNCE_MS);
  }

  private flushInBackground(entry: Entry): void {
    if (!this.hydrated) return;
    // Failures already scheduled a retry inside drain().
    this.drain(entry).catch(() => undefined);
  }

  private flushAllInBackground(): void {
    for (const entry of this.entries.values()) {
      if (entry.flushTimer) {
        clearTimeout(entry.flushTimer);
        entry.flushTimer = null;
      }
      if (isTextDirty(entry) || isAttachmentsDirty(entry)) this.flushInBackground(entry);
    }
  }

  /** One save-error notification per failure streak of a scope. */
  private reportSaveError(entry: Entry, key: string, error: unknown): void {
    if (entry.failing) return;
    const listeners = this.errorListeners.get(key);
    // Nobody shows this scope (e.g. its composer just unmounted): leave the streak unreported so
    // the next composer of the scope surfaces the next failure.
    if (!listeners || listeners.size === 0) return;
    entry.failing = true;
    const message = getErrorMessage(error);
    for (const listener of listeners) listener(message);
  }

  /** Send the unconfirmed fields until none remain, at most one request in flight per scope. */
  private async drain(entry: Entry): Promise<void> {
    const scope = entry.scope;
    if (scope.kind === "pending") return;
    const key = draftScopeKey(scope);
    while ((isTextDirty(entry) || isAttachmentsDirty(entry)) && this.entries.get(key) === entry) {
      if (entry.inFlight) {
        await entry.inFlight;
        continue;
      }
      const client = this.client;
      if (!client) throw new Error("Draft save failed: not connected");
      // The backend refuses drafts over the limit. That failure is permanent, so check here and
      // wait for the next change instead of pushing a multi-MB payload through the transport on
      // every retry. Only a loaded draft is measurable; otherwise the backend check applies.
      const bytes = entry.payloadsLoaded
        ? draftJsonBytes({ text: entry.text, attachments: entry.attachments })
        : 0;
      if (bytes > MAX_DRAFT_JSON_BYTES) {
        const error = new Error(draftTooLargeMessage(bytes));
        this.reportSaveError(entry, key, error);
        throw error;
      }
      const sendText = isTextDirty(entry);
      const sendAttachments = isAttachmentsDirty(entry);
      const textVersion = entry.textVersion;
      const attachmentsVersion = entry.attachmentsVersion;
      let settle: () => void = () => undefined;
      entry.inFlight = new Promise<void>((resolve) => {
        settle = resolve;
      });
      try {
        const reply = await client.drafts.update({
          scope,
          ...(sendText ? { text: entry.text } : {}),
          ...(sendAttachments ? { attachments: entry.attachments } : {}),
        });
        entry.flushAttempt = 0;
        entry.failing = false;
        if (sendText) {
          entry.confirmedTextVersion = Math.max(entry.confirmedTextVersion, textVersion);
        }
        if (sendAttachments) {
          entry.confirmedAttachmentsVersion = Math.max(
            entry.confirmedAttachmentsVersion,
            attachmentsVersion
          );
        }
        entry.revision = Math.max(entry.revision, reply.revision);
      } catch (error) {
        this.reportSaveError(entry, key, error);
        // The backend's size refusal (measurable only there while payloads are unloaded) is
        // permanent until the draft changes, like the local check above: no retry loop.
        if (isDraftTooLargeError(error)) throw error;
        // Keep the change (never silently drop it) and retry with backoff.
        const delay = retryDelayMs(entry.flushAttempt++);
        if (entry.flushTimer) clearTimeout(entry.flushTimer);
        entry.flushTimer = setTimeout(() => {
          entry.flushTimer = null;
          this.flushInBackground(entry);
        }, delay);
        throw error;
      } finally {
        entry.inFlight = null;
        settle();
      }
    }
  }
}

let storeInstance: DraftStore | null = null;

export function getDraftStore(): DraftStore {
  storeInstance ??= new DraftStore();
  return storeInstance;
}

/** The draft of one scope; re-renders only when that scope changes. */
export function useDraft(scope: DraftStoreScope): DraftView {
  const store = getDraftStore();
  return useSyncExternalStore(
    (listener) => store.subscribe(scope, listener),
    () => store.getView(scope)
  );
}

/** True once drafts are hydrated (or hydration failed and the app must not wait for it). */
export function useDraftStoreReady(): boolean {
  const store = getDraftStore();
  return useSyncExternalStore(store.subscribeReady, () => store.isReady());
}
