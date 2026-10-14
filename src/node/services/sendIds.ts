import assert from "@/common/utils/assert";
import { createHash } from "node:crypto";
import * as fsPromises from "fs/promises";
import type { FilePart } from "@/common/orpc/types";
import {
  ACP_DELEGATED_TOOLS_METADATA_KEY,
  ACP_PROMPT_ID_METADATA_KEY,
} from "@/constants/acpMetadata";
import { MINTED_SEND_ID_PREFIX } from "@/common/orpc/schemas/stream";
import { isErrnoWithCode } from "@/node/utils/fs";
import { isReadableHistoryMessage } from "./historyScanner";

/**
 * Idempotent sends: every manual send carries an id (the client's, or one WorkspaceService mints),
 * and a retry of the same input reuses it. The user row that accepts a send carries its id
 * (metadata.sendIds), so a row on disk is the only acceptance evidence. HistoryService checks the
 * ids under its cross-process write lock right before the append and never appends a second row for
 * an id a row holds.
 */
export interface SendIdentity {
  id: string;
  /** Digest of the submitted payload, fixed when the id was assigned (see computeSendDigest). */
  digest: string;
  /**
   * Minted by this backend for this send (MINTED_SEND_ID_PREFIX, which clients may not use) and
   * not yet offered to any publication, so no row can hold it: its first publication skips the
   * history read. Cleared whenever the send can be offered again (held input).
   */
  unpublished?: true;
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
 * Client metadata without the fields a retry of the same input may change: the ACP correlation
 * mirror (a retry may re-correlate) and the requested-model mirror (the user may pick another
 * model). Everything else, e.g. a /compact request, describes the input and stays.
 */
function withoutRetryMetadata(muxMetadata: unknown): unknown {
  if (muxMetadata == null || typeof muxMetadata !== "object" || Array.isArray(muxMetadata)) {
    return muxMetadata;
  }
  const {
    [ACP_PROMPT_ID_METADATA_KEY]: _acpPromptId,
    [ACP_DELEGATED_TOOLS_METADATA_KEY]: _acpDelegatedTools,
    requestedModel: _requestedModel,
    ...rest
  } = muxMetadata as Record<string, unknown>;
  return rest;
}

/**
 * Digest of what the user submitted: the text, the attachments, the edit target and the client
 * metadata (reviews, slash commands). Excluded: model and agent settings, timestamps, and the
 * metadata a retry may change (withoutRetryMetadata).
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
    muxMetadata: withoutRetryMetadata(payload.muxMetadata),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** What one history line says about one id. */
export type SendIdEvidence =
  /** A readable row lists the id in metadata.sendIds; `digest` is undefined when it has none. */
  | { kind: "row"; digest: string | undefined }
  /** A line the history readers drop contains the id: it proves no payload, but it may be one. */
  | { kind: "unreadable" };

export type SendIdDecision =
  /** No line mentions any id: append the row with every id. */
  | { kind: "append" }
  /** Every id is on a readable row with the same payload: the send adds nothing. */
  | { kind: "already-accepted" }
  /** Some ids are known, others not, the payload differs, or a line proves nothing: no row. */
  | { kind: "refused"; reason: "conflict" | "unverified" | "partly-accepted" | "repeated" };

export const SEND_ID_CONFLICT_MESSAGE =
  "This send reuses an id that history already holds for a different message; nothing was sent.";
export const SEND_ID_UNVERIFIED_MESSAGE =
  "This send's id is already on a history row that cannot be read back; nothing was sent again.";
export const SEND_ID_PARTLY_ACCEPTED_MESSAGE =
  "Part of this batch was already accepted; nothing was sent, so nothing is duplicated. The rest stays held.";
export const SEND_ID_REFUSED_MESSAGE =
  "This send was already reported as not accepted; send the message again as a new send.";
export const SEND_ID_REPEATED_MESSAGE = "This send carries one send id twice; nothing was sent.";

/** The refusal text for a refused decision; undefined otherwise. */
export function sendIdRefusalMessage(decision: SendIdDecision | undefined): string | undefined {
  if (decision?.kind !== "refused") return undefined;
  switch (decision.reason) {
    case "conflict":
      return SEND_ID_CONFLICT_MESSAGE;
    case "unverified":
      return SEND_ID_UNVERIFIED_MESSAGE;
    case "partly-accepted":
      return SEND_ID_PARTLY_ACCEPTED_MESSAGE;
    case "repeated":
      return SEND_ID_REPEATED_MESSAGE;
  }
}

/**
 * Decide a publication from every line's evidence. Only a readable row with the same payload
 * proves an id accepted. Anything else that mentions an id refuses the whole publication: no
 * batch is rebuilt without some adds, so the caller keeps every input and id (held), and a
 * second append can never happen.
 */
export function decideSendIds(
  identities: readonly SendIdentity[],
  evidence: ReadonlyMap<string, readonly SendIdEvidence[]>
): SendIdDecision {
  assert(identities.length > 0, "a send id decision needs at least one id");
  if (new Set(identities.map((identity) => identity.id)).size !== identities.length) {
    return { kind: "refused", reason: "repeated" };
  }
  let accepted = 0;
  let unverified = false;
  for (const identity of identities) {
    const found = evidence.get(identity.id) ?? [];
    if (found.length === 0) continue;
    for (const item of found) {
      if (item.kind === "unreadable" || item.digest === undefined) unverified = true;
      else if (item.digest !== identity.digest) return { kind: "refused", reason: "conflict" };
    }
    if (!found.some((item) => item.kind === "unreadable" || item.digest === undefined)) accepted++;
  }
  if (unverified) return { kind: "refused", reason: "unverified" };
  if (accepted === 0) return { kind: "append" };
  if (accepted === identities.length) return { kind: "already-accepted" };
  return { kind: "refused", reason: "partly-accepted" };
}

const READ_CHUNK_BYTES = 1024 * 1024;
/**
 * The longest line parsed. The history readers parse a row of any size (attachments travel as
 * data URLs), so this only bounds memory against a corrupt, never-ending line; a longer line is
 * searched, not parsed, and counts as unreadable when it names an id.
 */
export const MAX_SEND_ID_LINE_BYTES = 64 * 1024 * 1024;

/** The evidence one history line gives for the ids whose quoted form `line` contains. */
function lineEvidence(
  line: Buffer,
  mentioned: readonly string[],
  out: Map<string, SendIdEvidence[]>
): void {
  const add = (id: string, item: SendIdEvidence) => {
    const list = out.get(id) ?? [];
    list.push(item);
    out.set(id, list);
  };
  let row: unknown;
  try {
    row = JSON.parse(line.toString("utf8"));
  } catch {
    row = undefined;
  }
  // The history readers drop a line that is not a readable message: it cannot show the send's
  // content, but it may be the send's row, so it blocks a second append without proving one.
  if (!isReadableHistoryMessage(row)) {
    for (const id of mentioned) add(id, { kind: "unreadable" });
    return;
  }
  const metadata = row.metadata as { sendIds?: unknown; sendDigests?: unknown } | undefined;
  const sendIds = metadata?.sendIds;
  // A quoted id can also sit in client metadata (muxMetadata is a black box): only the row's
  // own metadata.sendIds counts. A malformed list proves nothing.
  if (sendIds === undefined) return;
  if (!Array.isArray(sendIds) || !sendIds.every((id) => typeof id === "string")) {
    for (const id of mentioned) add(id, { kind: "unreadable" });
    return;
  }
  const digests =
    metadata?.sendDigests != null && typeof metadata.sendDigests === "object"
      ? (metadata.sendDigests as Record<string, unknown>)
      : undefined;
  for (const id of mentioned) {
    if (!sendIds.includes(id)) continue;
    // Own properties only: an id such as "constructor" must not read Object.prototype.
    const digest = digests != null && Object.hasOwn(digests, id) ? digests[id] : undefined;
    add(id, { kind: "row", digest: typeof digest === "string" ? digest : undefined });
  }
}

// A row's own metadata key serializes with bare quotes; the same word inside message text is
// JSON-escaped (\"sendIds\"), so only lines with this marker can list send ids. A dropped line
// without the key (e.g. torn before it) is no evidence: rows this code writes always carry the
// key before their ids, and the readers never show such a line, so appending is no visible copy.
const SEND_IDS_MARKER = Buffer.from('"sendIds"');
// A quoted id-shaped JSON string (SendIdLookupSchema): at most 128 characters plus two quotes.
const QUOTED_ID_PATTERN = /"([A-Za-z0-9_-]{1,128})"/g;
const QUOTED_ID_MAX_BYTES = 130;

/** The wanted ids that appear as quoted strings in `text`: one pass, whatever the id count. */
function mentionedIds(text: string, wanted: ReadonlySet<string>, into: Set<string>): void {
  for (const match of text.matchAll(QUOTED_ID_PATTERN)) {
    if (wanted.has(match[1])) into.add(match[1]);
  }
}

/** Ids are ASCII, so latin1 maps each byte to one character without decoding cost. */
function lineMentions(line: Buffer, wanted: ReadonlySet<string>): string[] {
  if (!line.includes(SEND_IDS_MARKER)) return [];
  const found = new Set<string>();
  mentionedIds(line.toString("latin1"), wanted, found);
  return [...found];
}

/**
 * Collect what one JSONL file says about `ids`, reading it once in chunks. Each line is examined
 * once, whatever the number of ids: only a line with the "sendIds" key can list one, and the ids
 * it mentions come from one pass over its quoted strings. Memory is bounded: one line at a time,
 * buffered only up to `maxLineBytes`; a longer line is only searched, through a short overlap,
 * and counts as unreadable when it names an id. Nothing is kept after the call.
 */
async function scanFile(
  filePath: string,
  ids: readonly string[],
  out: Map<string, SendIdEvidence[]>,
  maxLineBytes: number
): Promise<void> {
  let handle: fsPromises.FileHandle;
  try {
    handle = await fsPromises.open(filePath, "r");
  } catch (error) {
    if (isErrnoWithCode(error, "ENOENT")) return;
    throw error;
  }
  const wanted = new Set(ids);
  let parts: Buffer[] = [];
  let partsBytes = 0;
  // An over-long line: only searched (`tail` carries the overlap between pieces).
  let oversized = false;
  let tail = "";
  let oversizedMentions = new Set<string>();

  const searchOversized = (piece: Buffer) => {
    const window = tail + piece.toString("latin1");
    mentionedIds(window, wanted, oversizedMentions);
    tail = window.slice(Math.max(0, window.length - QUOTED_ID_MAX_BYTES));
  };
  const addPiece = (piece: Buffer) => {
    if (piece.length === 0) return;
    if (!oversized && partsBytes + piece.length <= maxLineBytes) {
      // Copied: the read buffer is reused for the next chunk.
      parts.push(Buffer.from(piece));
      partsBytes += piece.length;
      return;
    }
    if (!oversized) {
      oversized = true;
      const buffered = Buffer.concat(parts);
      parts = [];
      partsBytes = 0;
      searchOversized(buffered);
    }
    searchOversized(piece);
  };
  const examine = (line: Buffer) => {
    const mentioned = lineMentions(line, wanted);
    if (mentioned.length > 0) lineEvidence(line, mentioned, out);
  };
  const endLine = () => {
    if (oversized) {
      for (const id of oversizedMentions) {
        const list = out.get(id) ?? [];
        list.push({ kind: "unreadable" });
        out.set(id, list);
      }
    } else if (partsBytes > 0) {
      examine(parts.length === 1 ? parts[0] : Buffer.concat(parts));
    }
    parts = [];
    partsBytes = 0;
    oversized = false;
    tail = "";
    oversizedMentions = new Set();
  };

  try {
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      const data = chunk.subarray(0, bytesRead);
      let start = 0;
      for (;;) {
        const newline = data.indexOf(10, start);
        if (newline === -1) {
          addPiece(data.subarray(start));
          break;
        }
        // A line inside one chunk is checked in place before anything is copied.
        if (parts.length === 0 && !oversized && newline - start <= maxLineBytes) {
          examine(data.subarray(start, newline));
        } else {
          addPiece(data.subarray(start, newline));
          endLine();
        }
        start = newline + 1;
      }
    }
    // A last line without its newline (a torn append) is judged like any other line.
    endLine();
  } finally {
    await handle.close();
  }
}

