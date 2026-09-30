import * as fs from "node:fs/promises";
import { scanHistoryRowsFromHandle, type HistoryRowVisitor } from "./historyRowScanner";

/**
 * Test convenience: scan a whole file by path. Production callers
 * (historyReplacementRows) open and stat their own handle so they can keep
 * inspecting the same inode, so they call scanHistoryRowsFromHandle directly.
 */
export async function scanHistoryRows(
  filePath: string,
  beginRow: (start: number) => HistoryRowVisitor,
  options: { signal?: AbortSignal; decoding?: "strict" | "replacement" } = {}
): Promise<boolean> {
  await using handle = await fs.open(filePath, "r");
  const { size } = await handle.stat();
  return await scanHistoryRowsFromHandle(handle, size, beginRow, options);
}
