import { describe, expect, test } from "bun:test";
import { McpAppApproveDomainsRequestSchema } from "@/common/orpc/schemas/mcpApps";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import type { MCPServerInfo } from "@/common/types/mcp";
import * as path from "node:path";
import { McpAppViewRecordsRequestSchema } from "@/common/orpc/schemas/mcpApps";
import { MCP_APP_VIEW_RECORDS_MAX_IDS } from "@/common/utils/mcpApps";
import { McpAppResultStore, type McpAppResultRecord } from "./mcpAppResultStore";
import { DisposableTempDir } from "./tempDir";
import {
  getMcpAppView,
  getMcpAppViewRecords,
  MCP_APP_TOOL_RESULT_MAX_BYTES,
  approveMcpAppViewDomains,
  listMcpAppViewDomains,
  type McpAppsContext,
  readMcpAppServerResource,
  revokeMcpAppViewDomains,
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

const NO_PROJECTS = {
  findWorkspace: () => null,
  loadConfigOrDefault: () => ({ projects: new Map() }),
};

function context(record: McpAppResultRecord | null, warm = true) {
  const reads: Array<{ serverName: string; uri: string }> = [];
  const ctx = {
    experimentsService: { isExperimentEnabled: () => true },
    config: NO_PROJECTS,
    mcpServerManager: {
      hasWorkspaceRequestOptions: () => warm,
      getMcpAppResult: () => Promise.resolve(record),
      readMcpAppResource: (_workspaceId: string, serverName: string, uri: string) => {
        reads.push({ serverName, uri });
        return Promise.resolve({ html: "<p>view</p>", csp: {}, prefersBorder: null });
      },
    },
  } as unknown as McpAppsContext;
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
    } as unknown as McpAppsContext;
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
    } as unknown as McpAppsContext;
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

