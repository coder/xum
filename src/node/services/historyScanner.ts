import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert";
import {
  SESSION_HISTORY_MAX_SCAN_BYTES,
  SESSION_HISTORY_SCAN_CHUNK_BYTES,
  SESSION_HISTORY_ANCHOR_BYTES,
  SESSION_HISTORY_RESET_NEEDLE,
  SESSION_HISTORY_MAX_SCAN_ROWS,
  SESSION_HISTORY_MAX_LINE_BYTES,
} from "@/common/constants/contextBudget";
import type { MuxMessage } from "@/common/types/message";
import { getContextWindowId, isManualHistoryReset } from "@/common/utils/messages/contextWindows";
import { isDurableContextBoundaryMarker } from "@/common/utils/messages/compactionBoundary";
import { normalizeLegacyMuxMetadata } from "@/node/utils/messages/legacy";
import {
  isHistoryIdentifierRepresentable,
  type HistoryArtifact,
  type HistoryScanState,
  type HistorySnapshot,
} from "./historyCursor";

export interface BoundedHistoryRow {
  message: MuxMessage;
  windowId: string;
  startsWindow: boolean;
}
export interface BoundedHistoryScanOptions {
  cursor?: HistoryScanState;
  /** Return false to leave this row unconsumed for the next page. */
  visit: (row: BoundedHistoryRow) => boolean;
}
export interface BoundedHistoryScanResult {
  cursor?: HistoryScanState;
  bytesRead: number;
  rowsScanned: number;
  oversizedLines: number;
  malformedLines: number;
  privacyFloorReached: boolean;
}

