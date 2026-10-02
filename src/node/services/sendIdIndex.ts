import assert from "@/common/utils/assert";
import { createHash } from "node:crypto";
import * as fsPromises from "fs/promises";
import type { FilePart } from "@/common/orpc/types";
import { isErrnoWithCode } from "@/node/utils/fs";

/**
 * Idempotent sends (formal/composer-drafts/ComposerSends.tla, FixIds): every user send carries an
 * id, a retry reuses it with the same payload, and the user row that accepts the send carries the
 * id (metadata.sendIds). A row on disk is the only acceptance evidence, so the history write path
 * checks ids under its cross-process write lock and never appends a second row for a known id.
 */
export interface SendIdentity {
  id: string;
  /** Digest of the submitted payload, fixed when the id was first assigned (see computeSendDigest). */
  digest: string;
}

/**
 * One add of a send as the session holds it: a direct send has one, a queued batch or a held
 * batch has one per message the user sent. `text` is the trimmed message ("" for an
 * attachment-only add). Adds without an identity come from internal callers and always stay.
 */
export interface SendAdd {
  identity?: SendIdentity;
  text: string;
  fileParts: FilePart[];
}

/** The ids of adds that carry one, in order. */
export function sendIdentitiesOf(adds: readonly SendAdd[] | undefined): SendIdentity[] {
  return (adds ?? []).flatMap((add) => (add.identity != null ? [add.identity] : []));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/**
 * Digest of what the user submitted: the text, the attachments, the edit target and the
 * client metadata (reviews, slash commands). Excluded: model and agent settings, timestamps and
 * ACP correlation, which a retry of the same input may legitimately change.
 */
export function computeSendDigest(payload: {
  message: string;
  fileParts?: readonly FilePart[];
  editMessageId?: string;
  muxMetadata?: unknown;
}): string {
  const canonical = canonicalJson({
    message: payload.message,
    fileParts: (payload.fileParts ?? []).map((part) => ({
      url: part.url,
      mediaType: part.mediaType,
      filename: part.filename,
    })),
    editMessageId: payload.editMessageId,
    muxMetadata: payload.muxMetadata,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** What history says about one id. */
export type SendIdEvidence =
  /** A parsed row lists the id; `digest` is absent when the row carries none for it. */
  | { kind: "row"; digest: string | undefined }
  /** Only an unparseable line contains the id: it blocks a second append but proves no payload. */
  | { kind: "unreadable" };

// A real metadata key is serialized with bare quotes; the same word inside message text is
// JSON-escaped (\"sendIds\"), so this marker selects the few lines worth parsing.
const SEND_IDS_MARKER = Buffer.from('"sendIds"');
const TAIL_BYTES = 64;
const READ_CHUNK_BYTES = 1024 * 1024;

interface LineEvidence {
  ids: Map<string, SendIdEvidence>;
  /** Unparseable lines that mention sendIds, matched by raw id string. */
  unreadable: string[];
}

function emptyEvidence(): LineEvidence {
  return { ids: new Map(), unreadable: [] };
}

function recordRow(target: LineEvidence, id: string, digest: string | undefined): void {
  const existing = target.ids.get(id);
  if (existing == null) {
    target.ids.set(id, { kind: "row", digest });
    return;
  }
  // Two rows listing one id should not exist; if they do, neither proves the payload.
  if (existing.kind !== "row" || existing.digest !== digest) {
    target.ids.set(id, { kind: "row", digest: undefined });
  }
}

function indexLine(line: Buffer, target: LineEvidence): void {
  if (line.indexOf(SEND_IDS_MARKER) === -1) return;
  const text = line.toString("utf8");
  let metadata: unknown;
  try {
    metadata = (JSON.parse(text) as { metadata?: unknown } | null)?.metadata;
  } catch {
    target.unreadable.push(text);
    return;
  }
  const sendIds =
    metadata != null && typeof metadata === "object"
      ? (metadata as { sendIds?: unknown }).sendIds
      : undefined;
  // The marker can also come from client metadata (muxMetadata is a black box): only the row's
  // own metadata.sendIds counts, and a malformed one is kept as raw text.
  if (sendIds === undefined) return;
  if (!Array.isArray(sendIds) || !sendIds.every((id) => typeof id === "string")) {
    target.unreadable.push(text);
    return;
  }
  const digests = (metadata as { sendDigests?: unknown }).sendDigests;
  for (const id of sendIds) {
    const digest =
      digests != null && typeof digests === "object"
        ? (digests as Record<string, unknown>)[id]
        : undefined;
    recordRow(target, id, typeof digest === "string" ? digest : undefined);
  }
}

function evidenceIn(target: LineEvidence, id: string): SendIdEvidence | undefined {
  const row = target.ids.get(id);
  if (row != null) return row;
  const quoted = `"${id}"`;
  return target.unreadable.some((line) => line.includes(quoted))
    ? { kind: "unreadable" }
    : undefined;
}

/**
 * Index of one JSONL file, extended by reading only the bytes appended since the last refresh.
 * A rewrite (new inode), a shrink, or changed bytes before the indexed offset rebuild it from
 * scratch: rotation and truncation rewrite history files atomically.
 */
class SendIdFileIndex {
  private ino: number | undefined;
  private offset = 0;
  private tail: Buffer = Buffer.alloc(0);
  private complete: LineEvidence = emptyEvidence();
  /** Trailing bytes without a newline (a torn write): re-read on every refresh, never indexed. */
  private fragment: LineEvidence = emptyEvidence();
  /** Times this index was rebuilt from offset 0 (tests observe rebuilds through it). */
  rebuilds = 0;

  private reset(ino: number | undefined): void {
    this.ino = ino;
    this.offset = 0;
    this.tail = Buffer.alloc(0);
    this.complete = emptyEvidence();
    this.fragment = emptyEvidence();
  }

  async refresh(filePath: string): Promise<void> {
    let handle: fsPromises.FileHandle;
    try {
      handle = await fsPromises.open(filePath, "r");
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) {
        this.reset(undefined);
        return;
      }
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (
        this.ino !== stat.ino ||
        stat.size < this.offset ||
        !(await this.tailStillMatches(handle))
      ) {
        if (this.ino !== undefined || this.offset > 0) this.rebuilds++;
        this.reset(stat.ino);
      }
      await this.readAppended(handle, stat.size);
    } finally {
      await handle.close();
    }
  }

  private async tailStillMatches(handle: fsPromises.FileHandle): Promise<boolean> {
    if (this.tail.length === 0) return true;
    const buffer = Buffer.alloc(this.tail.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset - buffer.length);
    return bytesRead === buffer.length && buffer.equals(this.tail);
  }

  private async readAppended(handle: fsPromises.FileHandle, size: number): Promise<void> {
    this.fragment = emptyEvidence();
    let position = this.offset;
    // Chunks of the line being assembled: a line longer than one chunk is joined once.
    let pending: Buffer[] = [];
    const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, Math.max(1, size - position)));
    while (position < size) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      const data = chunk.subarray(0, bytesRead);
      let start = 0;
      for (let newline = data.indexOf(10); newline !== -1; newline = data.indexOf(10, start)) {
        const piece = data.subarray(start, newline);
        const line = pending.length > 0 ? Buffer.concat([...pending, piece]) : piece;
        pending = [];
        indexLine(line, this.complete);
        start = newline + 1;
        this.offset = position + start;
      }
      if (start < data.length) pending.push(Buffer.from(data.subarray(start)));
      position += bytesRead;
    }
    if (pending.length > 0) indexLine(Buffer.concat(pending), this.fragment);
    if (this.offset > 0) {
      const tail = Buffer.alloc(Math.min(TAIL_BYTES, this.offset));
      const { bytesRead } = await handle.read(tail, 0, tail.length, this.offset - tail.length);
      assert(bytesRead === tail.length, "send id index tail must be readable");
      this.tail = tail;
    }
  }

  evidence(id: string): SendIdEvidence | undefined {
    return evidenceIn(this.complete, id) ?? evidenceIn(this.fragment, id);
  }
}