describe("MCP Apps view domain approvals", () => {
  function projectConfig(
    options: {
      record?: McpAppResultRecord;
      // A multi-project workspace (stored under _multi, first project /a) and its servers.
      multi?: Record<string, Partial<MCPServerInfo>>;
      // A scratch chat: stored under the shared _scratch bucket.
      scratch?: boolean;
    } = {}
  ) {
    const record = options.record ?? RECORD;
    const projects = new Map<string, { mcpAppViewDomains?: Record<string, string[]> }>([
      ["/repo", {}],
      ["/a", {}],
      [MULTI_PROJECT_CONFIG_KEY, {}],
      [SCRATCH_PROJECT_CONFIG_KEY, {}],
    ]);
    const config = {
      findWorkspace: (id: string) =>
        id !== "ws"
          ? null
          : options.multi
            ? { projectPath: MULTI_PROJECT_CONFIG_KEY, attributionProjectPath: "/a" }
            : options.scratch
              ? {
                  projectPath: SCRATCH_PROJECT_CONFIG_KEY,
                  attributionProjectPath: SCRATCH_PROJECT_CONFIG_KEY,
                }
              : { projectPath: "/repo", attributionProjectPath: "/repo" },
      loadConfigOrDefault: () => ({ projects }),
      editConfig: (fn: (c: { projects: typeof projects }) => unknown) => {
        fn({ projects });
        return Promise.resolve();
      },
    };
    const ctx = {
      experimentsService: { isExperimentEnabled: () => true },
      config,
      mcpServerManager: {
        getMcpAppResult: (_ws: string, id: string) =>
          Promise.resolve(id === "call-1" ? record : null),
        hasWorkspaceRequestOptions: () => true,
        readMcpAppResource: () => Promise.resolve({ html: "<p/>", csp: {}, prefersBorder: null }),
      },
      mcpConfigService: {
        listForApi: (input: { projectPath?: string }) =>
          Promise.resolve(input.projectPath === "/a" ? (options.multi ?? {}) : {}),
      },
    } as unknown as McpAppsContext;
    return { ctx, projects };
  }
  const approve = (
    origins: string[],
    overrides: Partial<{ toolCallId: string; serverName: string }> = {}
  ) => ({
    workspaceId: "ws",
    toolCallId: "call-1",
    serverName: "charts",
    origins,
    ...overrides,
  });

  test("an approval is stored per server in the project, read back by every view, and revoked", async () => {
    const { ctx, projects } = projectConfig();
    expect(await approveMcpAppViewDomains(ctx, approve(["https://api.example.com/"]))).toEqual({
      success: true,
      data: { approvedDomains: ["https://api.example.com"] },
    });
    // A grown list adds only the new origin.
    await approveMcpAppViewDomains(
      ctx,
      approve(["https://api.example.com", "https://cdn.example.com"])
    );
    expect(projects.get("/repo")?.mcpAppViewDomains).toEqual({
      charts: ["https://api.example.com", "https://cdn.example.com"],
    });
    const view = await getMcpAppView(ctx, request(), undefined, noWarm);
    if (!view.success) throw new Error(view.error);
    expect(view.data.approvedDomains).toEqual([
      "https://api.example.com",
      "https://cdn.example.com",
    ]);
    expect(listMcpAppViewDomains(ctx)).toEqual([
      {
        projectPath: "/repo",
        serverName: "charts",
        origins: ["https://api.example.com", "https://cdn.example.com"],
      },
    ]);
    await revokeMcpAppViewDomains(ctx, { projectPath: "/repo", serverName: "charts" });
    expect(listMcpAppViewDomains(ctx)).toEqual([]);
    const after = await getMcpAppView(ctx, request(), undefined, noWarm);
    expect(after.success && after.data.approvedDomains).toEqual([]);
  });

  test("refuses non-https origins, views without a record, and another server", async () => {
    const { ctx, projects } = projectConfig();
    for (const input of [
      approve(["http://api.example.com"]),
      approve(["https://*.example.com"]),
      approve(["https://api.example.com"], { toolCallId: "no-record" }),
      approve(["https://api.example.com"], { serverName: "other" }),
    ]) {
      expect((await approveMcpAppViewDomains(ctx, input)).success).toBe(false);
    }
    expect(projects.get("/repo")?.mcpAppViewDomains).toBeUndefined();
  });

  test("a multi-project workspace keeps approvals on its server's project, never in _multi", async () => {
    // The project's own server: its approval lands on that project.
    const own = projectConfig({ multi: { charts: { configLayer: "project" } } });
    expect(
      (await approveMcpAppViewDomains(own.ctx, approve(["https://api.example.com"]))).success
    ).toBe(true);
    expect(own.projects.get("/a")?.mcpAppViewDomains).toEqual({
      charts: ["https://api.example.com"],
    });
    expect(own.projects.get(MULTI_PROJECT_CONFIG_KEY)?.mcpAppViewDomains).toBeUndefined();
    const view = await getMcpAppView(own.ctx, request(), undefined, noWarm);
    expect(view.success && view.data.approvalProjectPath).toBe("/a");
    expect(view.success && view.data.approvedDomains).toEqual(["https://api.example.com"]);

    // A global server has no single owner project there: refused, nothing stored anywhere.
    const global = projectConfig({ multi: { charts: { configLayer: "global" } } });
    expect(
      (await approveMcpAppViewDomains(global.ctx, approve(["https://api.example.com"]))).success
    ).toBe(false);
    for (const project of global.projects.values())
      expect(project.mcpAppViewDomains).toBeUndefined();
    const globalView = await getMcpAppView(global.ctx, request(), undefined, noWarm);
    expect(globalView.success && globalView.data.approvalProjectPath).toBeNull();
  });

  test("a scratch chat refuses approvals: the shared _scratch bucket is no user project", async () => {
    const { ctx, projects } = projectConfig({ scratch: true });
    projects.set(SCRATCH_PROJECT_CONFIG_KEY, {
      mcpAppViewDomains: { charts: ["https://old.example.com"] },
    });
    expect(
      (await approveMcpAppViewDomains(ctx, approve(["https://api.example.com"]))).success
    ).toBe(false);
    expect(projects.get(SCRATCH_PROJECT_CONFIG_KEY)?.mcpAppViewDomains).toEqual({
      charts: ["https://old.example.com"],
    });
    // Nothing stored there applies to a scratch view either.
    const view = await getMcpAppView(ctx, request(), undefined, noWarm);
    expect(view.success && view.data.approvalProjectPath).toBeNull();
    expect(view.success && view.data.approvedDomains).toEqual([]);
  });

  test("a server named like an Object.prototype member reads no inherited approvals", async () => {
    const { ctx, projects } = projectConfig({ record: { ...RECORD, serverName: "constructor" } });
    projects.set("/repo", { mcpAppViewDomains: {} });
    const named = request({ serverName: "constructor" });
    const view = await getMcpAppView(ctx, named, undefined, noWarm);
    expect(view.success && view.data.approvedDomains).toEqual([]);
    const result = await approveMcpAppViewDomains(
      ctx,
      approve(["https://api.example.com"], { serverName: "constructor" })
    );
    expect(result).toEqual({
      success: true,
      data: { approvedDomains: ["https://api.example.com"] },
    });
  });

  test("an approval that would exceed the cap fails and keeps the stored list", async () => {
    const { ctx, projects } = projectConfig();
    const full = Array.from({ length: 64 }, (_, i) => `https://h${i}.example.com`);
    projects.set("/repo", { mcpAppViewDomains: { charts: full } });
    // Already approved origins still succeed; a new one does not fit.
    expect((await approveMcpAppViewDomains(ctx, approve([full[0]]))).success).toBe(true);
    expect(
      (await approveMcpAppViewDomains(ctx, approve(["https://new.example.com"]))).success
    ).toBe(false);
    expect(projects.get("/repo")?.mcpAppViewDomains?.charts).toEqual(full);
  });

  test("one request carries a view's whole pending batch (resource and connect lists)", () => {
    const origins = (n: number) => Array.from({ length: n }, (_, i) => `https://h${i}.example.com`);
    expect(McpAppApproveDomainsRequestSchema.safeParse(approve(origins(64))).success).toBe(true);
    expect(McpAppApproveDomainsRequestSchema.safeParse(approve(origins(65))).success).toBe(false);
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
    } as unknown as McpAppsContext;
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
    } as unknown as McpAppsContext;
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
    } as unknown as McpAppsContext;

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