/**
 * Whether history proves `id` accepted: every line that names it is a readable row listing it with
 * one and the same digest. A line the readers drop, a row without the id's digest, or rows that
 * disagree prove nothing (getSendStatus then answers from this process's pending set).
 */
export function provesAccepted(evidence: readonly SendIdEvidence[] | undefined): boolean {
  if (evidence == null || evidence.length === 0) return false;
  const digests = new Set<string>();
  for (const item of evidence) {
    if (item.kind !== "row" || item.digest === undefined) return false;
    digests.add(item.digest);
  }
  return digests.size === 1;
}

/**
 * What every row in `filePaths` (archive first, then the live file) says about `ids`. Callers
 * hold the history write lock; the answer is used at once and never cached.
 */
export async function readSendIdEvidence(
  filePaths: readonly string[],
  ids: readonly string[]
): Promise<Map<string, SendIdEvidence[]>> {
  const evidence = new Map<string, SendIdEvidence[]>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return evidence;
  for (const filePath of filePaths)
    await scanFile(filePath, unique, evidence, MAX_SEND_ID_LINE_BYTES);
  return evidence;
}

/**
 * Decide a publication of `identities` from every row in `filePaths` (archive first, then the
 * live file). Callers hold the history write lock, so no append lands between this read and
 * their write. Nothing is cached: a negative answer is only ever used for the append that
 * follows it under the same lock.
 */
export async function decideSendIdsFromHistory(
  filePaths: readonly string[],
  identities: readonly SendIdentity[],
  maxLineBytes = MAX_SEND_ID_LINE_BYTES
): Promise<SendIdDecision> {
  assert(identities.length > 0, "a send id lookup needs at least one id");
  // Every id was minted for this send and never offered before: no row can hold one. Reading a
  // large history under the write lock costs about 30-190 ms at 50k rows, so it is skipped here.
  if (identities.every((identity) => identity.unpublished === true)) {
    assert(
      identities.every((identity) => identity.id.startsWith(MINTED_SEND_ID_PREFIX)),
      "only a backend-minted send id can be unpublished"
    );
    return decideSendIds(identities, new Map());
  }
  const evidence = new Map<string, SendIdEvidence[]>();
  const ids = [...new Set(identities.map((identity) => identity.id))];
  for (const filePath of filePaths) await scanFile(filePath, ids, evidence, maxLineBytes);
  return decideSendIds(identities, evidence);
}
