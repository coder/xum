import { useSyncExternalStore } from "react";
import type { APIClient } from "@/browser/contexts/API";
import type {
  ChatAttachment,
  StagedChatAttachment,
} from "@/browser/features/ChatInput/ChatAttachments";
import {
  listPersistedKeys,
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
  WORKSPACE_DRAFTS_BY_PROJECT_KEY,
} from "@/common/constants/storage";
import { migrateWorkspaceStorage } from "@/browser/utils/workspaceStorage";
import type {
  BasisSend,
  DraftAttachment,
  DraftAttachmentMetadata,
  DraftEvent,
  DraftList,
  DraftListEntry,
  DraftScope,
  DraftSummary,
  DraftWriteOutput,
  PendingSend,
  SendStatus,
} from "@/common/orpc/schemas/drafts";
import type { FilePart } from "@/common/orpc/types";
import { joinDraftText, removeSentText } from "@/common/utils/composerDraftText";
import {
  draftJsonBytes,
  draftScopeKey,
  draftTooLargeMessage,
  isDraftTooLargeError,
  retainedAttachmentIds,
  sanitizeDraftAttachments,
  toDraftAttachmentMetadata,
} from "@/common/utils/drafts";
import { getErrorMessage } from "@/common/utils/errors";
import {
  DEFAULT_CREATION_DRAFT_ID,
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
  /** The visible text (without the text pending sends retain). */
  text: string;
  /**
   * Visible attachments with payloads; empty until the payloads of a hydrated draft are loaded.
   * Attachments pending sends retain are hidden.
   */
  attachments: ChatAttachment[];
  /** Visible attachments the draft holds, including ones whose payloads are still loading. */
  attachmentCount: number;
  payloadsLoaded: boolean;
  /**
   * Pending sends whose acceptance is unresolved (the receiver answered unknown, or the lookup or
   * send failed): the composer stays in its sending state (ComposerSends FixRenderer).
   */
  unresolvedSendCount: number;
}

/** A send's acceptance as this window last learned it (see DraftStore.settleSend). */
export type SendOutcome = Exclude<SendStatus, "unknown"> | "unresolved" | "resolved-elsewhere";

/** A composer send handed to DraftStore.beginSend. */
export interface BeginSendInput {
  sendId: string;
  /** What the user typed (shown again if the send is not accepted). */
  text: string;
  /** The attachments the send takes (provider ones are its file parts, in this order). */
  attachments: ChatAttachment[];
  request: PendingSend["request"];
}

/**
 * Idempotent-send bookkeeping per workspace draft, in memory (the entries themselves are in the
 * draft file, see PendingSendSchema).
 */
interface SendTracking {
  /**
   * Sends this window has a request in flight for (from beginSend until its reply): never looked
   * up from here, since a lookup before the request reaches the receiver makes the receiver
   * refuse it for good (ComposerSends Register).
   */
  issuing: Set<string>;
  /**
   * The latest answer per id; "failed": the lookup itself failed. Only for ids the draft still
   * has pending or a settleSend still waits on (pruned in recompute).
   */
  lastStatus: Map<string, SendStatus | "failed">;
  /** Ids a settleSend waits on: their answer stays until it reads it. */
  settling: Set<string>;
  /** One resolution at a time; a trigger during one runs another after it. */
  resolving: Promise<void> | null;
  rerun: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryAttempt: number;
  /** Aborts the automatic retry batch (Stop); a trigger starts a new one. */
  retryAbort: AbortController;
  /** The receiver each send begun here went to (for settleSend's direct lookup). */
  sentTo: Map<string, string>;
  /** Automatic re-sends in flight, with the receiver each went to (Stop fences them). */
  resending: Map<string, string>;
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
  /** Retry of a failed payload load, while someone still needs the payloads. */
  payloadRetryTimer: ReturnType<typeof setTimeout> | null;
  payloadAttempt: number;
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
  /**
   * Pending sends (server state, plus sends begun here that the backend has not confirmed yet).
   * Their text is not in `text`; their attachments are in `attachments`, hidden from the view.
   */
  pendingSends: PendingSend[];
  /** Sends begun here whose beginSend reply has not arrived (kept over older server pushes). */
  localSends: Map<string, PendingSend>;
  /**
   * Every pending send this window has seen since its fields were last in sync with the backend
   * (BasisSendSchema). Each write names them, and the backend merges what happened to them since
   * (DraftService mergeWrite): this window never merges send results into its unsaved fields.
   * Kept across reconnects while a field is unsaved or a write is in flight.
   */
  basisSends: Map<string, BasisSend>;
  /**
   * The newest server view (any push, snapshot or write reply). A field with an unsaved edit
   * keeps the edit; once its write is confirmed, the field takes this view.
   */
  serverView: {
    revision: number;
    text: string;
    attachments: readonly DraftAttachmentMetadata[];
    pendingSends: readonly PendingSend[];
  } | null;
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
  unresolvedSendCount: 0,
};
/** Automatic retries of an unresolved send per batch (a trigger starts a new batch). */
const SEND_RETRY_LIMIT = 5;
const SEND_RETRY_BASE_MS = 1_000;
const SEND_RETRY_MAX_MS = 16_000;
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

/** A field has an unsaved edit or a write is in flight: the backend has not merged it yet. */
function isUnsynced(entry: Entry): boolean {
  return isTextDirty(entry) || isAttachmentsDirty(entry) || entry.inFlight !== null;
}

/**
 * Attachments the composer does not show: those pending sends retain (except sends this window
 * undid) and, while this window's list has an unsaved edit (until its write is confirmed), those
 * of every send it wrote against (the backend decides whether they come back).
 */
function hiddenAttachmentIds(entry: Entry): Set<string> {
  const undone = new Set(
    [...entry.basisSends.values()].filter((send) => send.undone === true).map((s) => s.sendId)
  );
  const hidden = retainedAttachmentIds(
    entry.pendingSends.filter(({ sendId }) => !undone.has(sendId))
  );
  if (isAttachmentsDirty(entry)) {
    for (const send of entry.basisSends.values()) {
      if (send.undone !== true) for (const id of send.attachmentIds) hidden.add(id);
    }
  }
  return hidden;
}

/** The composer's attachments: those not hidden (see hiddenAttachmentIds). */
function visibleAttachments(entry: Entry): ChatAttachment[] {
  const hidden = hiddenAttachmentIds(entry);
  return hidden.size === 0
    ? entry.attachments
    : entry.attachments.filter(({ id }) => !hidden.has(id));
}

