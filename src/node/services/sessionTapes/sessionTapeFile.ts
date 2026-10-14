/**
 * Read a session tape file (experiment `sessionTapes`) and validate it with the pure loader.
 * Only reads and validates; the desktop replay source (sessionTapeReplaySource.ts) serves the
 * result to a renderer.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getErrorMessage } from "@/common/utils/errors";
import {
  isFinalizedSessionTapeFileName,
  loadSessionTape,
  type SessionTapeLoadOptions,
  type SessionTapeLoadResult,
} from "@/common/utils/sessionTapes/sessionTapeLoader";
import { SESSION_TAPE_CAP_BYTES } from "./sessionTapeRecorder";

/** Read and validate a tape file. Names not ending in `.jsonl` (temp files) are rejected unread. */
export async function readSessionTapeFile(
  filePath: string,
  options?: SessionTapeLoadOptions
): Promise<SessionTapeLoadResult> {
  if (!isFinalizedSessionTapeFileName(path.basename(filePath))) {
    return { status: "rejected", reason: "not a finalized tape (the name must end in .jsonl)" };
  }
  const tooLarge = `larger than the recorder's ${SESSION_TAPE_CAP_BYTES}-byte tape cap`;
  let text: string;
  try {
    // Stat before reading: a FIFO or device would block or never end, and the recorder never
    // writes more than its cap, so a larger file is not a tape (and would only waste memory).
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return { status: "rejected", reason: "not a regular file" };
    if (stat.size > SESSION_TAPE_CAP_BYTES) return { status: "rejected", reason: tooLarge };
    const bytes = await fs.readFile(filePath);
    // The file can grow between stat and read.
    if (bytes.length > SESSION_TAPE_CAP_BYTES) return { status: "rejected", reason: tooLarge };
    // Fatal decoding: the recorder writes valid UTF-8, so replacement characters would mean
    // the bytes were changed after recording.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    return { status: "rejected", reason: `unreadable: ${getErrorMessage(error)}` };
  }
  return loadSessionTape(text, options);
}
