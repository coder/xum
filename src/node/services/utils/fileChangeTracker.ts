import { constants } from "fs";
import { open, realpath, stat } from "fs/promises";
import assert from "@/common/utils/assert";
import { computeDiff } from "@/node/utils/diff";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { createFileChangeNotificationMessageId } from "@/node/services/utils/messageIds";

/**
 * Represents a file's content and modification timestamp.
 */
export interface FileState {
  content: string;
  timestamp: number; // mtime in ms
}

/**
 * Attachment for files that were edited externally between messages.
 *
 * Deliberately carries no content or diff: see createFileChangeNotificationMessage.
 */
export interface EditedFileAttachment {
  type: "edited_text_file";
  filename: string;
}

/**
 * Result of a side-effect-free change-detection pass.
 *
 * `commit()` advances the tracker's stored state to the detected
 * content/mtime. Callers must invoke it only AFTER the notification derived
 * from `attachments` has been durably persisted (appended to chat.jsonl).
 * On abort or append failure, skip `commit()` so a retry re-detects the same
 * changes instead of silently dropping them forever.
 */
export interface FileChangeDetection {
  attachments: EditedFileAttachment[];
  commit: () => void;
}

/** Internal: one detected change plus the state commit() would store. */
interface DetectedChange {
  attachment: EditedFileAttachment;
  canonicalPath: string;
  detectedState: FileState;
}

/**
 * A file name inside the notice, as a JSON string. JSON escapes quotes and newlines, so the name
 * cannot start a new line of the notice. `<` is escaped too (as in artifactBridge's inline JSON),
 * so a name that holds `</system-file-update>` cannot close the frame early.
 */
function quoteFilename(filename: string): string {
  return JSON.stringify(filename).replace(/</g, "\\u003c");
}

/**
 * Build the durable <system-file-update> notification for externally edited files.
 *
 * Appended to chat.jsonl at turn start — BEFORE the request is built from
 * history — so the provider request stays a pure function of the session log
 * (anything model-visible must exist as a durable history row first). There is
 * intentionally no request-time injection path for these notifications.
 *
 * The row is user-role, and the model replays it as the user's own words on every later
 * request until compaction. Any process can write a tracked file (a formatter, the agent's
 * own bash, `git pull`, another agent in a shared checkout), so the row names the file and
 * copies none of its content. The agent reads the content through `file_read`, which returns
 * it as a tool result. The row also does not say who made the change: Xum cannot know.
 * The file name stays in the row (the agent needs it to read the file), escaped by
 * quoteFilename. Keep the `file-change-` id, the `<system-file-update>` prefix and
 * `synthetic: true`: the renderer hides the row by them, and older clients do the same.
 */
export function createFileChangeNotificationMessage(
  changedFileAttachments: EditedFileAttachment[]
): MuxMessage {
  assert(changedFileAttachments.length > 0, "file change notification requires attachments");

  const notice = changedFileAttachments
    .map(
      (att) =>
        `Note: ${quoteFilename(att.filename)} changed on disk after Xum last recorded it ` +
        `(your last edit of it, or the user's @-mention of it).\n` +
        `Xum cannot tell who changed it, so it does not copy the change into this message. ` +
        `Read the file with file_read before you edit it again. ` +
        `Do not revert the change unless the user asks you to.`
    )
    .join("\n\n");

  return createMuxMessage(
    createFileChangeNotificationMessageId(),
    "user",
    `<system-file-update>\n${notice}\n</system-file-update>`,
    {
      timestamp: Date.now(),
      synthetic: true,
    }
  );
}

/**
 * Tracks file content state and detects external modifications.
 *
 * Used to append notices of externally-edited files as durable history rows
 * before each LLM query.
 */
export class FileChangeTracker {
  private readonly fileState = new Map<string, FileState>();

  private async canonicalize(filePath: string): Promise<string> {
    try {
      return await realpath(filePath);
    } catch {
      return filePath;
    }
  }

  /** Normalize tracked paths to canonical real paths and deduplicate symlink aliases. */
  private async normalizeTrackedPaths(): Promise<void> {
    const canonicalState = new Map<string, FileState>();

    for (const [filePath, state] of this.fileState.entries()) {
      const canonicalPath = await this.canonicalize(filePath);
      const existingState = canonicalState.get(canonicalPath);
      if (existingState == null || state.timestamp > existingState.timestamp) {
        canonicalState.set(canonicalPath, state);
      }
    }

    this.fileState.clear();
    for (const [canonicalPath, state] of canonicalState.entries()) {
      this.fileState.set(canonicalPath, state);
    }
  }

