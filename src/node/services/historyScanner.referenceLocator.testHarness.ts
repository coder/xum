// Frozen copy of findProviderHistoryStart at 55c8e3c76f1cd92457f2a4f12b393c7ce77efe8a (#4655
// differential oracle), together with every historyScanner.ts helper it reaches: the reset token
// recognizer, the raw-marker and ambiguous-key checks, the readability check and the row
// classifier. Do not edit to follow production; delete together with the locator fast path.
// historyScanner.differential.test.ts compares production against this copy, so a change in
// historyScanner.ts to which rows the locator parses, probes, floors at or delivers shows up as a
// divergence. Blind spot: helpers and constants imported from other modules below
// (normalizePersistedMessage, isManualHistoryReset, the boundary predicates, MuxMessageSchema and
// the contextBudget constants) are shared with production, so a change there changes both sides.
import { createScanner, SyntaxKind } from "jsonc-parser";
import type * as fs from "node:fs/promises";
import assert from "node:assert";
import {
  SESSION_HISTORY_COMPACTION_BOUNDARY_NEEDLE,
  SESSION_HISTORY_MAX_BOUNDARY_ROW_BYTES,
  SESSION_HISTORY_MAX_LINE_BYTES,
  SESSION_HISTORY_RESET_NEEDLE,
  SESSION_HISTORY_RESET_PROBE_CHARS,
  SESSION_HISTORY_SCAN_CHUNK_BYTES,
} from "@/common/constants/contextBudget";
import { MuxMessageSchema } from "@/common/orpc/schemas/message";
import type { MuxMessage } from "@/common/types/message";
import { isManualHistoryReset } from "@/common/utils/messages/contextWindows";
import {
  isDurableCompactionBoundaryMarker,
  isDurableContextBoundaryMarker,
} from "@/common/utils/messages/compactionBoundary";
import { normalizePersistedMessage } from "@/node/utils/messages/normalizePersistedMessage";
import type { CompactionPendingBoundary as PendingBoundary } from "./compactionPendingState";
import { log } from "./log";

const [resetKeyToken, resetValueToken] = SESSION_HISTORY_RESET_NEEDLE.split(":");
const resetTokenPattern = new RegExp(
  [resetKeyToken, resetValueToken, ":"]
    .map((token) =>
      [...token]
        .map((character) => {
          const hex = character
            .charCodeAt(0)
            .toString(16)
            .padStart(4, "0")
            .replace(/[a-f]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);
          return `(?:${character}|\\\\(?:u${hex}|x${hex.slice(2)}))`;
        })
        .join("")
    )
    .join("|"),
  "g"
);

function isReadableHistoryMessage(value: unknown): value is MuxMessage {
  return (
    !!value &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "string" &&
    "role" in value &&
    ["user", "assistant", "system"].includes(String(value.role)) &&
    (!("metadata" in value) ||
      value.metadata === undefined ||
      (value.metadata !== null &&
        typeof value.metadata === "object" &&
        !Array.isArray(value.metadata))) &&
    "parts" in value &&
    MuxMessageSchema.shape.parts.safeParse(value.parts).success
  );
}

// Corrupted JSON can contain JS hex escapes; raw and incremental probes must
// recognize the same reset tokens without making the row provider-readable.
function decodeResetEscapes(text: string): string {
  return text.replace(/\\(?:u[\da-fA-F]{4}|x[\da-fA-F]{2})/g, (escape) =>
    String.fromCharCode(Number.parseInt(escape.slice(2), 16))
  );
}

function compactResetProbe(text: string): string {
  // Corruption may insert raw or escaped control separators where JSON permits
  // whitespace. Remove them before retaining overlap, including long runs.
  return stripEscapedResetSeparators(stripRawResetSeparators(text));
}

function stripRawResetSeparators(text: string): string {
  return text.replace(/[\s\p{Cc}]/gu, "");
}
function stripEscapedResetSeparators(text: string): string {
  return text.replace(/\\(?:u00|x)(?:[0189][\da-f]|20|7f)/gi, "");
}

