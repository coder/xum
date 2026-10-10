import { z } from "zod";
import type { McpAppToolCallResult } from "@/common/orpc/schemas/mcpApps";
import { createBridgeRateLimiter } from "./artifactBridge";
import type { GrantedMcpAppCsp } from "./mcpAppCsp";

/**
 * Host side of the MCP Apps (SEP-1865, 2026-01-26) JSON-RPC protocol for a view in the
 * Artifacts tab. Kept separate from the artifact bridge (window.xum); both share only the
 * frame gate (source window + rate limit) in artifactBridge.ts.
 *
 * Implemented view -> host methods: ui/initialize, ui/notifications/initialized, ping,
 * ui/notifications/size-changed, notifications/message, tools/call (own server only, visibility
 * and consent rules enforced by the backend), ui/open-link (https, after a confirm),
 * ui/message (inserted into the composer after a confirm, never sent). Every other request
 * gets -32601.
 */

export const MCP_APP_PROTOCOL_VERSION = "2026-01-26";
const METHOD_NOT_FOUND = -32601;
const INVALID_REQUEST = -32600;
const INVALID_PARAMS = -32602;
const REQUEST_FAILED = -32000;

/** View-initiated tools/call budget, on top of the frame's message rate limit. */
const TOOL_CALLS_PER_WINDOW = 5;
const TOOL_CALL_WINDOW_MS = 10_000;
/**
 * Largest serialized arguments (UTF-8 bytes) of a call the user is asked to allow. The strip
 * shows the arguments in full; anything bigger cannot be reviewed, so it is declined without
 * asking rather than shown truncated (a padded prefix could hide what the call really sends).
 */
export const MCP_APP_CONSENT_ARGS_MAX_BYTES = 64 * 1024;
/** How long teardown waits for the view's reply before the host removes it. */
export const MCP_APP_TEARDOWN_TIMEOUT_MS = 500;
/** Clamp for reported view heights (px). */
export const MCP_APP_MIN_HEIGHT = 80;
export const MCP_APP_MAX_HEIGHT = 4000;

const IdSchema = z.union([z.string().max(128), z.number()]);
const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: IdSchema,
  method: z.string().max(128),
  params: z.unknown().optional(),
});
const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().max(128),
  params: z.unknown().optional(),
});
const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: IdSchema,
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

const SizeChangedParams = z.object({
  width: z.number().finite().optional(),
  height: z.number().finite().optional(),
});
const LogParams = z.object({ level: z.string().max(32).optional(), data: z.unknown().optional() });
const ToolCallParams = z.object({
  name: z.string().min(1).max(256),
  arguments: z.record(z.string(), z.unknown()).optional(),
});
const OpenLinkParams = z.object({ url: z.string().max(4096) });
const MessageParams = z.object({
  role: z.literal("user"),
  content: z.object({ type: z.literal("text"), text: z.string().max(32_000) }),
});

export type McpAppConsentRequest =
  /** `args` are exactly what the backend receives once allowed, shown in the strip. */
  | { kind: "tool"; toolName: string; serverName: string; args: Record<string, unknown> }
  /** `host` is the parsed host the link opens, shown in the strip ahead of the full URL. */
  | { kind: "link"; url: string; host: string }
  /** `text` is exactly what is added to the composer once accepted, shown in the strip. */
  | { kind: "message"; text: string };

export interface McpAppHostContext {
  theme: "dark" | "light";
  styles: { variables: Record<string, string> };
  displayMode: "inline";
  availableDisplayModes: ["inline"];
  containerDimensions: { width: number; maxHeight: number };
  locale: string;
  timeZone: string;
  platform: "desktop" | "web" | "mobile";
  /** Omitted for a view no tool call opened (plugin views); the spec makes it optional. */
  toolInfo?: { id: string; tool: { name: string; title?: string } };
}

