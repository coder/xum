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
import { MAX_DRAFT_JSON_BYTES } from "@/constants/drafts";
import { CreationDraftService } from "@/node/services/creationDraftService";
import {
  PendingSendSchema,
  type BasisSend,
  type Draft,
  type DraftAttachment,
  type DraftBeginSendInput,
  type DraftEvent,
  type DraftGetOutput,
  type DraftImportLegacyOutput,
  type DraftScope,
  type DraftSetSendReceiverInput,
  type DraftSummary,
  type DraftUpdateInput,
  type DraftWriteOutput,
  type LocalTake,
  type PendingSend,
} from "@/common/orpc/schemas/drafts";
import {
  hasDraftBlock,
  joinDraftText,
  removeDraftBlock,
  removeSentText,
  takeSentText,
} from "@/common/utils/composerDraftText";
import {
  buildLegacyDraftText,
  draftJsonBytes,
  draftScopeKey,
  draftTooLargeMessage,
  retainedAttachmentIds,
  sanitizeDraft,
  splitLegacyDraftText,
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
 * - Creation drafts: one record each, see CreationDraftService (`creation`).
 */
const DRAFT_FILE_NAME = "draft.json";
const DRAFT_FILE_VERSION = 1;

type WorkspaceScope = Extract<DraftScope, { kind: "workspace" }>;

interface IndexEntry {
  summary: DraftSummary;
  filePath: string;
}

/**
 * A draft file's content. `text` and `attachments` are the legacy fields an older build reads as
 * the whole draft: `text` = buildLegacyDraftText(pendingSends, visible text), and `attachments`
 * holds the retained ones (in entry order) before the visible ones. `pendingSends` is the
 * idempotent-send bookkeeping; an older build drops it on its next write, which leaves everything
 * visible (never lost). Only this service builds `text`; clients see and edit the visible part
 * (DraftSummary, DraftUpdateInput).
 */
interface StoredDraft {
  text: string;
  attachments: DraftAttachment[];
  pendingSends: PendingSend[];
}

function emptyStoredDraft(): StoredDraft {
  return { text: "", attachments: [], pendingSends: [] };
}

/** No file: an attachment-only or review-only pending send still keeps its file. */
function isStoredDraftEmpty(draft: StoredDraft): boolean {
  return (
    draft.text.length === 0 && draft.attachments.length === 0 && draft.pendingSends.length === 0
  );
}

/** The composer's part of a validated stored draft (load drops bookkeeping that does not fit). */
function visibleTextOf(draft: StoredDraft): string {
  const visible = splitLegacyDraftText(draft.text, draft.pendingSends);
  assert(visible !== null, "a stored draft's legacy text starts with its retained text");
  return visible;
}

/** The API view: visible text, every attachment (clients hide retained ones), pending sends. */
function viewOf(draft: StoredDraft): Draft {
  return { text: visibleTextOf(draft), attachments: draft.attachments };
}

/**
 * Which send ids durable history holds a row for (accepted). Passive: unlike getSendStatus it
 * records nothing, so asking never refuses a send that is still on its way.
 */
export interface SendAcceptance {
  acceptedSendIds(workspaceId: string, sendIds: readonly string[]): Promise<ReadonlySet<string>>;
}

/**
 * A window's write merged with what happened to the pending sends it wrote against (BasisSend).
 * The backend is the only place that applies send results to a draft; a window writes only its
 * own edits, against the sends it saw:
 * - A send the backend holds (pending) is retained: no write shows its text where the window
 *   may hold a stale copy (it did not see the send yet, undid it after a lost reply, or had it
 *   in unsaved text when it saw it). Text typed after the window saw the send is the user's.
 * - For a basis send settled since, the stored state wins, for its text and its attachments
 *   alike: returned (not accepted) and still in the visible text, it stays (put in front when
 *   the write lacks it: the window had it hidden); accepted, or edited away since by someone
 *   else, it stays out: a stale copy in the window's unsaved text (`inUnsavedText`) is taken
 *   out. Text the window typed after it saw the send is the user's and stays, even when it
 *   matches (e.g. editing the sent message).
 * - A send this window undid (`undone`) and the backend no longer holds is the window's own
 *   content again: its write speaks for it.
 * Every other part of the write is the window's, as before.
 */
function mergeWrite(
  current: StoredDraft,
  write: { text?: string; attachments?: readonly DraftAttachment[] },
  basis: readonly BasisSend[],
  accepted: ReadonlySet<string>
): { visibleText: string; attachments: DraftAttachment[] } {
  const pending = new Set(current.pendingSends.map(({ sendId }) => sendId));
  const settled = basis.filter((send) => send.undone !== true && !pending.has(send.sendId));
  const theirs = visibleTextOf(current);
  let visibleText = theirs;
  if (write.text !== undefined) {
    let text = write.text;
    const seen = new Map(basis.map((send) => [send.sendId, send]));
    for (const send of current.pendingSends) {
      // Only a copy the window may hold unknowingly: it did not see the send, undid it, or had
      // it in unsaved text then. Text typed after it saw the send is the user's.
      const basisSend = seen.get(send.sendId);
      if (
        basisSend === undefined ||
        basisSend.undone === true ||
        basisSend.inUnsavedText === true
      ) {
        text = removeDraftBlock(text, send.text);
      }
    }
    const restored: string[] = [];
    // Each returned send matches its own block (in the stored text, and in the write): repeated
    // texts count one by one.
    let unmatched = text;
    let storedLeft = theirs;
    for (const send of settled) {
      const stays =
        !accepted.has(send.sendId) &&
        send.text.trim().length > 0 &&
        hasDraftBlock(storedLeft, send.text);
      if (stays) storedLeft = removeDraftBlock(storedLeft, send.text);
      if (!stays) {
        if (send.inUnsavedText === true) {
          text = removeDraftBlock(text, send.text);
          unmatched = removeDraftBlock(unmatched, send.text);
        }
      } else if (hasDraftBlock(unmatched, send.text)) {
        unmatched = removeDraftBlock(unmatched, send.text);
      } else {
        restored.push(send.text);
      }
    }
    visibleText = joinDraftText(...restored, text);
  }
  if (write.attachments === undefined) return { visibleText, attachments: current.attachments };
  const storedWins = new Set([
    ...retainedAttachmentIds(current.pendingSends),
    ...basis.filter((send) => send.undone !== true).flatMap((send) => send.attachmentIds),
  ]);
  return {
    visibleText,
    attachments: [
      ...current.attachments.filter(({ id }) => storedWins.has(id)),
      ...write.attachments.filter(({ id }) => !storedWins.has(id)),
    ],
  };
}

/** The draft with one pending send replaced (a receiver move). */
function withPendingSend(current: StoredDraft, updated: PendingSend): StoredDraft {
  return {
    ...current,
    pendingSends: current.pendingSends.map((send) =>
      send.sendId === updated.sendId ? updated : send
    ),
  };
}

/** A write's reply: the stored draft's view (DraftWriteOutputSchema). */
function writeOutput(scope: DraftScope, draft: StoredDraft, revision: number): DraftWriteOutput {
  const { scope: _scope, ...view } = summarizeDraft(
    scope,
    viewOf(draft),
    revision,
    draft.pendingSends
  );
  return view;
}

/** Build the stored form: retained attachments first (entry order), then the visible ones. */
function storedDraftFrom(
  visibleText: string,
  attachments: readonly DraftAttachment[],
  pendingSends: PendingSend[]
): StoredDraft {
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const retainedIds = [...new Set(pendingSends.flatMap((send) => send.attachmentIds))];
  const retained = retainedIds.map((id) => {
    const attachment = byId.get(id);
    assert(attachment !== undefined, `pending send attachment ${id} is in the draft`);
    return attachment;
  });
  const retainedSet = new Set(retainedIds);
  const seen = new Set<string>();
  const visible = attachments.filter((attachment) => {
    if (retainedSet.has(attachment.id) || seen.has(attachment.id)) return false;
    seen.add(attachment.id);
    return true;
  });
  return {
    text: buildLegacyDraftText(pendingSends, visibleText),
    attachments: [...retained, ...visible],
    pendingSends,
  };
}

/** Key-order independent JSON, to compare a repeated beginSend with the stored entry. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** The same send: everything but the receiver (a retry rewrites that). */
function isSamePendingSend(a: PendingSend, b: PendingSend): boolean {
  const { receiverId: _a, ...restA } = a;
  const { receiverId: _b, ...restB } = b;
  return canonicalJson(restA) === canonicalJson(restB);
}

/**
 * The pending sends of a parsed draft file, or none when they do not fit its legacy fields: an
 * older build (or another writer) rewrote the text or dropped an attachment, so the bookkeeping
 * no longer describes the file. Dropping it leaves everything visible: no loss.
 */
function validPendingSends(raw: unknown, draft: Draft, filePath: string): PendingSend[] {
  if (raw === undefined) return [];
  const drop = (reason: string) => {
    log.warn(`Dropping pending sends of draft file ${filePath}: ${reason}`);
    return [];
  };
  if (!Array.isArray(raw)) return drop("malformed");
  // A malformed entry is dropped on its own (its text and attachments stay visible); the rest
  // stays only if it still fits the legacy fields (checked below).
  const sends: PendingSend[] = [];
  for (const entry of raw) {
    const parsed = PendingSendSchema.safeParse(entry);
    if (parsed.success) sends.push(parsed.data);
    else log.warn(`Dropping a malformed pending send of draft file ${filePath}`);
  }
  if (new Set(sends.map((send) => send.sendId)).size !== sends.length) return drop("repeated id");
  const attachmentIds = sends.flatMap((send) => send.attachmentIds);
  const present = new Set(draft.attachments.map((attachment) => attachment.id));
  if (
    new Set(attachmentIds).size !== attachmentIds.length ||
    attachmentIds.some((id) => !present.has(id))
  ) {
    return drop("attachments changed");
  }
  if (splitLegacyDraftText(draft.text, sends) === null) return drop("text changed");
  return sends;
}

/** Thrown for a scope whose id would resolve outside its storage dir. */
class InvalidDraftScopeError extends Error {}

export class DraftService extends EventEmitter {
  static readonly CHANGE_EVENT = "change";

  private readonly config: Config;
  readonly creation: CreationDraftService;
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
    this.creation = new CreationDraftService(config);
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
    const draft = (await this.load(scope)) ?? emptyStoredDraft();
    return {
      ...viewOf(draft),
      ...(draft.pendingSends.length > 0 ? { pendingSends: draft.pendingSends } : {}),
      revision,
    };
  }

  /**
   * Partial update: omitted fields keep their stored value. A draft that ends up empty is
   * deleted. A write for a scope without an owner (unregistered workspace, unconfigured project)
   * is skipped and returns the current revision.
   */
  async update(input: DraftUpdateInput, acceptance?: SendAcceptance): Promise<DraftWriteOutput> {
    const { scope } = input;
    const filePath = this.filePathFor(scope);
    const basis = input.basisSends ?? [];
    const accepted = await this.acceptedBasisSends(scope, basis, acceptance);
    return this.withWriteLock(scope, async () => {
      const current = (await this.load(scope)) ?? emptyStoredDraft();
      // Clients write the visible part; what pending sends retain stays (only their resolution
      // removes it), and what happened to the sends the client wrote against is merged here.
      const merged = mergeWrite(current, input, basis, accepted);
      const next = storedDraftFrom(merged.visibleText, merged.attachments, current.pendingSends);
      const bytes = draftJsonBytes(next);
      if (bytes > MAX_DRAFT_JSON_BYTES) {
        throw new Error(draftTooLargeMessage(bytes));
      }
      if (!(await this.hasOwner(scope))) {
        return writeOutput(scope, current, this.getRevision(draftScopeKey(scope)));
      }
      return writeOutput(scope, next, await this.persist(scope, filePath, next));
    });
  }

  /**
   * The basis sends history holds a row for. Asked only when one has left the stored draft (it
   * was settled after the writer's view): the lookup reads history. A basis send settled after
   * this read counts as not accepted, which is safe: its text is merged back only while the
   * visible text holds it, and an accepted send's text never comes back there. A failed lookup
   * counts none as accepted (a visible duplicate beats a loss).
   */
  private async acceptedBasisSends(
    scope: DraftScope,
    basis: readonly BasisSend[],
    acceptance: SendAcceptance | undefined
  ): Promise<ReadonlySet<string>> {
    if (acceptance === undefined || basis.length === 0) {
      return new Set();
    }
    try {
      const current = await this.load(scope);
      const pending = new Set(current?.pendingSends.map(({ sendId }) => sendId) ?? []);
      const settled = basis
        .filter(({ sendId }) => !pending.has(sendId))
        .map(({ sendId }) => sendId);
      if (settled.length === 0) return new Set();
      return await acceptance.acceptedSendIds(scope.workspaceId, settled);
    } catch (error) {
      log.warn("Draft write: accepted-send lookup failed; merging as not accepted", { error });
      return new Set();
    }
  }

  /** Delete a draft. No owner check: removing data is always allowed. */
  async delete(scope: DraftScope): Promise<{ revision: number }> {
    const filePath = this.filePathFor(scope);
    return this.withWriteLock(scope, async () => ({
      revision: await this.persist(scope, filePath, emptyStoredDraft()),
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
      if (current !== null && !isStoredDraftEmpty(current)) {
        return { result: "present", revision: this.getRevision(key) };
      }
      if (!(await this.hasOwner(scope))) {
        return { result: "orphaned", revision: this.getRevision(key) };
      }
      const stored: StoredDraft = { ...legacy, pendingSends: [] };
      if (isStoredDraftEmpty(stored)) {
        return { result: "applied", revision: this.getRevision(key) };
      }
      return { result: "applied", revision: await this.persist(scope, filePath, stored) };
    });
  }

  /**
   * Idempotent sends: the one draft write before a composer send. The sent text leaves the visible
   * text (visibleAfterTake, computed here so another window's newer visible edits stay) and is
   * retained in the legacy text with the attachments; the entry keeps the exact request for
   * retries. Idempotent by send id: a repeat with the same send changes nothing but its receiver; a
   * different payload under a known id is refused.
   */
  async beginSend(
    input: DraftBeginSendInput,
    acceptance?: SendAcceptance
  ): Promise<DraftWriteOutput> {
    const { scope, pendingSend } = input;
    const filePath = this.filePathFor(scope);
    const basis = input.basisSends ?? [];
    const accepted = await this.acceptedBasisSends(scope, basis, acceptance);
    return this.withWriteLock(scope, async () => {
      const key = draftScopeKey(scope);
      const current = (await this.load(scope)) ?? emptyStoredDraft();
      const existing = current.pendingSends.find(({ sendId }) => sendId === pendingSend.sendId);
      if (existing) {
        if (!isSamePendingSend(existing, pendingSend)) {
          throw new Error("This send id is already pending for a different message");
        }
        if (existing.receiverId === pendingSend.receiverId) {
          return writeOutput(scope, current, this.getRevision(key));
        }
        const moved = withPendingSend(current, pendingSend);
        return writeOutput(scope, moved, await this.persist(scope, filePath, moved));
      }
      // Each attachment belongs to one send: a second send cannot retain it again.
      const retained = retainedAttachmentIds(current.pendingSends);
      if (pendingSend.attachmentIds.some((id) => retained.has(id))) {
        throw new Error("A pending send already holds one of these attachments");
      }
      // The sender's payloads win for the ids it sends: a client may replace an attachment under
      // the same id (a pending file that became staged) before saving it.
      const taken = new Set(pendingSend.attachmentIds);
      const attachments = current.attachments.map((attachment) =>
        taken.has(attachment.id)
          ? (input.attachments.find(({ id }) => id === attachment.id) ?? attachment)
          : attachment
      );
      for (const id of pendingSend.attachmentIds) {
        if (attachments.some((attachment) => attachment.id === id)) continue;
        const payload = input.attachments.find((attachment) => attachment.id === id);
        if (payload === undefined) throw new Error(`Pending send attachment ${id} has no payload`);
        attachments.push(payload);
      }
      const merged = mergeWrite(current, { text: input.text }, basis, accepted);
      const next = storedDraftFrom(
        visibleAfterTake(merged.visibleText, pendingSend.text, input),
        attachments,
        [...current.pendingSends, pendingSend]
      );
      const bytes = draftJsonBytes(next);
      if (bytes > MAX_DRAFT_JSON_BYTES) throw new Error(draftTooLargeMessage(bytes));
      if (!(await this.hasOwner(scope))) {
        throw new Error(`Draft write refused: workspace ${scope.workspaceId} is not registered`);
      }
      return writeOutput(scope, next, await this.persist(scope, filePath, next));
    });
  }

  /**
   * A retry's receiver rewrite (the draft write before the re-send). Never recreates an entry that
   * was resolved meanwhile: `present` is false and the retry stops.
   */
  async setSendReceiver(
    input: DraftSetSendReceiverInput
  ): Promise<{ revision: number; present: boolean }> {
    const { scope } = input;
    const filePath = this.filePathFor(scope);
    return this.withWriteLock(scope, async () => {
      const key = draftScopeKey(scope);
      const current = await this.load(scope);
      const existing = current?.pendingSends.find(({ sendId }) => sendId === input.sendId);
      if (current == null || existing === undefined) {
        return { revision: this.getRevision(key), present: false };
      }
      if (existing.receiverId === input.receiverId) {
        return { revision: this.getRevision(key), present: true };
      }
      const moved = withPendingSend(current, { ...existing, receiverId: input.receiverId });
      return { revision: await this.persist(scope, filePath, moved), present: true };
    });
  }

  /** The pending sends of a workspace draft (no lock: resolution rechecks under it). */
  async getPendingSends(scope: Extract<DraftScope, { kind: "workspace" }>): Promise<PendingSend[]> {
    return (await this.load(scope))?.pendingSends ?? [];
  }

  /**
   * Apply the receiver's answers, under the draft lock. An answer applies only while its entry
   * still exists and still names the receiver that was asked: another window may have resolved it,
   * or a retry may have sent it to another receiver since. Accepted: the entry, its retained text
   * and its attachments go. Not accepted: the entry goes and its text and attachments become
   * visible again (retained texts first, in entry order). Pending or unknown: kept. Never infers
   * acceptance from anything but the answer.
   */
  async applySendStatuses(
    scope: Extract<DraftScope, { kind: "workspace" }>,
    answers: ReadonlyArray<{ sendId: string; receiverId: string; status: string }>
  ): Promise<void> {
    const filePath = this.filePathFor(scope);
    await this.withWriteLock(scope, async () => {
      const current = await this.load(scope);
      if (current === null) return;
      const resolved: Array<{ sendId: string; status: "accepted" | "not-accepted" }> = [];
      for (const entry of current.pendingSends) {
        const answer = answers.find(
          ({ sendId, receiverId }) => sendId === entry.sendId && receiverId === entry.receiverId
        );
        if (answer?.status === "accepted" || answer?.status === "not-accepted") {
          resolved.push({ sendId: entry.sendId, status: answer.status });
        }
      }
      if (resolved.length === 0) return;
      const statusOf = (send: PendingSend) =>
        resolved.find(({ sendId }) => sendId === send.sendId)?.status;
      const acceptedIds = new Set(
        current.pendingSends
          .filter((send) => statusOf(send) === "accepted")
          .flatMap((send) => send.attachmentIds)
      );
      const restoredTexts = current.pendingSends
        .filter((send) => statusOf(send) === "not-accepted")
        .map((send) => send.text);
      const next = storedDraftFrom(
        joinDraftText(...restoredTexts, visibleTextOf(current)),
        current.attachments.filter(({ id }) => !acceptedIds.has(id)),
        current.pendingSends.filter((send) => statusOf(send) === undefined)
      );
      await this.persist(scope, filePath, next);
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
    // Only the visible part: the pending sends went to the source workspace (and its history,
    // which the fork may share), so the fork must not resolve or show them again.
    const retained = retainedAttachmentIds(draft.pendingSends);
    const forked = storedDraftFrom(
      visibleTextOf(draft),
      stripStagedDraftAttachments(draft.attachments).filter(({ id }) => !retained.has(id)),
      []
    );
    if (isStoredDraftEmpty(forked)) return;
    const filePath = this.filePathFor(target);
    await this.withWriteLock(target, () => this.persist(target, filePath, forked));
  }

  /** Delete the creation drafts of a removed project; returns their ids. */
  deleteProjectDrafts(projectPath: string): Promise<string[]> {
    assert(projectPath.length > 0, "DraftService.deleteProjectDrafts requires a projectPath");
    return this.creation.deleteProjectDrafts(projectPath);
  }

  /** The event a new subscription starts with. */
  async getSnapshotEvent(): Promise<Extract<DraftEvent, { type: "snapshot" }>> {
    return { type: "snapshot", drafts: await this.list() };
  }

  private getRevision(key: string): number {
    return this.revisions.get(key) ?? this.initialRevision;
  }

  private filePathFor(scope: DraftScope): string {
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

  /**
   * Missing file: null. Unparseable or malformed: self-heal (empty or sanitized, with a warning).
   * Any other read failure (EACCES, EIO, EISDIR...) throws: treating it as empty would let the
   * next write replace data that exists but could not be read, while a rejection makes the
   * client keep its change and retry.
   */
  private async load(scope: DraftScope): Promise<StoredDraft | null> {
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
      return emptyStoredDraft();
    }
    const { draft, droppedEntries } = sanitizeDraft(raw);
    if (droppedEntries > 0) {
      log.warn(`Dropped malformed entries from draft file ${filePath}`, { droppedEntries });
    }
    const pendingSends = validPendingSends(
      (raw as { pendingSends?: unknown } | null)?.pendingSends,
      draft,
      filePath
    );
    return { ...draft, pendingSends };
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
    if (await isWorkspaceRemovalTombstoned(this.config.rootDir, scope.workspaceId)) {
      throw new Error(`Draft write refused: workspace ${scope.workspaceId} is being removed`);
    }
    return this.config.findWorkspace(scope.workspaceId, { throwOnError: true }) != null;
  }

  /**
   * Write (or delete, for an empty draft) under withWriteLock, update the index and notify
   * subscribers. Returns the new revision, or the current one when nothing changed.
   */
  private async persist(scope: DraftScope, filePath: string, draft: StoredDraft): Promise<number> {
    const key = draftScopeKey(scope);
    // A running scan skips keys written meanwhile (the write's entry is newer), so a key is marked
    // only once its write landed: a failed write must not hide the draft still on disk.
    if (isStoredDraftEmpty(draft)) {
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
    const file = { version: DRAFT_FILE_VERSION };
    const { pendingSends, ...legacy } = draft;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    let revision: number | undefined;
    await writeFileAtomic(
      filePath,
      JSON.stringify({ ...file, ...legacy, ...(pendingSends.length > 0 ? { pendingSends } : {}) }),
      {
        // Publish when the file becomes visible, not after the directory fsync: get() reads the
        // file, and a snapshot (list) reads the index, so both switch to the new draft at once
        // (#6728). The reply below still waits for the fsync.
        afterRename: () => {
          this.scanTouched?.add(key);
          revision = this.bumpRevision(key);
          const summary = summarizeDraft(scope, viewOf(draft), revision, pendingSends);
          this.index.set(key, { summary, filePath });
          const event: DraftEvent = { type: "changed", ...summary };
          this.emit(DraftService.CHANGE_EVENT, event);
        },
      }
    );
    // Unset only if the publish step threw before the revision (logged by writeFileAtomic): the
    // write then rejects, and the client's retry publishes again.
    assert(revision !== undefined, "the draft file was replaced but not published (see the log)");
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
      const add = (scope: DraftScope, filePath: string, draft: StoredDraft | null) => {
        if (draft === null || isStoredDraftEmpty(draft)) return;
        const key = draftScopeKey(scope);
        found.set(key, {
          summary: summarizeDraft(scope, viewOf(draft), this.getRevision(key), draft.pendingSends),
          filePath,
        });
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

      for (const [key, entry] of found) {
        if (!touched.has(key)) this.index.set(key, entry);
      }
    } finally {
      this.scanTouched = null;
    }
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

/**
 * The visible text after a send took `sent` out of it. The sender's own take (#6405, #6585)
 * applies only to the exact text it took from: any other text (another window's newer write)
 * keeps the whitespace rule.
 */
function visibleAfterTake(
  visible: string,
  sent: string,
  input: { text?: string; localTake?: LocalTake }
): string {
  const take = input.localTake;
  if (take === undefined || (take.from ?? input.text) !== visible) {
    return removeSentText(visible, sent);
  }
  return takeSentText(visible, sent, take.kind);
}
