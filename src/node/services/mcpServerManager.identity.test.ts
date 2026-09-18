import { describe, expect, spyOn, test } from "bun:test";
import { convertToModelMessages, dynamicTool, jsonSchema, type Tool } from "ai";
import { MCP_ICON_LIMITS } from "@/common/constants/mcpIcon";
import type { MCPConnectionRef } from "@/common/types/mcp";
import { isPngDataUrl } from "@/common/utils/mcp/pngDataUrl";
import { Config } from "@/node/config";
import { PIXEL_PNG_ICON } from "../../../tests/fixtures/mcp/branded-icons";
import * as mcpSdk from "./mcpClient";
import { MCPConfigService } from "./mcpConfigService";
import { MCPIconRegistry, type MCPIconOwner } from "./mcpIconRegistry";
import * as serverIcon from "./mcpServerIcon";
import { MCPServerManager, wrapMCPTools } from "./mcpServerManager";
import type { IconCandidate } from "./mcpServerIdentity";
import { DisposableTempDir } from "./tempDir";
import { ToolCallDisplayRegistry } from "./toolCallDisplayRegistry";
import { withExecutionScope } from "./tools/withExecutionScope";

const displayKey = "io.modelcontextprotocol/serverInfo";
const identity = { name: "server-display-only", version: "1.0" };

describe("MCP display metadata boundary", () => {
  test("excludes only standard display metadata from new output and provider replay", async () => {
    const raw = {
      content: [{ type: "text", text: "The tool answer" }],
      _meta: { [displayKey]: identity, unrelated: { cursor: "page-2" } },
    };
    const tools = wrapMCPTools({
      search: dynamicTool({
        inputSchema: jsonSchema({ type: "object" }),
        execute: () => raw,
      }),
    });
    const output: unknown = await tools.search.execute!(
      {},
      { toolCallId: "call", messages: [], context: undefined }
    );
    expect(output).toEqual({
      content: raw.content,
      _meta: { unrelated: { cursor: "page-2" } },
    });
    // A display snapshot belongs on the part root, never inside output: the SDK
    // ignores host-only part fields, but replays every byte of a JSON output.
    const messages = [
      {
        id: "assistant",
        role: "assistant" as const,
        parts: [
          {
            type: "dynamic-tool" as const,
            toolName: "search",
            toolCallId: "call",
            state: "output-available" as const,
            input: {},
            output,
            mcpServer: { connection: { key: "configured", transport: "stdio" }, identity },
          },
        ],
      },
    ];
    const replay = JSON.stringify(await convertToModelMessages(messages));
    expect(replay).not.toContain(identity.name);
    expect(replay).toContain("The tool answer");
    expect(replay).toContain("page-2");
    expect(raw._meta[displayKey]).toEqual(identity);

    // No migration: conversion of pre-existing output retains its old payload.
    messages[0].parts[0].output = raw;
    expect(JSON.stringify(await convertToModelMessages(messages))).toContain(identity.name);
  });

  test.each([null, "not-an-object", { content: [] }, { _meta: ["invalid"] }])(
    "malformed or absent metadata does not fail the tool call: %j",
    async (raw) => {
      const tools = wrapMCPTools({
        search: dynamicTool({ inputSchema: jsonSchema({ type: "object" }), execute: () => raw }),
      });
      const result: unknown = await tools.search.execute!(
        {},
        { toolCallId: "call", messages: [], context: undefined }
      );
      expect(result).toBeDefined();
    }
  );
});

const failureConnection: MCPConnectionRef = { key: "configured", transport: "stdio" };
const failureScope = { workspaceId: "workspace", messageId: "message", token: "turn" };

/** One wrapped tool under an open scope; `identity` undefined models a server without a handshake identity. */
function failingHarness(options: {
  execute: Tool["execute"];
  identity?: typeof identity;
  onClosed?: () => void;
}) {
  const registry = new ToolCallDisplayRegistry();
  registry.open(failureScope);
  const tools = withExecutionScope(
    wrapMCPTools(
      {
        probe: dynamicTool({
          inputSchema: jsonSchema({ type: "object" }),
          execute: options.execute!,
        }),
      },
      {
        display: { connection: failureConnection, identity: options.identity, registry },
        onClosed: options.onClosed,
      }
    ),
    failureScope
  );
  return { registry, execute: tools.probe.execute! };
}

