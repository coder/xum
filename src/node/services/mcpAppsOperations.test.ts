import { describe, expect, test } from "bun:test";
import type { ORPCContext } from "@/node/orpc/context";
import * as path from "node:path";
import { McpAppViewRecordsRequestSchema } from "@/common/orpc/schemas/mcpApps";
import { MCP_APP_VIEW_RECORDS_MAX_IDS } from "@/common/utils/mcpApps";
import { McpAppResultStore, type McpAppResultRecord } from "./mcpAppResultStore";
import { DisposableTempDir } from "./tempDir";
import {
  getMcpAppView,
  getMcpAppViewRecords,
  MCP_APP_TOOL_RESULT_MAX_BYTES,
  readMcpAppServerResource,
  updateMcpAppModelContext,
} from "./mcpAppsOperations";

const RECORD: McpAppResultRecord = {
  version: 1,
  toolCallId: "call-1",
  serverName: "charts",
  toolName: "show_chart",
  resourceUri: "ui://charts/view",
  arguments: { title: "Q3" },
  result: { content: [] },
  createdAt: 1,
};

function context(record: McpAppResultRecord | null, warm = true) {
  const reads: Array<{ serverName: string; uri: string }> = [];
  const ctx = {
    experimentsService: { isExperimentEnabled: () => true },
    mcpServerManager: {
      hasWorkspaceRequestOptions: () => warm,
      getMcpAppResult: () => Promise.resolve(record),
      readMcpAppResource: (_workspaceId: string, serverName: string, uri: string) => {
        reads.push({ serverName, uri });
        return Promise.resolve({ html: "<p>view</p>", csp: {}, prefersBorder: null });
      },
    },
  } as unknown as Pick<ORPCContext, "experimentsService" | "mcpServerManager">;
  return { ctx, reads };
}

const request = (overrides: Partial<{ serverName: string; resourceUri: string }> = {}) => ({
  workspaceId: "ws",
  toolCallId: "call-1",
  serverName: "charts",
  resourceUri: "ui://charts/view",
  ...overrides,
});

const noWarm = () => Promise.reject(new Error("servers are already started"));

describe("getMcpAppView", () => {
  test("starts the workspace's servers first when nothing has since the backend started", async () => {
    // After a restart no send or prompt discovery recorded request options, so the manager
    // could not start the server and every persisted view failed with "not connected".
    const { ctx, reads } = context(RECORD, false);
    const order: string[] = [];
    const result = await getMcpAppView(ctx, request(), undefined, (workspaceId) => {
      order.push(`warm:${workspaceId}:reads=${reads.length}`);
      return Promise.resolve([]);
    });
    expect(result.success).toBe(true);
    expect(order).toEqual(["warm:ws:reads=0"]);
    expect(reads).toHaveLength(1);
  });

  test("refuses a request that names another server or view than the result record", async () => {
    for (const overrides of [{ serverName: "other" }, { resourceUri: "ui://charts/other" }]) {
      const { ctx, reads } = context(RECORD);
      const result = await getMcpAppView(ctx, request(overrides), undefined, noWarm);
      expect(result.success).toBe(false);
      // Nothing is read from either server.
      expect(reads).toEqual([]);
    }
  });

  test("binds the view to the record's tool call", async () => {
    const { ctx, reads } = context(RECORD);
    const result = await getMcpAppView(ctx, request(), undefined, noWarm);
    expect(reads).toEqual([{ serverName: "charts", uri: "ui://charts/view" }]);
    if (!result.success) throw new Error(result.error);
    expect(result.data.invocation).toEqual({
      serverName: "charts",
      toolName: "show_chart",
      arguments: { title: "Q3" },
    });
    expect(result.data.resultAvailable).toBe(true);
  });

  test("a card naming the record's server by its display key opens from the raw key", async () => {
    // Cards carry describeConnection's sanitized key; the record and manager use the raw key.
    const rawKey = "my  charts";
    const { ctx, reads } = context({ ...RECORD, serverName: rawKey });
    const result = await getMcpAppView(
      ctx,
      request({ serverName: "my charts" }),
      undefined,
      noWarm
    );
    if (!result.success) throw new Error(result.error);
    expect(reads).toEqual([{ serverName: rawKey, uri: "ui://charts/view" }]);
    expect(result.data.invocation?.serverName).toBe(rawKey);
  });

  test("without a record the view opens from the request, unbound", async () => {
    const { ctx, reads } = context(null);
    const result = await getMcpAppView(ctx, request(), undefined, noWarm);
    expect(reads).toEqual([{ serverName: "charts", uri: "ui://charts/view" }]);
    if (!result.success) throw new Error(result.error);
    expect(result.data.invocation).toBeNull();
    expect(result.data.resultAvailable).toBe(false);
  });
});

