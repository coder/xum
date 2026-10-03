/**
 * Read a session tape file (experiment `sessionTapes`) and validate it with the pure loader.
 * Only reads and validates: nothing here delivers tape events to a renderer, a session or a
 * provider.
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

/** Read and validate a tape file. Names not ending in `.jsonl` (temp files) are rejected unread. */
export async function readSessionTapeFile(
  filePath: string,
  options?: SessionTapeLoadOptions
): Promise<SessionTapeLoadResult> {
  if (!isFinalizedSessionTapeFileName(path.basename(filePath))) {
    return { status: "rejected", reason: "not a finalized tape (the name must end in .jsonl)" };
  }
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    return { status: "rejected", reason: `unreadable: ${getErrorMessage(error)}` };
  }
  return loadSessionTape(text, options);
}