/** One mutex-held page. Never invokes migration/recovery or a full-file reader. */
export async function scanHistoryFilesBounded(
  paths: Record<HistoryArtifact, string>,
  options: BoundedHistoryScanOptions
): Promise<BoundedHistoryScanResult> {
  const result: BoundedHistoryScanResult = {
    bytesRead: 0,
    rowsScanned: 0,
    oversizedLines: 0,
    malformedLines: 0,
    privacyFloorReached: false,
  };
  const boundedWindowId = (message: MuxMessage): string | null => {
    const id = getContextWindowId(message);
    if (isHistoryIdentifierRepresentable(id)) return id;
    result.malformedLines++;
    return null;
  };
  const handles = new Map<HistoryArtifact, fs.FileHandle>();
  try {
    for (const artifact of ["chat", "archive"] as const) {
      try {
        handles.set(artifact, await fs.open(paths[artifact], "r"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const fileStamp = (
      stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number } | undefined
    ) =>
      stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : "missing";
    const initialStamps = new Map<HistoryArtifact, string>();
    for (const artifact of ["chat", "archive"] as const) {
      initialStamps.set(artifact, fileStamp(await handles.get(artifact)?.stat()));
    }
    const finish = async () => {
      // The mutex excludes local writers, not foreign backends. Never release
      // rows read through a handle that was rotated/reset while this page ran.
      for (const artifact of ["chat", "archive"] as const) {
        const current = await fs.stat(paths[artifact]).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return undefined;
        });
        if (fileStamp(current) !== initialStamps.get(artifact)) throw new Error("stale_cursor");
      }
      return result;
    };
    const read = async (artifact: HistoryArtifact, start: number, length: number) => {
      assert(length >= 0 && result.bytesRead + length <= SESSION_HISTORY_MAX_SCAN_BYTES);
      const buffer = Buffer.alloc(length);
      const bytesRead = handles.has(artifact)
        ? (await handles.get(artifact)!.read(buffer, 0, length, start)).bytesRead
        : 0;
      result.bytesRead += bytesRead;
      return buffer.subarray(0, bytesRead);
    };
    const snapshot = async (
      artifact: HistoryArtifact,
      previous?: HistorySnapshot
    ): Promise<HistorySnapshot> => {
      const stat = await handles.get(artifact)?.stat();
      const size = stat?.size ?? 0;
      const end = previous?.endOffsetSnapshot ?? size;
      const inode = stat ? `${stat.dev}:${stat.ino}` : "missing";
      const modifiedTimeMs = stat?.mtimeMs ?? 0;
      if (previous && size === end && modifiedTimeMs !== previous.modifiedTimeMs)
        throw new Error("stale_cursor");
      if (previous && (size < end || inode !== previous.inode)) throw new Error("stale_cursor");
      const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
      const headHash = hash(await read(artifact, 0, Math.min(SESSION_HISTORY_ANCHOR_BYTES, end)));
      const anchorHash = hash(
        await read(
          artifact,
          Math.max(0, end - SESSION_HISTORY_ANCHOR_BYTES),
          Math.min(SESSION_HISTORY_ANCHOR_BYTES, end)
        )
      );
      if (previous && (headHash !== previous.headHash || anchorHash !== previous.anchorHash))
        throw new Error("stale_cursor");
      return { endOffsetSnapshot: end, inode, modifiedTimeMs, headHash, anchorHash };
    };
    const initialChat = options.cursor ? undefined : await snapshot("chat");
    const state: HistoryScanState = options.cursor
      ? structuredClone(options.cursor)
      : {
          snapshots: { chat: initialChat!, archive: await snapshot("archive") },
          validatedChatSnapshot: initialChat!,
          phase: "floor",
          artifact: "chat",
          byteOffset: 0,
          skippingOversized: false,
          oversizedRowEnd: null,
          resetProbe: "",
          possibleReset: false,
          archiveWatermark: -1,
          anchorSequence: null,
          windowId: "w:0",
          windowPending: true,
          appendCheck: null,
        };
    if (!options.cursor) state.byteOffset = state.snapshots.chat.endOffsetSnapshot;
    else {
      await snapshot("chat", state.snapshots.chat);
      await snapshot("archive", state.snapshots.archive);
      await snapshot("chat", state.validatedChatSnapshot);
      // Rotation grows the archive and rewrites chat; even archive-only changes
      // invalidate the sequence watermark used to suppress crash-replay duplicates.
      if (
        (await handles.get("archive")?.stat())?.size !==
          state.snapshots.archive.endOffsetSnapshot &&
        handles.has("archive")
      )
        throw new Error("stale_cursor");
    }
    const remaining = () => SESSION_HISTORY_MAX_SCAN_BYTES - result.bytesRead;
    interface Position {
      byteOffset: number;
      skippingOversized: boolean;
      oversizedRowEnd: number | null;
      resetProbe: string;
      possibleReset: boolean;
    }
    // Read chunks with at most one line of carryover. An incomplete ordinary
    // line can be retried (<1 MiB); oversized lines resume mid-line, never from
    // their original start, so a multi-megabyte row cannot monopolize every page.
    const scan = async (
      artifact: HistoryArtifact,
      position: Position,
      reverse: boolean,
      end: number,
      lower: number,
      visit: (
        message: MuxMessage | null,
        start: number,
        finish: number,
        oversized: boolean,
        possibleReset: boolean
      ) => boolean
    ) => {
      let cursor = position.byteOffset;
      let rowEdge = cursor;
      let parts: Buffer[] = [];
      let size = 0;
      let skipping = position.skippingOversized;
      let resetProbe = skipping ? position.resetProbe : "";
      let possibleReset = skipping && position.possibleReset;
      const deliver = (edge: number): boolean => {
        const start = reverse ? edge : rowEdge;
        const finish = reverse ? (position.oversizedRowEnd ?? rowEdge) : edge;
        if (size === 0 && !skipping) {
          rowEdge = edge;
          position.byteOffset = edge;
          return true;
        }
        result.rowsScanned++;
        let message: MuxMessage | null = null;
        if (skipping) result.oversizedLines++;
        else {
          try {
            const raw: unknown = JSON.parse(
              Buffer.concat(reverse ? parts.reverse() : parts).toString("utf8")
            );
            if (
              !raw ||
              typeof raw !== "object" ||
              !("id" in raw) ||
              typeof raw.id !== "string" ||
              !("role" in raw) ||
              !["user", "assistant", "system"].includes(String(raw.role)) ||
              !("parts" in raw) ||
              !Array.isArray(raw.parts)
            )
              throw new Error();
            message = normalizeLegacyMuxMetadata(raw as MuxMessage);
          } catch {
            result.malformedLines++;
          }
        }
        if (!visit(message, start, finish, skipping, possibleReset)) return false;
        parts = [];
        size = 0;
        skipping = false;
        resetProbe = "";
        possibleReset = false;
        rowEdge = edge;
        position.byteOffset = edge;
        position.skippingOversized = false;
        position.oversizedRowEnd = null;
        return true;
      };
      while (
        (reverse ? cursor > lower : cursor < end) &&
        remaining() > 0 &&
        result.rowsScanned < SESSION_HISTORY_MAX_SCAN_ROWS
      ) {
        const length = Math.min(
          SESSION_HISTORY_SCAN_CHUNK_BYTES,
          remaining(),
          reverse ? cursor - lower : end - cursor
        );
        const start = reverse ? cursor - length : cursor;
        const chunk = await read(artifact, start, length);
        if (chunk.length !== length) throw new Error("stale_cursor");
        let segmentEdge = reverse ? chunk.length : 0;
        const add = (segment: Buffer) => {
          // Oversized tool outputs remain traversable. Only a potential reset
          // marker is a fail-closed privacy barrier. Match raw bytes (including
          // nested objects conservatively) without parsing or retaining the row.
          // Writers serialize ASCII metadata keys verbatim; Unicode-escaped keys
          // in externally edited oversized JSONL are outside this compact format.
          const compact = segment.toString("latin1").replace(/[ \t\r\n]/g, "");
          const probe = reverse ? compact + resetProbe : resetProbe + compact;
          possibleReset ||= probe.includes(SESSION_HISTORY_RESET_NEEDLE);
          resetProbe = reverse
            ? probe.slice(0, SESSION_HISTORY_RESET_NEEDLE.length - 1)
            : probe.slice(-(SESSION_HISTORY_RESET_NEEDLE.length - 1));
          size += segment.length;
          if (size > SESSION_HISTORY_MAX_LINE_BYTES) {
            position.oversizedRowEnd ??= rowEdge;
            skipping = true;
            parts = [];
          } else if (!skipping) parts.push(segment);
        };
        for (
          let i = reverse ? chunk.length - 1 : 0;
          reverse ? i >= 0 : i < chunk.length;
          reverse ? i-- : i++
        ) {
          if (chunk[i] !== 10) continue;
          add(reverse ? chunk.subarray(i + 1, segmentEdge) : chunk.subarray(segmentEdge, i));
          const edge = start + i + 1;
          if (!deliver(edge)) return false;
          segmentEdge = reverse ? i : i + 1;
          if (result.rowsScanned >= SESSION_HISTORY_MAX_SCAN_ROWS) return false;
        }
        add(reverse ? chunk.subarray(0, segmentEdge) : chunk.subarray(segmentEdge));
        cursor = reverse ? start : start + length;
      }
      if (reverse ? cursor === lower : cursor === end) {
        if (!deliver(cursor)) return false;
        position.byteOffset = cursor;
        position.skippingOversized = false;
        position.oversizedRowEnd = null;
        return true;
      }
      // Carry only the skip bit across calls, not transcript bytes in a cursor.
      position.byteOffset = skipping ? cursor : rowEdge;
      position.skippingOversized = skipping;
      position.resetProbe = resetProbe;
      position.possibleReset = possibleReset;
      return false;
    };

    // New tool-result appends do not expire a cursor. Before disclosing old rows,
    // scan all appended bytes for a new privacy floor, within this SAME budget.
    if (options.cursor) {
      const chatSize = (await handles.get("chat")?.stat())?.size ?? 0;
      if (!state.appendCheck && chatSize > state.validatedChatSnapshot.endOffsetSnapshot) {
        state.appendCheck = {
          snapshot: await snapshot("chat"),
          byteOffset: chatSize,
          skippingOversized: false,
          oversizedRowEnd: null,
          resetProbe: "",
          possibleReset: false,
        };
      }
      if (state.appendCheck) {
        const check = state.appendCheck;
        await snapshot("chat", check.snapshot);
        const completed = await scan(
          "chat",
          check,
          true,
          check.snapshot.endOffsetSnapshot,
          state.validatedChatSnapshot.endOffsetSnapshot,
          (message, _start, _end, _oversized, possibleReset) => {
            if ((!message && possibleReset) || (message && isManualHistoryReset(message)))
              throw new Error("stale_cursor");
            return true;
          }
        );
        if (!completed) {
          result.cursor = state;
          return await finish();
        }
        // Keep the retrieval snapshot fixed even when our own result is appended.
        state.validatedChatSnapshot = check.snapshot;
        state.appendCheck = null;
        if (chatSize > state.validatedChatSnapshot.endOffsetSnapshot) {
          result.cursor = state;
          return await finish();
        }
      }
    }
    while (
      state.phase !== "done" &&
      remaining() > 0 &&
      result.rowsScanned < SESSION_HISTORY_MAX_SCAN_ROWS
    ) {
      const artifact = state.artifact;
      const reverse = state.phase === "floor";
      const end = state.snapshots[artifact].endOffsetSnapshot;
      let floor: { offset: number; windowId: string | null } | undefined;
      const completed = await scan(
        artifact,
        state,
        reverse,
        end,
        0,
        (message, _start, finish, _oversized, possibleReset) => {
          if (reverse) {
            const sequence = message?.metadata?.historySequence;
            if (artifact === "archive" && Number.isSafeInteger(sequence))
              state.archiveWatermark = Math.max(state.archiveWatermark, sequence!);
            if ((!message && possibleReset) || (message && isManualHistoryReset(message))) {
              // Any unreadable row might contain a reset, even below the size cap.
              // Fail closed rather than disclosing history before a malformed reset.
              floor = { offset: finish, windowId: message ? boundedWindowId(message) : "w:0" };
              return false;
            }
            return true;
          }
          if (!message) return true;
          const sequence = message.metadata?.historySequence;
          const anchorSequence =
            Number.isSafeInteger(sequence) && sequence! >= 0 ? sequence! : null;
          if (
            artifact === "chat" &&
            anchorSequence != null &&
            anchorSequence <= state.archiveWatermark
          )
            return true;
          const windowId = isDurableContextBoundaryMarker(message)
            ? boundedWindowId(message)
            : state.windowId;
          // Consume unaddressable windows without persisting oversized IDs in
          // cursors or silently assigning their rows to a different window.
          if (
            windowId !== null &&
            !options.visit({
              message,
              windowId,
              startsWindow: state.windowPending || isDurableContextBoundaryMarker(message),
            })
          )
            return false;
          state.windowId = windowId;
          state.windowPending = false;
          state.anchorSequence = anchorSequence;
          return true;
        }
      );
      if (floor) {
        result.privacyFloorReached = true;
        state.phase = "browse";
        state.byteOffset = floor.offset;
        state.windowId = floor.windowId;
        state.windowPending = true;
        state.skippingOversized = false;
        state.oversizedRowEnd = null;
      } else if (!completed) break;
      else if (reverse && artifact === "chat") {
        state.artifact = "archive";
        state.byteOffset = state.snapshots.archive.endOffsetSnapshot;
      } else if (reverse) {
        state.phase = "browse";
        state.byteOffset = 0;
      } else if (artifact === "archive") {
        state.artifact = "chat";
        state.byteOffset = 0;
      } else state.phase = "done";
    }
    if (state.phase !== "done") result.cursor = state;
    return await finish();
  } finally {
    await Promise.all([...handles.values()].map((handle) => handle.close()));
  }
}