export interface McpAppHostOptions {
  serverName: string;
  grantedCsp: GrantedMcpAppCsp;
  postToView: (message: unknown) => void;
  getHostContext: () => McpAppHostContext;
  /** Backend tools/call; `consented` is true only after the user allowed this call. */
  callTool: (
    toolName: string,
    args: Record<string, unknown>,
    consented: boolean
  ) => Promise<McpAppToolCallResult>;
  requestConsent: (request: McpAppConsentRequest) => Promise<boolean>;
  insertIntoComposer: (text: string) => void;
  openExternalLink: (url: string) => void;
  onSizeChanged: (size: { width?: number; height?: number }) => void;
  onInitialized: () => void;
  log: (message: string, data?: unknown) => void;
}

export function clampMcpAppHeight(height: number): number {
  return Math.min(MCP_APP_MAX_HEIGHT, Math.max(MCP_APP_MIN_HEIGHT, Math.round(height)));
}

export function createMcpAppHost(options: McpAppHostOptions) {
  const allowToolCall = createBridgeRateLimiter(TOOL_CALLS_PER_WINDOW, TOOL_CALL_WINDOW_MS);
  const pendingHostRequests = new Map<string, (ok: boolean) => void>();
  let nextHostRequestId = 1;
  let initialized = false;

  const respond = (id: string | number, result: unknown) =>
    options.postToView({ jsonrpc: "2.0", id, result });
  const fail = (id: string | number, code: number, message: string) =>
    options.postToView({ jsonrpc: "2.0", id, error: { code, message } });
  const notify = (method: string, params: unknown) =>
    options.postToView({ jsonrpc: "2.0", method, params });

  async function handleRequest(id: string | number, method: string, params: unknown) {
    switch (method) {
      case "ui/initialize":
        respond(id, {
          protocolVersion: MCP_APP_PROTOCOL_VERSION,
          hostInfo: { name: "xum", version: "1.0.0" },
          // Advertise only what is implemented.
          hostCapabilities: {
            serverTools: {},
            logging: {},
            openLinks: {},
            sandbox: { csp: options.grantedCsp },
          },
          hostContext: options.getHostContext(),
        });
        return;
      case "ping":
        respond(id, {});
        return;
      case "tools/call": {
        const parsed = ToolCallParams.safeParse(params);
        if (!parsed.success) return fail(id, INVALID_PARAMS, "Invalid tools/call params");
        if (!allowToolCall())
          return fail(id, REQUEST_FAILED, "Too many tool calls; try again shortly");
        const { name } = parsed.data;
        const args = parsed.data.arguments ?? {};
        options.log("tools/call", { name });
        try {
          let outcome = await options.callTool(name, args, false);
          if (outcome.status === "consent_required") {
            const argsBytes = new TextEncoder().encode(JSON.stringify(args)).length;
            if (argsBytes > MCP_APP_CONSENT_ARGS_MAX_BYTES) {
              return fail(id, REQUEST_FAILED, "The tool arguments are too large to review");
            }
            const allowed = await options.requestConsent({
              kind: "tool",
              toolName: name,
              serverName: options.serverName,
              args,
            });
            if (!allowed) return fail(id, REQUEST_FAILED, "The user denied the tool call");
            outcome = await options.callTool(name, args, true);
          }
          if (outcome.status === "ok") return respond(id, outcome.result);
          return fail(
            id,
            REQUEST_FAILED,
            outcome.status === "rejected" ? outcome.reason : "Tool call not allowed"
          );
        } catch (error) {
          return fail(id, REQUEST_FAILED, error instanceof Error ? error.message : String(error));
        }
      }
      case "ui/open-link": {
        const parsed = OpenLinkParams.safeParse(params);
        let url: URL | null = null;
        try {
          url = parsed.success ? new URL(parsed.data.url) : null;
        } catch {
          url = null;
        }
        if (url?.protocol !== "https:") {
          return fail(id, INVALID_PARAMS, "Only https links can be opened");
        }
        // Credentials disguise the real host (https://trusted.example@evil.example/ opens
        // evil.example), and this strip is the only gate before the OS opens the link.
        if (url.username !== "" || url.password !== "") {
          return fail(id, INVALID_PARAMS, "Links with credentials cannot be opened");
        }
        const href = url.toString();
        if (!(await options.requestConsent({ kind: "link", url: href, host: url.host }))) {
          return fail(id, REQUEST_FAILED, "The user declined to open the link");
        }
        options.openExternalLink(href);
        respond(id, {});
        return;
      }
      case "ui/message": {
        const parsed = MessageParams.safeParse(params);
        if (!parsed.success)
          return fail(id, INVALID_PARAMS, "Only user text messages are supported");
        const { text } = parsed.data.content;
        // Never inserted unasked (the user may be typing) and never sent: the user confirms the
        // insert in the host strip, then reviews and sends it from the composer.
        if (!(await options.requestConsent({ kind: "message", text }))) {
          return fail(id, REQUEST_FAILED, "The user dismissed the message");
        }
        options.insertIntoComposer(text);
        respond(id, {});
        return;
      }
      default:
        fail(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  function handleNotification(method: string, params: unknown) {
    switch (method) {
      case "ui/notifications/initialized":
        if (initialized) return;
        initialized = true;
        options.onInitialized();
        return;
      case "ui/notifications/size-changed": {
        const parsed = SizeChangedParams.safeParse(params);
        if (!parsed.success) return;
        options.onSizeChanged({
          ...(parsed.data.width !== undefined ? { width: Math.max(0, parsed.data.width) } : {}),
          ...(parsed.data.height !== undefined
            ? { height: clampMcpAppHeight(parsed.data.height) }
            : {}),
        });
        return;
      }
      case "notifications/message": {
        const parsed = LogParams.safeParse(params);
        if (parsed.success)
          options.log(`view log (${parsed.data.level ?? "info"})`, parsed.data.data);
        return;
      }
      default:
        // Unknown notifications have no reply channel; drop them.
        return;
    }
  }

  return {
    /** Handle one message that already passed the frame gate (source + rate limit). */
    handleMessage(data: unknown): Promise<void> {
      const request = JsonRpcRequestSchema.safeParse(data);
      if (request.success) {
        return handleRequest(request.data.id, request.data.method, request.data.params);
      }
      const response = JsonRpcResponseSchema.safeParse(data);
      if (response.success && typeof response.data.id === "string") {
        const settle = pendingHostRequests.get(response.data.id);
        if (settle) {
          pendingHostRequests.delete(response.data.id);
          settle(response.data.error === undefined);
        }
        return Promise.resolve();
      }
      const notification = JsonRpcNotificationSchema.safeParse(data);
      if (notification.success) {
        handleNotification(notification.data.method, notification.data.params);
        return Promise.resolve();
      }
      // Malformed: answer only when there is an id to answer.
      const id = IdSchema.safeParse((data as { id?: unknown } | null)?.id);
      if (id.success) fail(id.data, INVALID_REQUEST, "Invalid JSON-RPC message");
      options.log("rejected malformed message");
      return Promise.resolve();
    },
    sendToolInput(args: unknown) {
      notify("ui/notifications/tool-input", { arguments: args ?? {} });
    },
    sendToolResult(result: unknown) {
      notify("ui/notifications/tool-result", result);
    },
    sendToolCancelled(reason: string) {
      notify("ui/notifications/tool-cancelled", { reason });
    },
    sendHostContextChanged(context: Partial<McpAppHostContext>) {
      // Context changes only make sense once the view has its initial context.
      if (!initialized) return;
      notify("ui/notifications/host-context-changed", context);
    },
    /** ui/resource-teardown; resolves when the view replies or after the bounded wait. */
    teardown(reason: string): Promise<void> {
      const id = `host-${nextHostRequestId++}`;
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          pendingHostRequests.delete(id);
          resolve();
        }, MCP_APP_TEARDOWN_TIMEOUT_MS);
        pendingHostRequests.set(id, () => {
          clearTimeout(timer);
          resolve();
        });
        options.postToView({
          jsonrpc: "2.0",
          id,
          method: "ui/resource-teardown",
          params: { reason },
        });
      });
    },
  };
}

export type McpAppHost = ReturnType<typeof createMcpAppHost>;