describe("readMcpAppServerResource", () => {
  function readContext(result: unknown) {
    const reads: Array<{ serverName: string; uri: string }> = [];
    const ctx = {
      experimentsService: { isExperimentEnabled: () => true },
      mcpServerManager: {
        readMcpAppServerResource: (_workspaceId: string, serverName: string, uri: string) => {
          reads.push({ serverName, uri });
          return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
        },
      },
    } as unknown as Pick<ORPCContext, "experimentsService" | "mcpServerManager">;
    return { ctx, reads };
  }
  const input = { workspaceId: "ws", serverName: "charts", uri: "ui://charts/data" };

  test("returns the named server's result", async () => {
    const { ctx, reads } = readContext({ contents: [] });
    expect(await readMcpAppServerResource(ctx, input)).toEqual({
      success: true,
      data: { contents: [] },
    });
    expect(reads).toEqual([{ serverName: "charts", uri: "ui://charts/data" }]);
  });

  test("refuses oversized results and reports server errors", async () => {
    const big = { contents: [{ text: "x".repeat(MCP_APP_TOOL_RESULT_MAX_BYTES) }] };
    expect((await readMcpAppServerResource(readContext(big).ctx, input)).success).toBe(false);
    const failed = await readMcpAppServerResource(
      readContext(new Error("not connected")).ctx,
      input
    );
    expect(failed).toEqual({ success: false, error: "not connected" });
  });
});

describe("updateMcpAppModelContext", () => {
  function contextFor(record: McpAppResultRecord | null) {
    const writes: Array<{ serverName: string; text: string }> = [];
    const ctx = {
      experimentsService: { isExperimentEnabled: () => true },
      mcpServerManager: {
        getMcpAppResult: () => Promise.resolve(record),
        setMcpAppModelContext: (_ws: string, bound: McpAppResultRecord, text: string) => {
          writes.push({ serverName: bound.serverName, text });
          return Promise.resolve();
        },
      },
    } as unknown as Pick<ORPCContext, "experimentsService" | "mcpServerManager">;
    return { ctx, writes };
  }
  const input = (serverName = "charts") => ({
    workspaceId: "ws",
    toolCallId: "call-1",
    serverName,
    text: "ctx",
  });

  test("stores the context under the server of the view's result record", async () => {
    const { ctx, writes } = contextFor(RECORD);
    expect(await updateMcpAppModelContext(ctx, input())).toEqual({ success: true, data: {} });
    expect(writes).toEqual([{ serverName: "charts", text: "ctx" }]);
  });

  test("refuses a view without a record or naming another server", async () => {
    for (const [record, serverName] of [
      [null, "charts"],
      [RECORD, "other"],
    ] as const) {
      const { ctx, writes } = contextFor(record);
      expect((await updateMcpAppModelContext(ctx, input(serverName))).success).toBe(false);
      expect(writes).toEqual([]);
    }
  });
});

/** One tool call through getMcpAppViewRecords: its view, as a single-ID result. */
async function viewRecord(
  ctx: Parameters<typeof getMcpAppViewRecords>[0],
  input: { workspaceId: string; toolCallId: string }
) {
  const result = await getMcpAppViewRecords(ctx, {
    workspaceId: input.workspaceId,
    toolCallIds: [input.toolCallId],
  });
  return result.success ? { success: true as const, data: result.data[0].view } : result;
}