/** Replace the visible attachments, keeping the hidden ones (first, as the backend stores them). */
function withVisibleAttachments(
  entry: Entry,
  all: ChatAttachment[],
  visible: ChatAttachment[]
): ChatAttachment[] {
  const hidden = hiddenAttachmentIds(entry);
  if (hidden.size === 0) return visible;
  return [
    ...all.filter(({ id }) => hidden.has(id)),
    ...visible.filter(({ id }) => !hidden.has(id)),
  ];
}

/**
 * Remember the pending sends this window sees (see Entry.basisSends), and whether its unsaved
 * text holds a send's text then (a stale copy the backend takes out if the send stays gone).
 */
function observeSends(entry: Entry, sends: readonly PendingSend[]): void {
  for (const { sendId, text, attachmentIds } of sends) {
    if (entry.basisSends.has(sendId)) continue;
    const inUnsavedText = isTextDirty(entry) && removeSentText(entry.text, text) !== entry.text;
    entry.basisSends.set(sendId, {
      sendId,
      text,
      attachmentIds,
      ...(inUnsavedText ? { inUnsavedText } : {}),
    });
  }
}

/** Server pending sends plus the ones begun here and not confirmed yet. */
function mergePendingSends(entry: Entry, server: readonly PendingSend[]): PendingSend[] {
  const ids = new Set(server.map(({ sendId }) => sendId));
  return [...server, ...[...entry.localSends.values()].filter(({ sendId }) => !ids.has(sendId))];
}

/** A send's provider file parts, rebuilt from the draft attachments in the send's order. */
function filePartsOf(send: PendingSend, attachments: readonly ChatAttachment[]): FilePart[] {
  return send.attachmentIds.flatMap((id) => {
    const attachment = attachments.find((candidate) => candidate.id === id);
    if (attachment === undefined) throw new Error(`Pending send attachment ${id} is missing`);
    return attachment.kind === "provider"
      ? [
          {
            url: attachment.url,
            mediaType: attachment.mediaType,
            ...(attachment.filename !== undefined ? { filename: attachment.filename } : {}),
          },
        ]
      : [];
  });
}