/** Per-workspace send id index over the archive and the live history file. */
export class WorkspaceSendIdIndex {
  private readonly archive = new SendIdFileIndex();
  private readonly chat = new SendIdFileIndex();
  /** Refreshes run one at a time: each mutates the per-file offsets. */
  private refreshing: Promise<void> = Promise.resolve();

  /**
   * Evidence is exact only when the caller holds the history write lock (no writer moves bytes
   * between the two reads). An unlocked refresh is only a warm-up: it never indexes past a
   * complete line, and the next locked refresh re-checks the tail and the inode.
   */
  refresh(paths: { chat: string; archive: string }): Promise<void> {
    const run = this.refreshing.then(async () => {
      await this.archive.refresh(paths.archive);
      await this.chat.refresh(paths.chat);
    });
    // A failed refresh must not wedge later ones; its caller still sees the error.
    this.refreshing = run.catch(() => undefined);
    return run;
  }

  evidence(id: string): SendIdEvidence | undefined {
    const live = this.chat.evidence(id);
    const archived = this.archive.evidence(id);
    if (live == null) return archived;
    if (archived == null) return live;
    // Rows in both files (an interrupted rotation replays rows into the archive): a matching
    // digest stays proof, anything else proves no payload.
    return live.kind === "row" && archived.kind === "row" && live.digest === archived.digest
      ? live
      : { kind: "row", digest: undefined };
  }