describe("getMcpAppViewRecords", () => {
  test("answers every requested tool call in one request, in order", async () => {
    const asked: string[] = [];
    const ctx = {
      experimentsService: { isExperimentEnabled: () => true },
      mcpServerManager: {
        getMcpAppResult: (_workspaceId: string, toolCallId: string) => {
          asked.push(toolCallId);
          return Promise.resolve(toolCallId === "call-1" ? RECORD : null);
        },
      },
    } as unknown as Pick<ORPCContext, "experimentsService" | "mcpServerManager">;
    const result = await getMcpAppViewRecords(ctx, {
      workspaceId: "ws",
      toolCallIds: ["gone", "call-1"],
    });
    if (!result.success) throw new Error(result.error);
    expect(result.data.map((entry) => [entry.toolCallId, entry.view?.resourceUri ?? null])).toEqual(
      [
        ["gone", null],
        ["call-1", "ui://charts/view"],
      ]
    );
    expect(asked.sort()).toEqual(["call-1", "gone"]);
  });

  test("answers a repeated ID once; the request schema refuses an empty or too long list", async () => {
    let reads = 0;
    const ctx = {
      experimentsService: { isExperimentEnabled: () => true },
      mcpServerManager: {
        getMcpAppResult: () => {
          reads++;
          return Promise.resolve(RECORD);
        },
      },
    } as unknown as Pick<ORPCContext, "experimentsService" | "mcpServerManager">;
    const result = await getMcpAppViewRecords(ctx, {
      workspaceId: "ws",
      toolCallIds: ["call-1", "call-1"],
    });
    if (!result.success) throw new Error(result.error);
    expect([result.data.map((entry) => entry.toolCallId), reads]).toEqual([["call-1"], 1]);

    const ids = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`);
    const parses = (toolCallIds: string[]) =>
      McpAppViewRecordsRequestSchema.safeParse({ workspaceId: "ws", toolCallIds }).success;
    expect([
      parses([]),
      parses(ids(MCP_APP_VIEW_RECORDS_MAX_IDS)),
      parses(ids(MCP_APP_VIEW_RECORDS_MAX_IDS + 1)),
    ]).toEqual([false, true, false]);
  });

  test("names the record's view with the card's server form and model-facing tool name", async () => {
    const { ctx, reads } = context({ ...RECORD, serverName: "my  charts" });
    const result = await viewRecord(ctx, { workspaceId: "ws", toolCallId: "call-1" });
    if (!result.success) throw new Error(result.error);
    expect(result.data).toEqual({
      serverName: "my charts",
      toolName: "my_charts_show_chart",
      resourceUri: "ui://charts/view",
      arguments: { title: "Q3" },
    });
    // A lookup never reads the view resource; getView does when the tab mounts it.
    expect(reads).toEqual([]);
  });

  test("finds only records of the asking workspace and returns no result content", async () => {
    using tmp = new DisposableTempDir("mcp-app-view-record");
    const store = new McpAppResultStore((id) => path.join(tmp.path, id));
    await store.record("ws-a", {
      toolCallId: "call-a",
      serverName: "charts",
      toolName: "show_chart",
      resourceUri: "ui://charts/view",
      arguments: { title: "Q3" },
      result: {
        content: [{ type: "text", text: "secret" }],
        structuredContent: { x: 1 },
        _meta: {},
      },
    });
    const ctx = {
      experimentsService: { isExperimentEnabled: () => true },
      mcpServerManager: {
        getMcpAppResult: (workspaceId: string, toolCallId: string) =>
          store.get(workspaceId, toolCallId),
      },
    } as unknown as Pick<ORPCContext, "experimentsService" | "mcpServerManager">;

    // Another workspace naming ws-a's tool call gets nothing.
    expect(await viewRecord(ctx, { workspaceId: "ws-b", toolCallId: "call-a" })).toEqual({
      success: true,
      data: null,
    });
    const own = await viewRecord(ctx, { workspaceId: "ws-a", toolCallId: "call-a" });
    if (!own.success || own.data === null) throw new Error("expected ws-a's record");
    // Only the view's binding: never the tool result (content, structuredContent, _meta).
    expect(Object.keys(own.data).sort()).toEqual([
      "arguments",
      "resourceUri",
      "serverName",
      "toolName",
    ]);
    expect(JSON.stringify(own.data)).not.toContain("secret");
  });

  test("refuses while the artifacts experiment is off", async () => {
    const { ctx } = context(RECORD);
    const off = {
      ...ctx,
      experimentsService: { isExperimentEnabled: () => false },
    } as unknown as typeof ctx;
    let refused = false;
    try {
      await viewRecord(off, { workspaceId: "ws", toolCallId: "call-1" });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  test("is null without a record", async () => {
    const { ctx } = context(null);
    const result = await viewRecord(ctx, { workspaceId: "ws", toolCallId: "call-1" });
    expect(result).toEqual({ success: true, data: null });
  });
});
