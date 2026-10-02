import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  MCP_APP_RESULT_DIR,
  MCP_APP_RESULT_MAX_BYTES,
  MCP_APP_RESULT_MAX_PER_WORKSPACE,
  McpAppResultStore,
} from "./mcpAppResultStore";
import { DisposableTempDir } from "./tempDir";

const entry = (toolCallId: string, result: unknown = { content: [] }) => ({
  toolCallId,
  serverName: "srv",
  toolName: "show",
  resourceUri: "ui://srv/view",
  arguments: {},
  result,
});

describe("McpAppResultStore", () => {
  test("persists records in the session dir and reads them back after a restart", async () => {
    using tmp = new DisposableTempDir("mcp-app-store");
    const sessionDir = (id: string) => path.join(tmp.path, id);
    await new McpAppResultStore(sessionDir).record(
      "ws",
      entry("c1", { structuredContent: { a: 1 } })
    );
    const fresh = new McpAppResultStore(sessionDir);
    expect((await fresh.get("ws", "c1"))?.result).toEqual({ structuredContent: { a: 1 } });
    expect(await fresh.get("ws", "missing")).toBeNull();
    expect(await fresh.get("other-ws", "c1")).toBeNull();
  });

  test("drops oversized result bodies and treats corrupt files as missing", async () => {
    using tmp = new DisposableTempDir("mcp-app-store");
    const sessionDir = (id: string) => path.join(tmp.path, id);
    const store = new McpAppResultStore(sessionDir);
    await store.record("ws", entry("big", { text: "x".repeat(MCP_APP_RESULT_MAX_BYTES) }));
    const big = await new McpAppResultStore(sessionDir).get("ws", "big");
    expect(big?.result).toBeNull();

    const dir = path.join(tmp.path, "ws", MCP_APP_RESULT_DIR);
    for (const name of await fs.readdir(dir)) await fs.writeFile(path.join(dir, name), "{nope");
    expect(await new McpAppResultStore(sessionDir).get("ws", "big")).toBeNull();
  });

  test("a record whose disk write fails is not served from memory", async () => {
    using tmp = new DisposableTempDir("mcp-app-store");
    const store = new McpAppResultStore((id) => path.join(tmp.path, id));
    // A directory where the record file belongs makes the atomic rename fail.
    const name = `${createHash("sha256").update("c1").digest("hex").slice(0, 40)}.json`;
    await fs.mkdir(path.join(tmp.path, "ws", MCP_APP_RESULT_DIR, name), { recursive: true });
    await store.record("ws", entry("c1"));
    expect(await store.get("ws", "c1")).toBeNull();
  });

  test("prunes the oldest records past the per-workspace cap", async () => {
    using tmp = new DisposableTempDir("mcp-app-store");
    const store = new McpAppResultStore((id) => path.join(tmp.path, id));
    for (let i = 0; i < MCP_APP_RESULT_MAX_PER_WORKSPACE + 3; i++) {
      await store.record("ws", entry(`c${i}`));
    }
    const files = await fs.readdir(path.join(tmp.path, "ws", MCP_APP_RESULT_DIR));
    expect(files).toHaveLength(MCP_APP_RESULT_MAX_PER_WORKSPACE);
  });
});