  get rebuildCount(): number {
    return this.archive.rebuilds + this.chat.rebuilds;
  }
}

/** The in-lock decision for one publication that carries send ids. */
export type SendIdDecision =
  /** No id has a row: append, stamping every id. */
  | { kind: "append" }
  /** Some ids have rows with the same payload (a batch): append only the other adds. */
  | { kind: "append-filtered"; keep: SendIdentity[]; skipped: string[] }
  /** Every id has a row with the same payload: nothing to append. */
  | { kind: "already-accepted" }
  /** A known id with a different payload: refused, no row. */
  | { kind: "conflict"; ids: string[] }
  /** A known id whose row proves no payload (unreadable, or no digest): refused, no row. */
  | { kind: "unverified"; ids: string[] }
  /** Some ids have rows but the publication cannot be rebuilt without them: refused, no row. */
  | { kind: "partial-refused"; known: string[] };

export function decideSendIdPublication(
  identities: readonly SendIdentity[],
  evidenceOf: (id: string) => SendIdEvidence | undefined,
  canRebuild: boolean
): SendIdDecision {
  assert(identities.length > 0, "a send id decision needs at least one id");
  assert(
    new Set(identities.map((identity) => identity.id)).size === identities.length,
    "a publication never carries one send id twice"
  );
  const same: string[] = [];
  const different: string[] = [];
  const unverified: string[] = [];
  const keep: SendIdentity[] = [];
  for (const identity of identities) {
    const evidence = evidenceOf(identity.id);
    if (evidence == null) keep.push(identity);
    else if (evidence.kind === "unreadable" || evidence.digest === undefined)
      unverified.push(identity.id);
    else if (evidence.digest === identity.digest) same.push(identity.id);
    else different.push(identity.id);
  }
  if (same.length + different.length + unverified.length === 0) return { kind: "append" };
  // Only a row with the same payload proves an add was accepted. A conflicting or unprovable id
  // refuses the whole publication: filtering it out would drop that add's content silently
  // (the model's Dispatch skips any known id because there the content stays with the client).
  if (different.length > 0) return { kind: "conflict", ids: different };
  if (unverified.length > 0) return { kind: "unverified", ids: unverified };
  if (keep.length === 0) return { kind: "already-accepted" };
  return canRebuild
    ? { kind: "append-filtered", keep, skipped: same }
    : { kind: "partial-refused", known: same };
}

export const SEND_ID_CONFLICT_MESSAGE =
  "This send reuses an id that history already holds for a different message; nothing was sent.";
export const SEND_ID_UNVERIFIED_MESSAGE =
  "This send's id is already on a history row that cannot be read back; nothing was sent again.";
export const SEND_ID_PARTIALLY_ACCEPTED_MESSAGE =
  "Part of this queued batch was already accepted elsewhere; nothing was sent. Send it again.";
export const SEND_ID_REFUSED_MESSAGE =
  "This send was already reported as not accepted; send the message again as a new send.";

/** The refusal text for a decision that refuses the publication; undefined otherwise. */
export function sendIdRefusalMessage(decision: SendIdDecision | undefined): string | undefined {
  switch (decision?.kind) {
    case "conflict":
      return SEND_ID_CONFLICT_MESSAGE;
    case "unverified":
      return SEND_ID_UNVERIFIED_MESSAGE;
    case "partial-refused":
      return SEND_ID_PARTIALLY_ACCEPTED_MESSAGE;
    default:
      return undefined;
  }
}
export const SEND_ID_PARTLY_PENDING_MESSAGE =
  "Part of this send is still pending here; wait for it to settle, then send it again.";