function sendRetryDelayMs(attempt: number): number {
  return Math.min(SEND_RETRY_BASE_MS * 2 ** attempt, SEND_RETRY_MAX_MS);
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

/** A listed creation draft (a sidebar row under its project); see DraftListEntrySchema. */
export interface WorkspaceDraft {
  draftId: string;
  subProjectPath: string | null;
  createdAt: number;
}

export type CreationDraftsByProject = Record<string, WorkspaceDraft[]>;

interface PendingListPut {
  entry: DraftListEntry;
  attempt: number;
  /** List revision of the backend's reply; the put is done once the list reached it. */
  confirmedRevision: number | null;
  /** The request in flight: one at a time per draft, so an older value never lands last. */
  sending: Promise<void> | null;
}

function listEntryKey(entry: { projectPath: string; draftId: string }): string {
  return draftScopeKey({
    kind: "creation",
    projectPath: entry.projectPath,
    draftId: entry.draftId,
  });
}

/** Parse the legacy `workspaceDraftsByProject` value; malformed entries are dropped. */
function parseLegacyDraftList(raw: unknown): DraftListEntry[] {
  if (typeof raw !== "object" || raw === null) return [];
  const entries: DraftListEntry[] = [];
  for (const [projectPath, drafts] of Object.entries(raw as Record<string, unknown>)) {
    if (projectPath.length === 0 || !Array.isArray(drafts)) continue;
    for (const draft of drafts as unknown[]) {
      const record = draft as { draftId?: unknown; subProjectPath?: unknown; createdAt?: unknown };
      if (
        typeof record !== "object" ||
        record === null ||
        typeof record.draftId !== "string" ||
        !DRAFT_ID_PATTERN.test(record.draftId) ||
        record.draftId === DEFAULT_CREATION_DRAFT_ID ||
        typeof record.createdAt !== "number" ||
        !Number.isFinite(record.createdAt)
      ) {
        continue;
      }
      const subProjectPath =
        typeof record.subProjectPath === "string" && record.subProjectPath.trim().length > 0
          ? record.subProjectPath
          : null;
      entries.push({
        projectPath,
        draftId: record.draftId,
        subProjectPath,
        createdAt: record.createdAt,
      });
    }
  }
  return entries;
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
  /**
   * The creation draft list (sidebar rows), owned by the backend (drafts/list.json). The view
   * overlays puts the list has not reflected yet and hides pending deletes.
   */
  private serverList: DraftListEntry[] = [];
  private serverListRevision = Number.NEGATIVE_INFINITY;
  private readonly pendingListPuts = new Map<string, PendingListPut>();
  /**
   * The legacy localStorage list, shown (where the backend list lacks an entry) until its import
   * is reflected, or for the whole session when the import failed (the next start retries).
   */
  private legacyListFallback: DraftListEntry[] = [];
  private legacyListFallbackRevision: number | null = null;
  private creationDrafts: CreationDraftsByProject = {};
  private readonly listListeners = new Set<() => void>();
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private subscription: AbortController | null = null;
  /** Idempotent sends, per workspace draft key (see SendTracking). */
  private readonly sendTracking = new Map<string, SendTracking>();
  /** The receiver (backend process) of the current client's connection (getSendStatus). */
  private receiver: { client: APIClient; receiverId: string } | null = null;
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

  /** Delay before automatic send retry `attempt` (bounded backoff; injectable for tests). */
  private readonly sendRetryDelayMs: (attempt: number) => number;

  constructor(options?: { sendRetryDelayMs?: (attempt: number) => number }) {
    this.sendRetryDelayMs = options?.sendRetryDelayMs ?? sendRetryDelayMs;
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
    // A new connection may reach another backend process: ask for its receiver id again.
    this.receiver = null;
    // A retry scheduled for the old connection must not outlive it; the new connection's
    // snapshot resolves the entries again and re-arms retries.
    for (const tracking of this.sendTracking.values()) {
      if (tracking.retryTimer) clearTimeout(tracking.retryTimer);
      tracking.retryTimer = null;
    }
    this.stopSubscription();
    if (client) this.startSubscription(client);
  }

  isReady(): boolean {
    return this.ready;
  }

  /** A real snapshot was applied (ready can also mean the wait for one timed out). */
  isHydrated(): boolean {
    return this.hydrated;
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

  subscribeCreationDrafts = (listener: () => void): (() => void) => {
    this.listListeners.add(listener);
    return () => this.listListeners.delete(listener);
  };

  /** Listed creation drafts by project, in list order (a stable reference between changes). */
  getCreationDraftsByProject(): CreationDraftsByProject {
    return this.creationDrafts;
  }

  /**
   * List a creation draft, or change a listed draft's sub-project. Shown at once; sent (and
   * retried) until the backend confirms.
   */
  putCreationDraft(projectPath: string, draft: WorkspaceDraft): void {
    const entry: DraftListEntry = { projectPath, ...draft };
    const key = listEntryKey(entry);
    let pending = this.pendingListPuts.get(key);
    if (pending) {
      // A request in flight sends this value once it settles (see sendListPut).
      pending.entry = entry;
      pending.confirmedRevision = null;
    } else {
      pending = { entry, attempt: 0, confirmedRevision: null, sending: null };
      this.pendingListPuts.set(key, pending);
    }
    this.recomputeList();
    this.startListPut(key, pending);
  }

  private startListPut(key: string, pending: PendingListPut): void {
    if (pending.sending) return;
    const sending = this.sendListPut(key, pending).finally(() => {
      if (pending.sending === sending) pending.sending = null;
    });
    pending.sending = sending;
  }

  /** Never rejects. */
  private async sendListPut(key: string, pending: PendingListPut): Promise<void> {
    const client = this.client;
    // Puts wait for hydration: the legacy list import runs first, and the first import (before a
    // list.json exists) also lists orphaned draft bodies. The snapshot handler resends.
    if (!client || !this.hydrated || this.pendingListPuts.get(key) !== pending) return;
    const sent = pending.entry;
    try {
      const { revision } = await client.drafts.putListEntry(sent);
      if (this.pendingListPuts.get(key) !== pending) return;
      // Changed while in flight: send the latest value (still one request at a time).
      if (pending.entry !== sent) return await this.sendListPut(key, pending);
      pending.confirmedRevision = revision;
      this.settleList();
    } catch (error) {
      console.warn("Failed to list a creation draft; retrying:", error);
      // Retried through whichever client is current: a reconnect's resend was skipped while this
      // request was in flight.
      setTimeout(() => this.startListPut(key, pending), retryDelayMs(pending.attempt++));
    }
  }

  private applyList(list: DraftList): void {
    this.serverList = list.entries;
    this.serverListRevision = list.revision;
    this.settleList();
  }

  /** Drop overlays the backend list now reflects, then recompute the view. */
  private settleList(): void {
    for (const [key, pending] of this.pendingListPuts) {
      if (
        pending.confirmedRevision !== null &&
        pending.confirmedRevision <= this.serverListRevision
      ) {
        this.pendingListPuts.delete(key);
      }
    }
    if (
      this.legacyListFallbackRevision !== null &&
      this.legacyListFallbackRevision <= this.serverListRevision
    ) {
      this.legacyListFallback = [];
      this.legacyListFallbackRevision = null;
    }
    this.recomputeList();
  }

  private recomputeList(): void {
    const merged = new Map<string, DraftListEntry>();
    for (const entry of this.serverList) merged.set(listEntryKey(entry), entry);
    for (const entry of this.legacyListFallback) {
      const key = listEntryKey(entry);
      if (!merged.has(key)) merged.set(key, entry);
    }
    for (const [key, { entry }] of this.pendingListPuts) merged.set(key, entry);
    for (const key of this.pendingDeletes.keys()) merged.delete(key);
    const byProject: CreationDraftsByProject = {};
    for (const { projectPath, ...draft } of merged.values()) {
      (byProject[projectPath] ??= []).push(draft);
    }
    this.creationDrafts = byProject;
    for (const listener of this.listListeners) listener();
  }

  /** Drop a creation draft from the local list (the backend delete delists it too). */
  private dropListEntry(key: string): void {
    this.pendingListPuts.delete(key);
    this.serverList = this.serverList.filter((entry) => listEntryKey(entry) !== key);
    this.legacyListFallback = this.legacyListFallback.filter(
      (entry) => listEntryKey(entry) !== key
    );
    this.recomputeList();
  }

  getView(scope: DraftStoreScope): DraftView {
    return this.entries.get(draftStoreScopeKey(scope))?.view ?? EMPTY_VIEW;
  }

  /** Ids of the draft's pending sends (their text and attachments are retained, hidden). */
  getPendingSendIds(scope: DraftStoreScope): Set<string> {
    const entry = this.entries.get(draftStoreScopeKey(scope));
    return new Set((entry?.pendingSends ?? []).map(({ sendId }) => sendId));
  }

  /**
   * What a restored input (a queue edit, a Stop restore) holds beyond the draft's pending sends
   * among `sendIds`: their text and attachments come back through their entries, so the
   * composer inserts only the rest. Text is taken out only where removeSentText finds it, file
   * parts by url and staged attachments by path; anything not found stays (a visible duplicate
   * beats a loss).
   */
  withoutRetainedSends<
    T extends { text: string; fileParts: FilePart[]; stagedAttachments?: StagedChatAttachment[] },
  >(scope: DraftStoreScope, sendIds: readonly string[], input: T): T {
    const entry = this.entries.get(draftStoreScopeKey(scope));
    if (!entry) return input;
    const ids = new Set(sendIds);
    let text = input.text;
    let fileParts = input.fileParts;
    let stagedAttachments = input.stagedAttachments;
    for (const send of entry.pendingSends) {
      if (!ids.has(send.sendId)) continue;
      // The message as sent (with its notes) first, else the composer text it came from.
      const withoutMessage = removeSentText(text, send.request.message);
      text = withoutMessage !== text ? withoutMessage : removeSentText(text, send.text);
      for (const id of send.attachmentIds) {
        const attachment = entry.attachments.find((candidate) => candidate.id === id);
        if (attachment?.kind === "provider") {
          const index = fileParts.findIndex(({ url }) => url === attachment.url);
          if (index >= 0) fileParts = fileParts.filter((_, i) => i !== index);
        } else if (attachment?.kind === "staged" && stagedAttachments) {
          const index = stagedAttachments.findIndex(
            ({ stagedPath }) => stagedPath === attachment.stagedPath
          );
          if (index >= 0) stagedAttachments = stagedAttachments.filter((_, i) => i !== index);
        }
      }
    }
    return { ...input, text, fileParts, stagedAttachments };
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
  setAttachments(scope: DraftStoreScope, input: ChatAttachment[] | AttachmentUpdate): void {
    const entry = this.getOrCreateEntry(scope);
    if (typeof input !== "function") {
      // A full replacement does not depend on the unloaded payloads (retained attachments stay
      // on the backend, which keeps them whatever the composer writes).
      entry.payloadsLoaded = true;
      entry.queuedAttachmentUpdates = [];
      this.applyAttachments(entry, withVisibleAttachments(entry, entry.attachments, input));
      return;
    }
    // Callers edit the visible attachments; the retained ones are kept as they are.
    const value: AttachmentUpdate = (all) =>
      withVisibleAttachments(
        entry,
        all,
        input(all.filter(({ id }) => !hiddenAttachmentIds(entry).has(id)))
      );
    if (
      entry.payloadsLoaded &&
      this.client !== null &&
      !this.hydrated &&
      entry.scope.kind !== "pending" &&
      entry.revision === Number.NEGATIVE_INFINITY &&
      !isAttachmentsDirty(entry)
    ) {
      // Before the first snapshot (composers render after the readiness timeout) the server's
      // attachments are unknown: an update applied onto the empty local list would replace them.
      // Load them first, like a hydrated draft's payloads.
      entry.payloadsLoaded = false;
      this.recompute(entry);
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
        entry.payloadAttempt = 0;
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
      } catch (error) {
        this.schedulePayloadRetry(entry, key);
        throw error;
      } finally {
        if (entry.payloadLoad === current.load) entry.payloadLoad = null;
      }
    })();
    entry.payloadLoad = current.load;
    return current.load;
  }

  /**
   * After a failed payload load, retry with backoff while the payloads are needed: queued
   * attachment updates stay invisible and unsaved until they load, and a shown draft's
   * attachments (and its Send) stay unavailable until a later event, which may never come.
   */
  private schedulePayloadRetry(entry: Entry, key: string): void {
    const needed =
      entry.queuedAttachmentUpdates.length > 0 || (this.listeners.get(key)?.size ?? 0) > 0;
    if (entry.payloadRetryTimer || !needed) return;
    entry.payloadRetryTimer = setTimeout(() => {
      entry.payloadRetryTimer = null;
      if (this.entries.get(key) !== entry) return;
      // A further failure schedules the next attempt.
      this.ensurePayloads(entry.scope).catch(() => undefined);
    }, retryDelayMs(entry.payloadAttempt++));
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
    // An attachment update waiting for the payloads is not saved yet: apply it (by loading them)
    // first, so this never confirms a draft without it. A failed load rejects.
    if (entry.queuedAttachmentUpdates.length > 0) await this.ensurePayloads(scope);
    await this.drain(entry);
  }

  /**
   * Idempotent sends (ComposerSends.tla FixRenderer): the one durable draft write before a
   * workspace composer send. The sent text leaves the visible text and, with the sent
   * attachments, stays in the draft (retained, hidden) under a pending-send entry until the
   * backend answers for the id (resolveSends). Rejects when the write fails: then nothing was
   * taken, and the caller must not send.
   */
  async beginSend(
    scope: Extract<DraftScope, { kind: "workspace" }>,
    input: BeginSendInput
  ): Promise<void> {
    const key = draftScopeKey(scope);
    await this.readyPromise;
    const client = this.client;
    if (!client || !this.hydrated) throw new Error("Draft save failed: drafts are not loaded");
    const entry = this.getOrCreateEntry(scope);
    const tracking = this.trackingFor(key);
    // From now until the send's reply this window never looks the id up (see SendTracking).
    tracking.issuing.add(input.sendId);
    // A new send re-arms automatic retries a Stop aborted.
    if (tracking.retryAbort.signal.aborted) {
      tracking.retryAbort = new AbortController();
      tracking.retryAttempt = 0;
    }
    try {
      const receiverId = await this.getReceiverId(client, scope.workspaceId);
      // One write at a time per draft: an update in flight lands first.
      while (entry.inFlight) await entry.inFlight;
      // Revalidated after the awaits: nothing is taken from a draft deleted (or a connection
      // replaced) meanwhile.
      if (this.entries.get(key) !== entry || this.client !== client) {
        throw new Error("Draft save failed: the draft changed before the send");
      }
      const pendingSend: PendingSend = {
        sendId: input.sendId,
        receiverId,
        text: input.text,
        attachmentIds: input.attachments.map(({ id }) => id),
        request: input.request,
      };
      const textBefore = entry.text;
      const unsavedText = isTextDirty(entry) ? textBefore : undefined;
      const missing = input.attachments.filter(
        (sent) => !entry.attachments.some(({ id }) => id === sent.id)
      );
      // Optimistic, as the old clear was: the composer hides what the send took at once.
      entry.localSends.set(pendingSend.sendId, pendingSend);
      entry.pendingSends = [...entry.pendingSends, pendingSend];
      if (missing.length > 0) {
        entry.attachments = [...entry.attachments, ...missing];
        entry.attachmentCount += missing.length;
      }
      const textAfter = removeSentText(textBefore, input.text);
      if (textAfter !== textBefore) {
        entry.text = textAfter;
        entry.textVersion++;
      }
      const removalVersion = entry.textVersion;
      this.recompute(entry);
      const basisSends = [...entry.basisSends.values()];
      let settle: () => void = () => undefined;
      entry.inFlight = new Promise<void>((resolve) => {
        settle = resolve;
      });
      let reply: DraftWriteOutput;
      try {
        reply = await client.drafts.beginSend({
          scope,
          pendingSend,
          attachments: input.attachments,
          ...(unsavedText !== undefined ? { text: unsavedText } : {}),
          ...(basisSends.length > 0 ? { basisSends } : {}),
        });
        // The backend took the same text out of the same (or this window's unsaved) text.
        entry.confirmedTextVersion = Math.max(entry.confirmedTextVersion, removalVersion);
        entry.localSends.delete(pendingSend.sendId);
        tracking.sentTo.set(pendingSend.sendId, receiverId);
      } catch (error) {
        // The reply is lost, not proof that nothing was written: the write may have landed.
        // This window shows the send again and marks it undone, so its writes never show it a
        // second time while the backend holds it; its lookup returns it if it did land (it was
        // never sent). Never a duplicate, never a loss.
        entry.localSends.delete(pendingSend.sendId);
        entry.pendingSends = entry.pendingSends.filter(
          ({ sendId }) => sendId !== pendingSend.sendId
        );
        entry.basisSends.set(pendingSend.sendId, {
          sendId: pendingSend.sendId,
          text: pendingSend.text,
          attachmentIds: pendingSend.attachmentIds,
          undone: true,
        });
        if (entry.text !== textBefore && removeSentText(entry.text, input.text) === entry.text) {
          entry.text = joinDraftText(input.text, entry.text);
          entry.textVersion++;
        }
        throw error;
      } finally {
        entry.inFlight = null;
        settle();
      }
      this.applyWriteReply(entry, reply, { text: true, attachments: false });
    } catch (error) {
      tracking.issuing.delete(input.sendId);
      if (this.entries.get(key) === entry) {
        this.recompute(entry);
        this.scheduleFlush(entry);
        if (entry.basisSends.get(input.sendId)?.undone === true) {
          this.triggerSendResolution(scope.workspaceId);
        }
      }
      throw error;
    }
  }

  /**
   * After a send's reply (Ok, Err or a throw): look the id up and return what this window
   * learned. "pending": the receiver runs, queues or holds it (the text stays retained, the
   * composer is usable); "unresolved": unknown or the lookup failed (automatic retries run and
   * the composer stays sending); "resolved-elsewhere": another window resolved it first.
   */
  async settleSend(
    scope: Extract<DraftScope, { kind: "workspace" }>,
    sendId: string
  ): Promise<SendOutcome> {
    const key = draftScopeKey(scope);
    const tracking = this.trackingFor(key);
    tracking.issuing.delete(sendId);
    tracking.lastStatus.delete(sendId);
    tracking.settling.add(sendId);
    let status: SendStatus | "failed" | undefined;
    try {
      await this.resolveSends(scope.workspaceId);
      status = tracking.lastStatus.get(sendId);
    } finally {
      tracking.settling.delete(sendId);
      const entry = this.entries.get(key);
      if (entry) this.recompute(entry);
    }
    // Another window resolved it first (its push removed the entry before this lookup): ask
    // the receiver it went to for this id directly. Its accepted answer comes from the durable
    // row; another receiver's "unknown" is never taken as a refusal.
    const receiverId = tracking.sentTo.get(sendId);
    tracking.sentTo.delete(sendId);
    if (status === undefined && receiverId !== undefined) {
      status = await this.lookupSendStatus(scope.workspaceId, sendId, receiverId);
    }
    if (status === undefined) return "resolved-elsewhere";
    return status === "unknown" || status === "failed" ? "unresolved" : status;
  }

  /**
   * A resolution trigger (load, reconnect, chat events): look up every pending send of the
   * workspace draft and start a new automatic retry batch for the unresolved ones. Idempotent.
   * After a Stop only load, reconnect or a new send (`afterStop`) re-arms retries; chat events
   * (Stop itself emits some) still look the sends up.
   */
  triggerSendResolution(workspaceId: string, options?: { afterStop?: boolean }): void {
    const tracking = this.trackingFor(draftScopeKey({ kind: "workspace", workspaceId }));
    if (!tracking.retryAbort.signal.aborted) tracking.retryAttempt = 0;
    else if (options?.afterStop === true) {
      tracking.retryAttempt = 0;
      tracking.retryAbort = new AbortController();
    }
    this.resolveSends(workspaceId).catch((error: unknown) =>
      console.warn("Failed to resolve pending sends:", error)
    );
  }

  /**
   * A chat event that can change a send's status. A user row triggers only when it carries the
   * id of a send pending here; other events (queue, held input, restore, stream end) whenever
   * the workspace draft has pending sends.
   */
  onSendEvent(workspaceId: string, rowSendIds?: readonly string[]): void {
    const entry = this.entries.get(draftScopeKey({ kind: "workspace", workspaceId }));
    if (!entry || entry.pendingSends.length === 0) return;
    if (
      rowSendIds !== undefined &&
      !entry.pendingSends.some(({ sendId }) => rowSendIds.includes(sendId))
    ) {
      return;
    }
    this.triggerSendResolution(workspaceId);
  }

  /**
   * The receiver's queue holds these ids, so their requests arrived: a lookup can no longer get
   * ahead of them (see SendTracking.issuing). Then resolve as for any queue change.
   */
  onQueuedSends(workspaceId: string, queuedSendIds: readonly string[]): void {
    const tracking = this.sendTracking.get(draftScopeKey({ kind: "workspace", workspaceId }));
    for (const id of queuedSendIds) tracking?.issuing.delete(id);
    this.onSendEvent(workspaceId);
  }

  /** Stop: no further automatic re-send or lookup until the next trigger. */
  async abortSendRetries(workspaceId: string): Promise<void> {
    const tracking = this.sendTracking.get(draftScopeKey({ kind: "workspace", workspaceId }));
    if (!tracking) return;
    tracking.retryAbort.abort();
    if (tracking.retryTimer) clearTimeout(tracking.retryTimer);
    tracking.retryTimer = null;
    // A re-send already on its way cannot be called back, and awaiting its reply proves nothing
    // (a lost reply). Ask its receiver about it before Stop's interrupt goes out: one that has
    // not arrived is refused for good (getSendStatus records the refusal), and one that has is
    // running, queued or held there, where the interrupt reaches it.
    await Promise.all(
      [...tracking.resending].map(([sendId, receiverId]) =>
        this.lookupSendStatus(workspaceId, sendId, receiverId)
      )
    );
  }

  private trackingFor(key: string): SendTracking {
    let tracking = this.sendTracking.get(key);
    if (!tracking) {
      tracking = {
        issuing: new Set(),
        lastStatus: new Map(),
        settling: new Set(),
        resolving: null,
        rerun: false,
        retryTimer: null,
        retryAttempt: 0,
        retryAbort: new AbortController(),
        sentTo: new Map(),
        resending: new Map(),
      };
      this.sendTracking.set(key, tracking);
    }
    return tracking;
  }

  /** This connection's receiver id (an empty getSendStatus lookup, once per client). */
  private async getReceiverId(client: APIClient, workspaceId: string): Promise<string> {
    if (this.receiver?.client === client) return this.receiver.receiverId;
    const result = await client.workspace.getSendStatus({ workspaceId, sendIds: [] });
    if (!result.success) throw new Error(`Send receiver lookup failed: ${result.error}`);
    if (this.client === client) this.receiver = { client, receiverId: result.data.receiverId };
    return result.data.receiverId;
  }

  /** One id's status from this connection's receiver; undefined when the lookup fails. */
  private async lookupSendStatus(
    workspaceId: string,
    sendId: string,
    receiverId: string
  ): Promise<SendStatus | undefined> {
    const client = this.client;
    if (!client) return undefined;
    try {
      const result = await client.workspace.getSendStatus({
        workspaceId,
        sendIds: [sendId],
        receiverId,
      });
      if (!result.success) return undefined;
      return result.data.statuses.find((entry) => entry.sendId === sendId)?.status;
    } catch {
      return undefined;
    }
  }

  /** One resolution at a time per draft; a trigger during one runs another right after. */
  private resolveSends(workspaceId: string): Promise<void> {
    const scope: Extract<DraftScope, { kind: "workspace" }> = { kind: "workspace", workspaceId };
    const tracking = this.trackingFor(draftScopeKey(scope));
    if (tracking.resolving) {
      tracking.rerun = true;
      return tracking.resolving.then(() => tracking.resolving ?? Promise.resolve());
    }
    const run = async () => {
      do {
        tracking.rerun = false;
        await this.resolveOnce(scope, tracking);
      } while (tracking.rerun);
    };
    const resolving = run().finally(() => {
      if (tracking.resolving === resolving) tracking.resolving = null;
    });
    tracking.resolving = resolving;
    return resolving;
  }

  private async resolveOnce(
    scope: Extract<DraftScope, { kind: "workspace" }>,
    tracking: SendTracking
  ): Promise<void> {
    const key = draftScopeKey(scope);
    const client = this.client;
    const entry = this.entries.get(key);
    const candidates = (entry?.pendingSends ?? []).filter(
      ({ sendId }) => !tracking.issuing.has(sendId)
    );
    // A send undone here (lost draft-write reply) may be pending on the backend all the same.
    const undone = [...(entry?.basisSends.values() ?? [])].filter(
      ({ sendId, undone }) => undone === true && !tracking.issuing.has(sendId)
    );
    if (!client || (candidates.length === 0 && undone.length === 0)) return;
    try {
      const reply = await client.drafts.resolveSends({
        scope,
        exceptSendIds: [...tracking.issuing],
      });
      if (reply.receiverId !== undefined && this.client === client) {
        this.receiver = { client, receiverId: reply.receiverId };
      }
      for (const { sendId, status } of reply.statuses) tracking.lastStatus.set(sendId, status);
    } catch (error) {
      console.warn("Pending send lookup failed; retrying:", error);
      for (const { sendId } of candidates) tracking.lastStatus.set(sendId, "failed");
    }
    // Forget answers of entries that are gone (resolved here or elsewhere).
    const current = this.entries.get(key);
    if (current) this.recompute(current);
    this.scheduleSendRetry(scope, tracking);
  }

  /** Ids of this draft whose last answer keeps them unresolved. */
  private unresolvedSends(key: string, tracking: SendTracking): PendingSend[] {
    return (this.entries.get(key)?.pendingSends ?? []).filter(({ sendId }) => {
      const status = tracking.lastStatus.get(sendId);
      return !tracking.issuing.has(sendId) && (status === "unknown" || status === "failed");
    });
  }

  /**
   * Bounded automatic retries with backoff (ComposerSends Retry): "failed" looks up again;
   * "unknown" (a receiver that is not this connection's) first moves the entry to the current
   * receiver, then re-sends the same id with the same request. "pending" waits. When the batch
   * runs out, the entries keep their text, attachments and id and the composer stays sending
   * until a trigger (triggerSendResolution) starts a new batch. Stop aborts the batch.
   */
  private scheduleSendRetry(
    scope: Extract<DraftScope, { kind: "workspace" }>,
    tracking: SendTracking
  ): void {
    const key = draftScopeKey(scope);
    if (tracking.retryTimer || tracking.retryAbort.signal.aborted) return;
    if (tracking.retryAttempt >= SEND_RETRY_LIMIT) return;
    if (this.unresolvedSends(key, tracking).length === 0) return;
    const signal = tracking.retryAbort.signal;
    tracking.retryTimer = setTimeout(() => {
      tracking.retryTimer = null;
      this.retrySends(scope, tracking, signal).catch((error: unknown) =>
        console.warn("Pending send retry failed:", error)
      );
    }, this.sendRetryDelayMs(tracking.retryAttempt++));
  }

  private async retrySends(
    scope: Extract<DraftScope, { kind: "workspace" }>,
    tracking: SendTracking,
    signal: AbortSignal
  ): Promise<void> {
    const key = draftScopeKey(scope);
    const client = this.client;
    if (!client || signal.aborted) return;
    for (const send of this.unresolvedSends(key, tracking)) {
      if (signal.aborted) return;
      if (tracking.lastStatus.get(send.sendId) !== "unknown") continue;
      try {
        const receiverId = await this.getReceiverId(client, scope.workspaceId);
        if (signal.aborted) return;
        if (send.receiverId !== receiverId) {
          // The draft write first: a lookup after the re-send must ask the receiver it went to.
          const moved = await client.drafts.setSendReceiver({
            scope,
            sendId: send.sendId,
            receiverId,
          });
          if (!moved.present) continue;
        }
        // A send undone here (lost draft-write reply) was never sent: while the composer shows
        // its text again, it is not sent now either. Moving it to this receiver is enough: the
        // lookup below then returns it as not accepted. (Once this window is in sync the merge
        // hides it and it is an ordinary pending send, as after a reload.)
        if (this.entries.get(key)?.basisSends.get(send.sendId)?.undone === true) continue;
        const fileParts = await this.loadFileParts(client, scope, send);
        if (signal.aborted) return;
        tracking.issuing.add(send.sendId);
        tracking.resending.set(send.sendId, receiverId);
        try {
          await client.workspace.sendMessage({
            workspaceId: scope.workspaceId,
            message: send.request.message,
            options: {
              ...send.request.options,
              sendId: send.sendId,
              ...(fileParts.length > 0 ? { fileParts } : {}),
            },
          });
        } finally {
          tracking.issuing.delete(send.sendId);
          tracking.resending.delete(send.sendId);
        }
      } catch (error) {
        // The lookup below decides what happened to it.
        console.warn("Re-sending a pending send failed:", error);
      }
    }
    if (!signal.aborted) await this.resolveSends(scope.workspaceId);
  }

  /** A send's file parts, rebuilt from the stored draft's attachments (also after a reload). */
  private async loadFileParts(
    client: APIClient,
    scope: Extract<DraftScope, { kind: "workspace" }>,
    send: PendingSend
  ): Promise<FilePart[]> {
    if (send.attachmentIds.length === 0) return [];
    const entry = this.entries.get(draftScopeKey(scope));
    if (entry && send.attachmentIds.every((id) => entry.attachments.some((a) => a.id === id))) {
      return filePartsOf(send, entry.attachments);
    }
    const draft = await client.drafts.get({ scope });
    return filePartsOf(send, draft.attachments);
  }

  /**
   * Delete a draft (e.g. a discarded creation draft) locally and on the backend. A failed backend
   * delete is retried until it succeeds or the scope is edited again.
   */
  async deleteDraft(scope: DraftStoreScope): Promise<void> {
    const key = draftStoreScopeKey(scope);
    const entry = this.dropEntry(key);
    if (scope.kind === "pending") return;
    const listPut = this.pendingListPuts.get(key)?.sending;
    if (scope.kind === "creation") this.dropListEntry(key);
    // Let a write in flight land first, so it cannot recreate the file after the delete; the same
    // for a list put, which would relist the draft.
    await entry?.inFlight;
    await listPut;
    if (this.entries.has(key)) return;
    this.pendingDeletes.set(key, scope);
    // A list event while waiting above may have shown the row again; hide it now.
    if (scope.kind === "creation") this.recomputeList();
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
      // The backend delisted it; a list event from before the delete must not show it again.
      if (scope.kind === "creation") this.dropListEntry(key);
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
    const otherProject = (entry: DraftListEntry) => entry.projectPath !== projectPath;
    this.serverList = this.serverList.filter(otherProject);
    this.legacyListFallback = this.legacyListFallback.filter(otherProject);
    for (const [key, { entry }] of [...this.pendingListPuts]) {
      if (!otherProject(entry)) this.pendingListPuts.delete(key);
    }
    this.recomputeList();
  }

  private dropEntry(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
    if (entry.payloadRetryTimer) clearTimeout(entry.payloadRetryTimer);
    entry.payloadRetryTimer = null;
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
      payloadRetryTimer: null,
      payloadAttempt: 0,
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
      pendingSends: [],
      localSends: new Map(),
      basisSends: new Map(),
      serverView: null,
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
    const key = draftStoreScopeKey(entry.scope);
    if (!isUnsynced(entry)) {
      // In sync: the fields show the backend's merge, so sends that left the draft are no longer
      // needed as a write's basis.
      for (const [sendId, send] of entry.basisSends) {
        if (!entry.pendingSends.some((pending) => pending.sendId === sendId)) {
          entry.basisSends.delete(sendId);
        } else if (send.undone === true) {
          // The merge hides a send the backend still holds, so this window no longer shows a send
          // it undid: it is an ordinary pending send again, and the stored state decides about it
          // once it settles (ComposerSendMerge.tla: in sync, `undone` is empty). Kept undone, a
          // later write would speak for text this window no longer shows and drop it on return.
          entry.basisSends.set(sendId, { ...send, undone: false });
        }
      }
    }
    const attachments = visibleAttachments(entry);
    const tracking = this.sendTracking.get(key);
    if (tracking) {
      // Answers for ids that left the draft (resolved here or elsewhere, the push before or
      // after the lookup's reply) are not needed any more: bounded by the pending sends.
      for (const sendId of tracking.lastStatus.keys()) {
        if (
          !tracking.settling.has(sendId) &&
          !entry.pendingSends.some((send) => send.sendId === sendId)
        ) {
          tracking.lastStatus.delete(sendId);
        }
      }
    }
    entry.view = {
      text: entry.text,
      attachments,
      attachmentCount: entry.payloadsLoaded
        ? attachments.length
        : Math.max(0, entry.attachmentCount - hiddenAttachmentIds(entry).size),
      payloadsLoaded: entry.payloadsLoaded,
      unresolvedSendCount:
        tracking === undefined
          ? 0
          : entry.pendingSends.filter(({ sendId }) => {
              const status = tracking.lastStatus.get(sendId);
              return status === "unknown" || status === "failed";
            }).length,
    };
    this.notify(key);
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

  /**
   * Apply server state to the fields without an unconfirmed local change (`fields`: only these;
   * a write's reply speaks for the fields it wrote).
   */
  private applyServerState(
    entry: Entry,
    text: string,
    attachments: readonly DraftAttachmentMetadata[],
    pendingSends: readonly PendingSend[],
    fields: { text: boolean; attachments: boolean } = { text: true, attachments: true }
  ): void {
    if (entry.serverView === null || entry.revision >= entry.serverView.revision) {
      entry.serverView = { revision: entry.revision, text, attachments, pendingSends };
    }
    // Not a composer field: always the server's (plus sends begun here, not confirmed yet).
    entry.pendingSends = mergePendingSends(entry, pendingSends);
    observeSends(entry, entry.pendingSends);
    if (
      entry.scope.kind === "workspace" &&
      pendingSends.some(({ sendId }) => entry.basisSends.get(sendId)?.undone === true)
    ) {
      // A send this window undid (its draft write's reply was lost) did land: it was never sent,
      // so its lookup returns it (not accepted).
      this.triggerSendResolution(entry.scope.workspaceId);
    }
    if (fields.text && !isTextDirty(entry)) entry.text = text;
    if (fields.attachments && !isAttachmentsDirty(entry)) {
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
      this.applyServerState(entry, summary.text, summary.attachments, summary.pendingSends ?? []);
    }
    for (const [key, entry] of this.entries) {
      if (entry.scope.kind !== "pending" && !seen.has(key)) {
        entry.revision = Number.NEGATIVE_INFINITY;
        this.applyServerState(entry, "", [], []);
      }
    }
  }

  private applyEvent(event: Extract<DraftEvent, { type: "changed" | "deleted" }>): void {
    const key = draftScopeKey(event.scope);
    if (this.pendingDeletes.has(key)) return;
    const existing = this.entries.get(key);
    // Pushes that trail a newer write reply (or the snapshot) are stale.
    const stale = existing !== undefined && event.revision <= existing.revision;
    if (stale) return;
    if (event.type === "deleted") {
      if (!existing) return;
      existing.revision = event.revision;
      this.applyServerState(existing, "", [], []);
      return;
    }
    const entry = existing ?? this.getOrCreateEntry(event.scope);
    entry.revision = event.revision;
    this.applyServerState(entry, event.text, event.attachments, event.pendingSends ?? []);
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
            this.applyList(event.list);
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
            for (const [key, pending] of this.pendingListPuts) {
              if (pending.confirmedRevision === null) this.startListPut(key, pending);
            }
            // Load and every reconnect (a new subscription): resolve every pending send.
            for (const entry of this.entries.values()) {
              if (entry.scope.kind === "workspace" && entry.pendingSends.length > 0) {
                this.triggerSendResolution(entry.scope.workspaceId, { afterStop: true });
              }
            }
          } else if (event.type === "list") {
            // Pushes that trail a newer snapshot are stale.
            if (event.revision > this.serverListRevision) this.applyList(event);
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
    await this.importLegacyDraftList(client);
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
            // Only a list entry leads a composer to the imported draft. Both keys stay until it
            // is listed, so a failed listing is retried on the next start (the fixed draft id
            // makes the re-import find this copy, and listing is idempotent) (#5226 item 10).
            const entry: DraftListEntry = {
              projectPath: scope.projectPath,
              draftId: scope.draftId,
              subProjectPath: null,
              createdAt: Date.now(),
            };
            try {
              const listed = await client.drafts.putListEntry(entry);
              const key = listEntryKey(entry);
              if (!this.pendingListPuts.has(key)) {
                this.pendingListPuts.set(key, {
                  entry,
                  attempt: 0,
                  confirmedRevision: listed.revision,
                  sending: null,
                });
                this.settleList();
              }
            } catch (error) {
              console.warn(
                "Could not list an imported legacy draft; will retry on next start:",
                error
              );
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
        if (scope.kind === "creation" && reply.result !== "orphaned") {
          // Its row may have fallen out of the over-budget legacy list (#5225), and the list import
          // above ran before this body existed on the backend. A legacy list import relists every
          // owned body without a row; if it fails, the keys stay and the next start retries.
          try {
            await client.drafts.importLegacyList({ entries: [] });
          } catch (error) {
            console.warn(
              "Could not list an imported legacy draft; will retry on next start:",
              error
            );
            continue;
          }
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

  /**
   * One-way import of the legacy localStorage draft list (`workspaceDraftsByProject`, whose size
   * budget dropped newer entries after a restart, #5225). The key is removed only after the
   * backend answered; until then (or for this session, when the import fails) its entries are
   * shown where the backend list lacks them. Downgrading after the import hides these drafts in
   * the older build (their bodies stay on the backend) until the next upgrade.
   */
  private async importLegacyDraftList(client: APIClient): Promise<void> {
    if (readPersistedString(WORKSPACE_DRAFTS_BY_PROJECT_KEY) === undefined) return;
    // An unparseable value imports as empty (and is then removed): the import still runs, so a
    // missing backend list is created and relists the draft bodies.
    const entries = parseLegacyDraftList(readLegacyJson(WORKSPACE_DRAFTS_BY_PROJECT_KEY));
    this.legacyListFallback = entries;
    this.recomputeList();
    try {
      const { revision } = await client.drafts.importLegacyList({ entries });
      updatePersistedState(WORKSPACE_DRAFTS_BY_PROJECT_KEY, undefined);
      this.legacyListFallbackRevision = revision;
      this.settleList();
    } catch (error) {
      console.warn("Failed to import the legacy draft list; will retry on next start:", error);
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
    // An attachment edit waits while payloads load: queued updates (applied onto the loaded
    // list) may still add to it, and writing it before them could delete attachments.
    const attachmentsDue = () => isAttachmentsDirty(entry) && entry.payloadsLoaded;
    while ((isTextDirty(entry) || attachmentsDue()) && this.entries.get(key) === entry) {
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
      const sendAttachments = attachmentsDue();
      const textVersion = entry.textVersion;
      const attachmentsVersion = entry.attachmentsVersion;
      let settle: () => void = () => undefined;
      entry.inFlight = new Promise<void>((resolve) => {
        settle = resolve;
      });
      let reply: DraftWriteOutput;
      try {
        reply = await client.drafts.update({
          scope,
          ...(sendText ? { text: entry.text } : {}),
          // The visible part only: the backend keeps what pending sends retain.
          ...(sendAttachments ? { attachments: visibleAttachments(entry) } : {}),
          // What this window wrote against: the backend merges what happened to them since. A
          // lost reply is retried with the same basis, which merges the same way again.
          ...(entry.basisSends.size > 0 ? { basisSends: [...entry.basisSends.values()] } : {}),
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
      this.applyWriteReply(entry, reply, { text: sendText, attachments: sendAttachments });
    }
  }

  /**
   * A write's reply carries the backend's merge of it. Fields without a newer unsaved edit take
   * the newest server view (this reply, or a push that came after it); the echo push of this
   * write is stale for this window, so the reply is how the merge reaches it.
   */
  private applyWriteReply(
    entry: Entry,
    reply: DraftWriteOutput,
    wrote: { text: boolean; attachments: boolean }
  ): void {
    if (this.entries.get(draftStoreScopeKey(entry.scope)) !== entry) return;
    entry.revision = Math.max(entry.revision, reply.revision);
    if (entry.serverView === null || reply.revision >= entry.serverView.revision) {
      entry.serverView = {
        revision: reply.revision,
        text: reply.text,
        attachments: reply.attachments,
        pendingSends: reply.pendingSends ?? [],
      };
    }
    const view = entry.serverView;
    this.applyServerState(entry, view.text, view.attachments, view.pendingSends, wrote);
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

/** Listed creation drafts by project; re-renders only when the list changes. */
export function useCreationDraftsByProject(): CreationDraftsByProject {
  const store = getDraftStore();
  return useSyncExternalStore(store.subscribeCreationDrafts, () =>
    store.getCreationDraftsByProject()
  );
}

/** True once drafts are hydrated (or hydration failed and the app must not wait for it). */
export function useDraftStoreReady(): boolean {
  const store = getDraftStore();
  return useSyncExternalStore(store.subscribeReady, () => store.isReady());
}