function hasRawResetMarker(text: string): boolean {
  const decoded = decodeResetEscapes(compactResetProbe(text));
  return decoded.includes(SESSION_HISTORY_RESET_NEEDLE);
}

/** Call only for parsed reset candidates; oversized rows cannot establish a rollover exemption. */
function hasAmbiguousResetKeys(text: string): boolean {
  if (Buffer.byteLength(text, "utf8") > SESSION_HISTORY_MAX_LINE_BYTES) return true;
  const scanner = createScanner(text, true);
  const scopes: Array<Set<string> | null> = [];
  let previousString: string | undefined;
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    switch (token) {
      case SyntaxKind.OpenBraceToken:
        scopes.push(new Set());
        break;
      case SyntaxKind.OpenBracketToken:
        scopes.push(null);
        break;
      case SyntaxKind.CloseBraceToken:
      case SyntaxKind.CloseBracketToken:
        scopes.pop();
        break;
      case SyntaxKind.StringLiteral:
        // Token values decode escapes, so metadata and metad\\u0061ta collide.
        previousString = scanner.getTokenValue();
        continue;
      case SyntaxKind.ColonToken: {
        const keys = scopes.at(-1);
        assert(keys && previousString !== undefined, "parsed JSON colon must follow an object key");
        if (keys.has(previousString)) return true;
        keys.add(previousString);
        break;
      }
      default:
        break;
    }
    previousString = undefined;
  }
  return false;
}

interface HistoryResetProbe {
  resetProbe: string;
  resetStage: 0 | 1 | 2;
  possibleReset: boolean;
}

function addHistoryResetProbe(state: HistoryResetProbe, segment: Buffer, reverse: boolean): void {
  // Oversized tool outputs remain traversable. Only a potential reset
  // marker is a fail-closed privacy barrier. Match raw bytes (including
  // nested objects conservatively) without parsing or retaining the row.
  // Keep only token-sized raw overlap plus a three-stage recognizer.
  // Junk of arbitrary size may separate intact tokens in unreadable rows;
  // valid rows isolate their own evidence in deliver() and reset this state.
  const raw = segment.toString("latin1");
  const previousLength = state.resetProbe.length;
  const probe = reverse ? raw + state.resetProbe : state.resetProbe + raw;
  const tokens = [...probe.matchAll(resetTokenPattern)];
  if (reverse) tokens.reverse();
  for (const match of tokens) {
    // Ignore tokens entirely inside already-consumed overlap. Otherwise
    // replaying overlap could manufacture the opposite token ordering.
    if (reverse ? match.index >= raw.length : match.index + match[0].length <= previousLength)
      continue;
    const token = decodeResetEscapes(match[0]);
    if (token === (reverse ? resetValueToken : resetKeyToken)) {
      if (state.resetStage === 0) state.resetStage = 1;
    } else if (token === ":" && state.resetStage === 1) state.resetStage = 2;
    else if (token === (reverse ? resetKeyToken : resetValueToken) && state.resetStage === 2)
      state.possibleReset = true;
  }
  state.resetProbe = reverse
    ? probe.slice(0, SESSION_HISTORY_RESET_PROBE_CHARS - 1)
    : probe.slice(-(SESSION_HISTORY_RESET_PROBE_CHARS - 1));
}

function classifyHistoryScanRow(text: string, probe: HistoryResetProbe): MuxMessage | null {
  let rowReset = hasRawResetMarker(text);
  probe.possibleReset ||= rowReset;
  try {
    const raw: unknown = JSON.parse(text);
    try {
      rowReset ||= JSON.stringify(raw).includes(SESSION_HISTORY_RESET_NEEDLE);
      probe.possibleReset ||= rowReset;
    } catch {
      rowReset = true;
      probe.possibleReset = true;
    }
    if (rowReset && hasAmbiguousResetKeys(text)) return null;
    if (!isReadableHistoryMessage(raw)) return null;
    // Readable payloads may discuss resets; only their top-level metadata can
    // mark one. Raw evidence is reserved for unreadable/ambiguous rows above.
    probe.possibleReset = false;
    return normalizePersistedMessage(raw);
  } catch {
    return null;
  }
}

