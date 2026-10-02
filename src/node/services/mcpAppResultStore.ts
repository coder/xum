import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import assert from "@/common/utils/assert";
import { isMcpAppResourceUri } from "@/common/utils/mcpApps";
import { log } from "@/node/services/log";
import { ensurePrivateDir } from "@/node/utils/fs";
import writeFileAtomic from "@/node/utils/writeFileAtomic";

/**
 * Host-only side store for MCP Apps tool results (artifacts experiment).
 *
 * A view needs the full CallToolResult (structuredContent and result `_meta`), but the model
 * copy goes through mcpResultTransform, which strips protocol `_meta` and caps sizes so history
 * replays stay small. Instead of weakening that, the raw result of a tool that declares a view
 * is kept here, keyed by workspaceId + toolCallId. It is never part of chat history or any
 * provider request. Records live in memory and in `<sessionDir>/mcp-app-results/`, so they are
 * deleted with the workspace. When a record is missing (older history, pruned, oversized),
 * the view still opens with tool input only; the tool is never called again for it.
 */

export const MCP_APP_RESULT_DIR = "mcp-app-results";
/** Largest serialized record kept; bigger results are stored without the result body. */
export const MCP_APP_RESULT_MAX_BYTES = 1024 * 1024;
/** Records kept per workspace on disk (oldest pruned first). */
export const MCP_APP_RESULT_MAX_PER_WORKSPACE = 50;
/** Records cached in memory across workspaces. */
const MEMORY_MAX_ENTRIES = 100;

const McpAppResultRecordSchema = z.object({
  version: z.literal(1),
  toolCallId: z.string().min(1),
  serverName: z.string().min(1),
  toolName: z.string().min(1),
  resourceUri: z.string().refine(isMcpAppResourceUri),
  arguments: z.unknown(),
  /** Raw CallToolResult, or null when it was too large to keep. */
  result: z.unknown().nullable(),
  createdAt: z.number(),
});
export type McpAppResultRecord = z.infer<typeof McpAppResultRecordSchema>;

function fileNameFor(toolCallId: string): string {
  // Tool call IDs come from providers; hash them so they are always safe file names.
  return `${createHash("sha256").update(toolCallId).digest("hex").slice(0, 40)}.json`;
}

export class McpAppResultStore {
  private readonly memory = new Map<string, McpAppResultRecord>();

  constructor(private readonly getSessionDir: (workspaceId: string) => string) {}

  private dirFor(workspaceId: string): string {
    assert(
      workspaceId.length > 0 && path.basename(workspaceId) === workspaceId && workspaceId !== "..",
      "McpAppResultStore: invalid workspaceId"
    );
    return path.join(this.getSessionDir(workspaceId), MCP_APP_RESULT_DIR);
  }

  private remember(workspaceId: string, record: McpAppResultRecord) {
    const key = `${workspaceId}\0${record.toolCallId}`;
    this.memory.delete(key);
    this.memory.set(key, record);
    while (this.memory.size > MEMORY_MAX_ENTRIES) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
  }

  /** Record a tool result. Never throws: a failed write only means the view opens without it. */
  async record(
    workspaceId: string,
    input: Omit<McpAppResultRecord, "version" | "createdAt">
  ): Promise<void> {
    try {
      let record: McpAppResultRecord = { version: 1, createdAt: Date.now(), ...input };
      let serialized = JSON.stringify(record);
      if (Buffer.byteLength(serialized, "utf8") > MCP_APP_RESULT_MAX_BYTES) {
        record = { ...record, result: null };
        serialized = JSON.stringify(record);
        if (Buffer.byteLength(serialized, "utf8") > MCP_APP_RESULT_MAX_BYTES) return;
      }
      const dir = this.dirFor(workspaceId);
      await ensurePrivateDir(dir);
      await writeFileAtomic(path.join(dir, fileNameFor(record.toolCallId)), serialized);
      // Publish to memory only once the record is durable: a failed write must not leave a
      // record that opens now but vanishes on restart. Before prune, so a prune failure does
      // not hide a record that is already on disk.
      this.remember(workspaceId, record);
      await this.prune(dir);
    } catch (error) {
      log.debug("[MCP Apps] Failed to record tool result", { workspaceId, error });
    }
  }

  async get(workspaceId: string, toolCallId: string): Promise<McpAppResultRecord | null> {
    const cached = this.memory.get(`${workspaceId}\0${toolCallId}`);
    if (cached) return cached;
    try {
      const raw = await fs.readFile(
        path.join(this.dirFor(workspaceId), fileNameFor(toolCallId)),
        "utf8"
      );
      const parsed = McpAppResultRecordSchema.safeParse(JSON.parse(raw));
      // A corrupt or foreign record reads as missing (self-healing), never as an error.
      if (!parsed.success || parsed.data.toolCallId !== toolCallId) return null;
      this.remember(workspaceId, parsed.data);
      return parsed.data;
    } catch {
      return null;
    }
  }

  private async prune(dir: string) {
    const names = (await fs.readdir(dir)).filter((name) => name.endsWith(".json"));
    if (names.length <= MCP_APP_RESULT_MAX_PER_WORKSPACE) return;
    const withTimes = await Promise.all(
      names.map(async (name) => {
        try {
          return { name, mtimeMs: (await fs.stat(path.join(dir, name))).mtimeMs };
        } catch {
          return { name, mtimeMs: 0 };
        }
      })
    );
    withTimes.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const { name } of withTimes.slice(
      0,
      withTimes.length - MCP_APP_RESULT_MAX_PER_WORKSPACE
    )) {
      await fs.rm(path.join(dir, name), { force: true });
    }
  }
}
