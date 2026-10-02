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

function context(record: McpAppResultRecord | null) {
  const reads: Array<{ serverName: string; uri: string }> = [];
  const ctx = {
    experimentsService: { isExperimentEnabled: () => true },
    mcpServerManager: {
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

describe("getMcpAppView", () => {
  test("refuses a request that names another server or view than the result record", async () => {
    for (const overrides of [{ serverName: "other" }, { resourceUri: "ui://charts/other" }]) {
      const { ctx, reads } = context(RECORD);
      const result = await getMcpAppView(ctx, request(overrides));
      expect(result.success).toBe(false);
      // Nothing is read from either server.
      expect(reads).toEqual([]);
    }
  });

  test("binds the view to the record's tool call", async () => {
    const { ctx, reads } = context(RECORD);
    const result = await getMcpAppView(ctx, request());
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
    const result = await getMcpAppView(ctx, request({ serverName: "my charts" }));
    if (!result.success) throw new Error(result.error);
    expect(reads).toEqual([{ serverName: rawKey, uri: "ui://charts/view" }]);
    expect(result.data.invocation?.serverName).toBe(rawKey);
  });

  test("without a record the view opens from the request, unbound", async () => {
    const { ctx, reads } = context(null);
    const result = await getMcpAppView(ctx, request());
    expect(reads).toEqual([{ serverName: "charts", uri: "ui://charts/view" }]);
    if (!result.success) throw new Error(result.error);
    expect(result.data.invocation).toBeNull();
    expect(result.data.resultAvailable).toBe(false);
  });
});
