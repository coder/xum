// Frozen copy of findProviderHistoryStart at 55c8e3c76f1cd92457f2a4f12b393c7ce77efe8a (#4655
// differential oracle). Do not edit to follow production; delete together with the locator fast
// path. historyScanner.differential.test.ts compares production against this copy, so a change
// to which rows the production locator parses or probes shows up as a divergence here.
import type * as fs from "node:fs/promises";
import assert from "node:assert";
import {
  SESSION_HISTORY_COMPACTION_BOUNDARY_NEEDLE,
  SESSION_HISTORY_MAX_BOUNDARY_ROW_BYTES,
  SESSION_HISTORY_MAX_LINE_BYTES,
  SESSION_HISTORY_SCAN_CHUNK_BYTES,
} from "@/common/constants/contextBudget";
import type { MuxMessage } from "@/common/types/message";
import { isManualHistoryReset } from "@/common/utils/messages/contextWindows";
import {
  isDurableCompactionBoundaryMarker,
  isDurableContextBoundaryMarker,
} from "@/common/utils/messages/compactionBoundary";
import {
  addHistoryResetProbe,
  classifyHistoryScanRow,
  type HistoryResetProbe,
  type LocatedHistoryBoundary,
  type ProviderHistoryStart,
  type ScannedHistoryRow,
} from "./historyScanner";
import { log } from "./log";

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
