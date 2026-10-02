import { describe, expect, test } from "bun:test";
import type { ORPCContext } from "@/node/orpc/context";
import type { McpAppResultRecord } from "./mcpAppResultStore";
import { getMcpAppView } from "./mcpAppsOperations";

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