interface LocatedHistoryBoundary {
  offset: number;
  boundaryPublicationId?: string;
  boundary: Exclude<PendingBoundary, { kind: "none" }>;
}
type ProviderHistoryStart =
  | ({ kind: "start" } & LocatedHistoryBoundary)
  | { kind: "exhausted"; oldestBoundary: LocatedHistoryBoundary | null; boundaryCount: number }
  | { kind: "stopped" };

/** One non-empty row delivered by the provider locator, newest first. */
interface ScannedHistoryRow {
  start: number;
  /** Row bytes, excluding the newline. */
  size: number;
  /**
   * Null for unreadable and ambiguous-reset rows, and for oversized
   * (> SESSION_HISTORY_MAX_LINE_BYTES) rows other than a recovered compaction boundary.
   */
  message: MuxMessage | null;
}
const COMPACTION_BOUNDARY_NEEDLE = Buffer.from(SESSION_HISTORY_COMPACTION_BOUNDARY_NEEDLE);
const STOPPED = Symbol("stopped");

/**
 * Provider-only location: bound row/probe carryover, not the amount of context scanned.
 * `visit` sees every delivered row and may request a stop; the stop is honored only right
 * after a readable row that is not the start, where no scan state carries over.
 */
export async function referenceFindProviderHistoryStart(
  handle: fs.FileHandle,
  fileSize: number,
  skip: number,
  includeReadableResetFloor: boolean,
  visit?: (row: ScannedHistoryRow) => boolean
): Promise<ProviderHistoryStart> {
  const probe: HistoryResetProbe = { resetProbe: "", resetStage: 0, possibleReset: false };
  let parts: Buffer[] = [];
  let size = 0;
  let rowEnd = fileSize;
  let unreadableRunEnd: number | null = null;
  let oldestBoundary: LocatedHistoryBoundary | null = null;
  let boundaryCount = 0;
  // Oversized rows are not buffered, so remember whether their raw bytes could hold the compact
  // boundary marker. Segments arrive in reverse order: carry the start of the later segment so a
  // marker split across two segments is still seen.
  let boundaryMarkerSeen = false;
  let boundaryMarkerCarry = Buffer.alloc(0);
  const add = (bytes: Buffer) => {
    addHistoryResetProbe(probe, bytes, true);
    if (!boundaryMarkerSeen) {
      const window =
        boundaryMarkerCarry.length > 0 ? Buffer.concat([bytes, boundaryMarkerCarry]) : bytes;
      boundaryMarkerSeen = window.includes(COMPACTION_BOUNDARY_NEEDLE);
      boundaryMarkerCarry = Buffer.from(window.subarray(0, COMPACTION_BOUNDARY_NEEDLE.length - 1));
    }
    size += bytes.length;
    if (size <= SESSION_HISTORY_MAX_LINE_BYTES) parts.push(bytes);
    else parts = [];
  };
  /**
   * An oversized compaction boundary behaves exactly like a normal-size one (#4551): rotation
   * already treats it as the epoch start, and skipping it here would bring the sealed epoch back
   * from the archive. Re-read just that row and classify it unchanged, accepting only a durable
   * compaction boundary; ordinary oversized rows and reset evidence keep today's handling (the
   * classifier treats reset keys in oversized text as ambiguous, i.e. an unreadable floor).
   */
  const recoverOversizedBoundary = async (start: number): Promise<MuxMessage | null> => {
    if (!boundaryMarkerSeen || probe.possibleReset) return null;
    if (size > SESSION_HISTORY_MAX_BOUNDARY_ROW_BYTES) {
      log.warn("Oversized compaction boundary row exceeds the recovery ceiling", {
        offset: start,
        bytes: size,
      });
      return null;
    }
    const row = Buffer.alloc(size);
    const read = await handle.read(row, 0, size, start);
    if (read.bytesRead !== size) throw new Error("History changed during provider read");
    const candidate = classifyHistoryScanRow(row.toString("utf8"), probe);
    if (!isDurableCompactionBoundaryMarker(candidate ?? undefined)) return null;
    log.debug("Recovered an oversized compaction boundary row", { offset: start, bytes: size });
    return candidate;
  };
  const deliver = async (
    start: number
  ): Promise<LocatedHistoryBoundary | typeof STOPPED | null> => {
    if (size === 0) {
      rowEnd = start;
      boundaryMarkerSeen = false;
      boundaryMarkerCarry = Buffer.alloc(0);
      return null;
    }
    const message =
      size > SESSION_HISTORY_MAX_LINE_BYTES
        ? await recoverOversizedBoundary(start)
        : classifyHistoryScanRow(Buffer.concat(parts.reverse()).toString("utf8"), probe);
    const stopRequested = visit?.({ start, size, message }) === true;
    if (message) unreadableRunEnd = null;
    else unreadableRunEnd ??= rowEnd;
    const durableBoundary = message !== null && isDurableContextBoundaryMarker(message);
    if (isManualHistoryReset(message, probe.possibleReset)) {
      // Retain readable reset markers, but never count them as skippable boundaries.
      // Deletion also needs readable malformed-role floors that provider requests exclude.
      if (durableBoundary || (includeReadableResetFloor && message))
        return {
          offset: start,
          boundaryPublicationId: message.metadata?.compactionPublicationId,
          boundary: durableBoundary
            ? { kind: "identified", messageId: message.id }
            : { kind: "unreadable-reset" },
        };
      // A fragmented marker may end several rows to the right of the key that
      // completed recognition. Never return any of that unreadable evidence.
      return { offset: unreadableRunEnd ?? rowEnd, boundary: { kind: "unreadable-reset" } };
    }
    if (durableBoundary) {
      oldestBoundary = {
        offset: start,
        boundary: { kind: "identified", messageId: message.id },
        boundaryPublicationId: message.metadata?.compactionPublicationId,
      };
      if (boundaryCount++ === skip) return oldestBoundary;
    }
    if (message) {
      probe.resetProbe = "";
      probe.resetStage = 0;
      probe.possibleReset = false;
      // Suffix reads (#4720) may stop only here, right after a readable row R that is not the
      // start. Why that equals the full read's tail:
      // - Clean state: the probe was just reset, unreadableRunEnd is null (set above), parts
      //   and size reset below, rowEnd becomes R.start, and with skip 0 no boundary was
      //   skipped (the first durable boundary always returns). That is exactly a fresh scan of
      //   [0, R.start), which can only return a start <= R.start or "exhausted" (whose archive
      //   fallback keeps every row of this file). So every row visited so far, R included, is
      //   in the full provider read of this snapshot.
      // - Readable rows only: a fragmented raw reset can span a run of unreadable rows
      //   (including oversized rows the classifier never parses). When it completes further
      //   left, the floor is unreadableRunEnd, which also drops the NEWER rows of that run, so
      //   stopping on an unreadable row could return rows the full read excludes.
      if (stopRequested) {
        assert(skip === 0, "provider suffix stops require skip 0");
        return STOPPED;
      }
    }
    parts = [];
    size = 0;
    rowEnd = start;
    boundaryMarkerSeen = false;
    boundaryMarkerCarry = Buffer.alloc(0);
    return null;
  };
  for (let end = fileSize; end > 0; ) {
    const start = Math.max(0, end - SESSION_HISTORY_SCAN_CHUNK_BYTES);
    const chunk = Buffer.alloc(end - start);
    const read = await handle.read(chunk, 0, chunk.length, start);
    if (read.bytesRead !== chunk.length) throw new Error("History changed during provider read");
    let edge = chunk.length;
    for (let i = chunk.length - 1; i >= 0; i--) {
      if (chunk[i] !== 10) continue;
      add(chunk.subarray(i + 1, edge));
      const location = await deliver(start + i + 1);
      if (location === STOPPED) return { kind: "stopped" };
      if (location !== null) return { kind: "start", ...location };
      edge = i;
    }
    add(chunk.subarray(0, edge));
    end = start;
  }
  const location = await deliver(0);
  if (location === STOPPED) return { kind: "stopped" };
  return location === null
    ? { kind: "exhausted", oldestBoundary, boundaryCount }
    : { kind: "start", ...location };
}