  /** Record a file's current content and mtime. */
  async record(filePath: string, state: FileState): Promise<void> {
    const canonicalPath = await this.canonicalize(filePath);
    this.fileState.set(canonicalPath, state);
  }

  /** Capture only these accepted states, before later tool reads can replace their baseline. */
  captureSnapshotBaseline(states: readonly FileState[]): { restore(): void; forget(): void } {
    const accepted = new Set(states);
    const entries = [...this.fileState]
      .filter(([, state]) => accepted.has(state))
      .map(([path, original]) => ({ path, original, snapshot: { ...original } }));
    return {
      // Canonical paths and bytes are already known; restoring must not await or reread disk.
      restore: () => {
        for (const entry of entries) this.fileState.set(entry.path, entry.snapshot);
      },
      forget: () => {
        for (const entry of entries) {
          const current = this.fileState.get(entry.path);
          if (current === entry.original || current === entry.snapshot)
            this.fileState.delete(entry.path);
        }
      },
    };
  }

  /** Get count of tracked files. */
  get count(): number {
    return this.fileState.size;
  }

  /** Get paths of all tracked files. */
  get paths(): string[] {
    return Array.from(this.fileState.keys());
  }

  /** Clear all tracked state (e.g., on /clear). */
  clear(): void {
    this.fileState.clear();
  }

  /**
   * Check all tracked files for external modifications WITHOUT mutating
   * tracked state. Stored state advances only via the returned `commit()` —
   * see FileChangeDetection for the persist-first contract. If detection
   * mutated state eagerly, an aborted turn or failed history append would
   * make retries see mtime <= tracked timestamp and drop the change forever.
   */
  async getChangedAttachments(): Promise<FileChangeDetection> {
    await this.normalizeTrackedPaths();

    const checks = Array.from(this.fileState.entries()).map(
      async ([filePath, state]): Promise<DetectedChange | null> => {
        try {
          const canonicalPath = await this.canonicalize(filePath);
          const trackedState = this.fileState.get(canonicalPath) ?? state;
          // Detection is awaited on every send, before the request is built. A tracked path can
          // be replaced by something that is not a regular file: a FIFO with no writer parks a
          // blocking open/read (and its libuv worker) until a writer appears, i.e. forever.
          // Open nonblocking, classify with fstat on the acquired handle (a stat-then-read
          // check races a swap of the path), and read regular files from that same handle.
          // Non-regular files produce no attachment and keep their baseline, so a later
          // regular edit is still compared with the content the agent last saw.
          // This reads the host filesystem for every runtime (the tracker never goes through
          // the runtime), so the guard covers all of them. O_NONBLOCK is undefined on Windows.
          //
          // Path stat first, as a cheap filter that holds no descriptor: unchanged and
          // non-regular paths stop here, so a session with many tracked files opens only the
          // changed ones (opening every path at once could hit EMFILE and silently drop edits).
          // The handle's fstat below still decides; this stat only skips work.
          const pathInfo = await stat(canonicalPath);
          if (!pathInfo.isFile() || pathInfo.mtimeMs <= trackedState.timestamp) return null;

          const handle = await open(
            canonicalPath,
            constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)
          );
          try {
            const info = await handle.stat();
            if (!info.isFile()) return null;
            const currentMtime = info.mtimeMs;
            if (currentMtime <= trackedState.timestamp) return null; // No change

            const currentContent = await handle.readFile("utf-8");
            // Only whether the content changed matters: the diff text is never used (it would put
            // process-written text in a user-role row), so the notice fires exactly when it did.
            // A null diff means the content is identical despite the mtime change.
            if (!computeDiff(trackedState.content, currentContent)) return null;

            return {
              attachment: {
                type: "edited_text_file",
                filename: canonicalPath,
              },
              canonicalPath,
              detectedState: { content: currentContent, timestamp: currentMtime },
            };
          } finally {
            await handle.close();
          }
        } catch {
          // File deleted or inaccessible, skip
          return null;
        }
      }
    );

    const detected = (await Promise.all(checks)).filter((r): r is DetectedChange => r !== null);

    return {
      attachments: detected.map((d) => d.attachment),
      commit: () => {
        for (const { canonicalPath, detectedState } of detected) {
          const existing = this.fileState.get(canonicalPath);
          // Don't clobber state recorded after detection (e.g. a fresh
          // record() from a tool read) with the older detection snapshot.
          if (existing == null || existing.timestamp < detectedState.timestamp) {
            this.fileState.set(canonicalPath, detectedState);
          }
        }
      },
    };
  }
}