/** The rejection of `run`; fails the test when it settles successfully. */
async function rejectionOf(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

describe("MCP identity on failed tool calls", () => {
  test("a thrown execution keeps the handshake identity for the failed part and rethrows unchanged", async () => {
    const failure = new Error("upstream exploded");
    const h = failingHarness({ execute: () => Promise.reject(failure), identity });
    const caught = await rejectionOf(() =>
      h.execute({}, { toolCallId: "call", messages: [], context: undefined })
    );
    expect(caught).toBe(failure);
    expect(h.registry.take(failureScope, "call")).toEqual({
      connection: failureConnection,
      identity,
      source: "connection",
    });
  });

  test("an interrupted call publishes its snapshot before the client is recycled", async () => {
    const abort = new AbortController();
    let seenDuringRecycle: unknown = "not called";
    const h = failingHarness({
      // Never settles on its own; only the deadline/abort path can end it.
      execute: () => new Promise(() => undefined),
      identity,
      onClosed: () => {
        seenDuringRecycle = h.registry.take(failureScope, "call");
      },
    });
    const pending: unknown = h.execute(
      {},
      { toolCallId: "call", messages: [], context: undefined, abortSignal: abort.signal }
    );
    abort.abort();
    expect(await rejectionOf(() => pending)).toMatchObject({ message: "Interrupted" });
    // The recycle callback already saw the snapshot; nothing was published twice.
    expect(seenDuringRecycle).toEqual({
      connection: failureConnection,
      identity,
      source: "connection",
    });
    expect(h.registry.take(failureScope, "call")).toBeUndefined();
  });

  test("without a handshake identity or an open scope a failure publishes nothing", async () => {
    const unknownServer = failingHarness({ execute: () => Promise.reject(new Error("boom")) });
    expect(
      await rejectionOf(() =>
        unknownServer.execute({}, { toolCallId: "call", messages: [], context: undefined })
      )
    ).toMatchObject({ message: "boom" });
    expect(unknownServer.registry.take(failureScope, "call")).toBeUndefined();

    const closed = failingHarness({ execute: () => Promise.reject(new Error("boom")), identity });
    closed.registry.close(failureScope);
    expect(
      await rejectionOf(() =>
        closed.execute({}, { toolCallId: "call", messages: [], context: undefined })
      )
    ).toMatchObject({ message: "boom" });
    closed.registry.open(failureScope);
    expect(closed.registry.take(failureScope, "call")).toBeUndefined();
  });
});

const PNG = `data:image/png;base64,${Buffer.from("89504e470d0a1a0a", "hex").toString("base64")}`;
const connection: MCPConnectionRef = { key: "branded", transport: "stdio" };
const connectionIcon: IconCandidate = { src: "data:image/svg+xml;base64,PHN2Zy8+", sizes: ["any"] };
const responseIcon: IconCandidate = { src: "data:image/png;base64,iVBORw0KGgo=" };
const scope = { workspaceId: "workspace", messageId: "message", token: "turn" };

interface Harness {
  registry: ToolCallDisplayRegistry;
  icons: MCPIconRegistry;
  resolved: Array<{ candidates: readonly IconCandidate[]; binding: MCPConnectionRef }>;
  /** Wrap a tool as one connected generation would: same owner for its lifetime. */
  wrap: (owner: MCPIconOwner, tool: Tool, callId: string) => Promise<void>;
  take: (callId: string) => ReturnType<ToolCallDisplayRegistry["take"]>;
}

function harness(resolve?: () => Promise<string | null>): Harness {
  const registry = new ToolCallDisplayRegistry();
  registry.open(scope);
  const resolved: Harness["resolved"] = [];
  const icons = new MCPIconRegistry((candidates, binding) => {
    resolved.push({ candidates, binding });
    return resolve ? resolve() : Promise.resolve(PNG);
  });
  return {
    registry,
    icons,
    resolved,
    wrap: async (owner, tool, callId) => {
      const tools = withExecutionScope(
        wrapMCPTools(
          { probe: tool },
          {
            display: {
              connection,
              identity,
              iconCandidates: [connectionIcon],
              registry,
              icons: { registry: icons, owner },
            },
          }
        ),
        scope
      );
      const output: unknown = await tools.probe.execute!(
        {},
        { toolCallId: callId, messages: [], context: undefined }
      );
      // Neither the display key nor any artwork may leak into model-visible output.
      expect(JSON.stringify(output)).not.toContain(displayKey);
      expect(JSON.stringify(output)).not.toContain("data:image");
    },
    take: (callId) => registry.take(scope, callId),
  };
}

const plainTool = dynamicTool({
  inputSchema: jsonSchema({ type: "object" }),
  execute: () => ({ content: [{ type: "text", text: "answer" }] }),
});
function brandedTool(icons?: IconCandidate[]): Tool {
  return dynamicTool({
    inputSchema: jsonSchema({ type: "object" }),
    execute: () => ({
      content: [{ type: "text", text: "answer" }],
      _meta: { [displayKey]: { name: "Response", version: "2", ...(icons ? { icons } : {}) } },
    }),
  });
}

describe("MCP icon references on tool-call snapshots", () => {
  test("a connection-identity fallback registers the handshake icon once per generation", async () => {
    const h = harness();
    const owner: MCPIconOwner = {};
    await h.wrap(owner, plainTool, "first");
    await h.wrap(owner, plainTool, "second");
    const first = h.take("first");
    const second = h.take("second");
    expect(first).toMatchObject({ source: "connection", identity });
    expect(first?.iconRef).toMatch(/^[a-f0-9]{32}$/);
    // Same owner + same candidates = same immutable ref; no second resolution.
    expect(second?.iconRef).toBe(first!.iconRef);
    expect(h.resolved).toHaveLength(1);
    expect(h.resolved[0].candidates).toEqual([connectionIcon]);
    expect(h.resolved[0].binding).toEqual(connection);
    // Snapshots persist into history: a ref, never the candidate URL or bytes.
    expect(JSON.stringify(first)).not.toContain("data:");
    expect(isPngDataUrl(await h.icons.get(first!.iconRef!))).toBe(true);
  });

  test("a response identity owns its artwork: none inherits nothing, its own replaces", async () => {
    const h = harness();
    const owner: MCPIconOwner = {};
    await h.wrap(owner, brandedTool(), "unbranded");
    await h.wrap(owner, brandedTool([responseIcon]), "branded");
    const unbranded = h.take("unbranded");
    expect(unbranded).toMatchObject({ source: "response", identity: { name: "Response" } });
    expect(unbranded?.iconRef).toBeUndefined();
    const branded = h.take("branded");
    expect(branded?.iconRef).toMatch(/^[a-f0-9]{32}$/);
    // Only the response candidates were resolved; the connection icon never was.
    expect(h.resolved.map((r) => r.candidates)).toEqual([[responseIcon]]);
  });

  test("a reconnected generation mints a new ref while the old one keeps resolving", async () => {
    const h = harness();
    await h.wrap({}, plainTool, "before");
    await h.wrap({}, plainTool, "after");
    const before = h.take("before")!.iconRef!;
    const after = h.take("after")!.iconRef!;
    expect(after).not.toBe(before);
    expect(await h.icons.get(before)).toBe(PNG);
    expect(await h.icons.get(after)).toBe(PNG);
    expect(await h.icons.get("0".repeat(32))).toBeNull();
  });

  test("the tool call never waits for icon resolution", async () => {
    const h = harness(() => new Promise<string | null>(() => undefined));
    await h.wrap({}, plainTool, "pending");
    expect(h.take("pending")?.iconRef).toMatch(/^[a-f0-9]{32}$/);
    expect(h.resolved).toHaveLength(1);
  });

  test("without an icon registry snapshots carry no ref", async () => {
    const registry = new ToolCallDisplayRegistry();
    registry.open(scope);
    const tools = withExecutionScope(
      wrapMCPTools(
        { probe: plainTool },
        { display: { connection, identity, iconCandidates: [connectionIcon], registry } }
      ),
      scope
    );
    await tools.probe.execute!({}, { toolCallId: "call", messages: [], context: undefined });
    const snapshot = registry.take(scope, "call");
    expect(snapshot).toMatchObject({ source: "connection" });
    expect(snapshot?.iconRef).toBeUndefined();
  });
});

describe("connection tests and the historical icon registry", () => {
  test("connection tests resolve through the process resolver and never admit registry entries", async () => {
    using tmp = new DisposableTempDir("mcp-icon-test-isolation");
    const manager = new MCPServerManager(new MCPConfigService(new Config(tmp.path)));
    // Seed one immutable ref the way a served tool call does (real resolution).
    const registry = Reflect.get(manager, "iconRegistry") as MCPIconRegistry;
    const historicalOwner: MCPIconOwner = {};
    const historicalBinding: MCPConnectionRef = { key: "history", transport: "stdio" };
    const historicalRef = registry.ensure(historicalOwner, [PIXEL_PNG_ICON], historicalBinding)!;
    const historicalIcon = await manager.getIcon(historicalRef);
    expect(isPngDataUrl(historicalIcon)).toBe(true);

    const testIcon = PNG;
    const resolveSpy = spyOn(serverIcon, "resolveServerIcon").mockImplementation(() =>
      Promise.resolve(testIcon)
    );
    const clientSpy = spyOn(mcpSdk, "createMCPClient").mockImplementation(() =>
      Promise.resolve({
        tools: () => Promise.resolve({}),
        negotiatedProtocolVersion: () => "2026-07-28",
        serverInfo: () => ({ name: "Mock", version: "1", icons: [responseIcon] }),
        close: () => Promise.resolve(),
      } as unknown as Awaited<ReturnType<typeof mcpSdk.createMCPClient>>)
    );
    try {
      // More successful tests than the registry holds entries: had they been
      // admitted, the LRU would have evicted the historical ref by now.
      const runs = MCP_ICON_LIMITS.registryMaxEntries + 1;
      for (let i = 0; i < runs; i++) {
        const result = await manager.test({
          projectPath: tmp.path,
          url: `https://mock.example/${i}`,
          transport: "http",
          trusted: true,
        });
        expect(result.success).toBe(true);
        if (!result.success) throw new Error(result.error);
        expect(result.icon).toBe(testIcon);
      }
      expect(resolveSpy).toHaveBeenCalledTimes(runs);
      expect(clientSpy).toHaveBeenCalledTimes(runs);
      // Historical artwork is untouched: same bytes, and the owner still
      // deduplicates onto the same ref, so nothing was evicted or refetched.
      expect(await manager.getIcon(historicalRef)).toBe(historicalIcon);
      expect(registry.ensure(historicalOwner, [PIXEL_PNG_ICON], historicalBinding)).toBe(
        historicalRef
      );
    } finally {
      resolveSpy.mockRestore();
      clientSpy.mockRestore();
      manager.dispose();
    }
  }, 30_000);
});
