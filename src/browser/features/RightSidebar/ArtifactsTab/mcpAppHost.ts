import { z } from "zod";
import {
  MCP_APP_MODEL_CONTEXT_MAX_BYTES,
  MCP_APP_READ_URI_MAX_CHARS,
} from "@/common/utils/mcpApps";
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
 * and consent rules enforced by the backend), resources/read (own server only), ui/open-link
 * (https, after a confirm), ui/message (inserted into the composer after a confirm, never sent),
 * ui/update-model-context (stored per view for the workspace's next requests) and
 * ui/request-display-mode (inline / fullscreen). Every other request gets -32601.
 */

export const MCP_APP_PROTOCOL_VERSION = "2026-01-26";
const METHOD_NOT_FOUND = -32601;
const INVALID_REQUEST = -32600;
const INVALID_PARAMS = -32602;
const REQUEST_FAILED = -32000;

/**
 * View-initiated tools/call + resources/read budget (shared: both reach the server), on top of
 * the frame's message rate limit.
 */
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
const ReadResourceParams = z.object({ uri: z.string().min(1).max(MCP_APP_READ_URI_MAX_CHARS) });
const OpenLinkParams = z.object({ url: z.string().max(4096) });
const MESSAGE_TEXT_MAX_CHARS = 32_000;
const TextBlock = z.object({
  type: z.literal("text"),
  text: z.string().max(MESSAGE_TEXT_MAX_CHARS),
});
/**
 * The spec's single text block, or the content-block array of the ext-apps SDK and ChatGPT
 * (`content: [{ type: "text", text }]`, optional `_meta["openai/message"]`). Non-text blocks
 * are checked after parsing so they get a precise error. `_meta` is accepted and ignored: Xum
 * never sends the message, whatever `_meta["openai/message"]` asks for.
 */
const MessageParams = z.object({
  role: z.literal("user"),
  content: z.union([TextBlock, z.array(z.unknown()).min(1).max(64)]),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

/** The message text, or null when a block is not text or the text is too long. */
function messageText(content: z.infer<typeof MessageParams>["content"]): string | null {
  return joinTextBlocks(Array.isArray(content) ? content : [content], MESSAGE_TEXT_MAX_CHARS);
}

/**
 * Text blocks joined by newlines, or null when any block is not text or the joined text would
 * be longer than `maxChars` (UTF-16 code units).
 */
function joinTextBlocks(blocks: readonly unknown[], maxChars: number): string | null {
  const texts: string[] = [];
  // Enforce the limit while iterating, counting the "\n" join() adds: a view can send 64
  // blocks, so joining first would build an arbitrarily large string before rejecting it.
  let length = 0;
  for (const block of blocks) {
    const parsed = TextBlock.safeParse(block);
    if (!parsed.success) return null;
    length += parsed.data.text.length + (texts.length > 0 ? 1 : 0);
    if (length > maxChars) return null;
    texts.push(parsed.data.text);
  }
  return texts.join("\n");
}

const ModelContextParams = z.object({
  content: z.array(z.unknown()).max(64).optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The text stored for a ui/update-model-context: its text blocks, then its structuredContent as
 * JSON. Empty when the update has neither (it clears the view's context). Null when a block is
 * not text or the text exceeds the cap.
 */
function modelContextText(params: z.infer<typeof ModelContextParams>): string | null {
  // A UTF-16 code unit is at least one UTF-8 byte, so the byte cap also bounds the code units.
  const text = joinTextBlocks(params.content ?? [], MCP_APP_MODEL_CONTEXT_MAX_BYTES);
  if (text === null) return null;
  let structured = "";
  if (params.structuredContent !== undefined) {
    try {
      structured = JSON.stringify(params.structuredContent);
    } catch {
      // postMessage's structured clone carries cyclic objects and BigInt; JSON cannot.
      return null;
    }
  }
  const combined = [text, structured].filter((part) => part !== "").join("\n\n");
  return new TextEncoder().encode(combined).length <= MCP_APP_MODEL_CONTEXT_MAX_BYTES
    ? combined
    : null;
}

export type McpAppDisplayMode = "inline" | "fullscreen" | "pip";
const DisplayModeParams = z.object({ mode: z.string().max(32) });
const InitializeParams = z.object({
  appCapabilities: z
    .object({ availableDisplayModes: z.array(z.string().max(32)).max(8).optional() })
    .optional(),
});

export type McpAppConsentRequest =
  /** `args` are exactly what the backend receives once allowed, shown in the strip. */
  | { kind: "tool"; toolName: string; serverName: string; args: Record<string, unknown> }
  /** `host` is the parsed host the link opens, shown in the strip ahead of the full URL. */
  | { kind: "link"; url: string; host: string }
  /** `text` is exactly what is added to the composer once accepted, shown in the strip. */
  | { kind: "message"; text: string }
  /** `text` is exactly what the model sees with later requests once allowed. */
  | { kind: "context"; text: string };

export interface McpAppHostContext {
  theme: "dark" | "light";
  styles: { variables: Record<string, string> };
  displayMode: McpAppDisplayMode;
  availableDisplayModes: McpAppDisplayMode[];
  containerDimensions: { width: number; maxHeight: number };
  locale: string;
  timeZone: string;
  platform: "desktop" | "web" | "mobile";
  toolInfo: { id: string; tool: { name: string; title?: string } };
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
  /** Backend resources/read, bound to the view's own server like callTool. */
  readResource: (uri: string) => Promise<unknown>;
  /** Store the view's model context; it replaces the previous one ("" clears it). */
  updateModelContext: (text: string) => Promise<void>;
  /**
   * Prepare a switch to a mode from availableDisplayModes other than the current one: returns
   * the move, or null when the host cannot show the view in that mode now (the mode stays).
   * A move unmounts this instance, so the host runs it only once the view has its reply.
   */
  setDisplayMode: (mode: McpAppDisplayMode) => (() => void) | null;
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
  const allowServerRequest = createBridgeRateLimiter(TOOL_CALLS_PER_WINDOW, TOOL_CALL_WINDOW_MS);
  const pendingHostRequests = new Map<string, (ok: boolean) => void>();
  let nextHostRequestId = 1;
  /**
   * Set by the first initialized: the tool lifecycle (tool-input, then tool-result or
   * tool-cancelled) goes out once per mounted frame. A later handshake on the same frame gets
   * its initialize reply only: in browser mode a page the frame navigated to can still post
   * from this contentWindow until its load event, and must not receive the call's data. A
   * view's own MCP Apps client that connects after the window.openai shim gets the data from
   * the shim, inside the page (mcpAppOpenAiShim.ts).
   */
  let initialized = false;
  /** Whether the user allowed this mounted view's model context (ui/update-model-context). */
  let modelContextAllowed = false;
  /** The view's appCapabilities.availableDisplayModes; undefined when it declared none. */
  let viewDisplayModes: readonly string[] | undefined;
  /** The mode the view was last told (initial context or host-context-changed). */
  let notifiedDisplayMode: McpAppDisplayMode | undefined;
  /**
   * The mode of an accepted move that has not run yet. The move replaces this instance, so
   * every later request is answered with it: that is where the view ends up.
   */
  let pendingDisplayMode: McpAppDisplayMode | undefined;

  /**
   * The mode the view is told. "The host MUST NOT switch the View to a display mode that does
   * not appear in its appCapabilities.availableDisplayModes": a view shown in the Artifacts tab
   * (fullscreen here) that did not declare fullscreen is told it is inline. No list means any.
   */
  const viewMode = (mode: McpAppDisplayMode): McpAppDisplayMode =>
    mode === "inline" || viewDisplayModes === undefined || viewDisplayModes.includes(mode)
      ? mode
      : "inline";

  const displayModeChanged = (hostMode: McpAppDisplayMode) => {
    const mode = viewMode(hostMode);
    if (!initialized || notifiedDisplayMode === undefined || mode === notifiedDisplayMode) return;
    notifiedDisplayMode = mode;
    notify("ui/notifications/host-context-changed", { displayMode: mode });
  };

  const respond = (id: string | number, result: unknown) =>
    options.postToView({ jsonrpc: "2.0", id, result });
  const fail = (id: string | number, code: number, message: string) =>
    options.postToView({ jsonrpc: "2.0", id, error: { code, message } });
  const notify = (method: string, params: unknown) =>
    options.postToView({ jsonrpc: "2.0", method, params });

  /** ui/resource-teardown; resolves when the view replies or after the bounded wait. */
  const teardown = (reason: string): Promise<void> => {
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
  };

  async function handleRequest(id: string | number, method: string, params: unknown) {
    switch (method) {
      case "ui/initialize": {
        const declared = InitializeParams.safeParse(params);
        // A later initialize without a list (the window.openai shim's, mcpAppOpenAiShim.ts) keeps
        // the view's own declaration: it must not widen the modes the view is told about.
        viewDisplayModes =
          (declared.success ? declared.data.appCapabilities?.availableDisplayModes : undefined) ??
          viewDisplayModes;
        const context = options.getHostContext();
        const hostContext = { ...context, displayMode: viewMode(context.displayMode) };
        notifiedDisplayMode = hostContext.displayMode;
        respond(id, {
          protocolVersion: MCP_APP_PROTOCOL_VERSION,
          hostInfo: { name: "xum", version: "1.0.0" },
          // Advertise only what is implemented.
          hostCapabilities: {
            serverTools: {},
            serverResources: {},
            logging: {},
            openLinks: {},
            // The modalities ui/update-model-context accepts (McpUiSupportedContentBlockModalities):
            // text blocks and structuredContent. Other blocks get -32602.
            updateModelContext: { text: {}, structuredContent: {} },
            sandbox: { csp: options.grantedCsp },
          },
          hostContext,
        });
        return;
      }
      case "ping":
        respond(id, {});
        return;
      case "tools/call": {
        const parsed = ToolCallParams.safeParse(params);
        if (!parsed.success) return fail(id, INVALID_PARAMS, "Invalid tools/call params");
        if (!allowServerRequest())
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
      case "resources/read": {
        const parsed = ReadResourceParams.safeParse(params);
        if (!parsed.success) return fail(id, INVALID_PARAMS, "Invalid resources/read params");
        if (!allowServerRequest())
          return fail(id, REQUEST_FAILED, "Too many server requests; try again shortly");
        options.log("resources/read", { uri: parsed.data.uri });
        try {
          // The request names only a URI: options.readResource is bound to this view's server,
          // so a view cannot read another server's resources.
          return respond(id, await options.readResource(parsed.data.uri));
        } catch (error) {
          return fail(id, REQUEST_FAILED, error instanceof Error ? error.message : String(error));
        }
      }
      case "ui/update-model-context": {
        const parsed = ModelContextParams.safeParse(params);
        const text = parsed.success ? modelContextText(parsed.data) : null;
        if (text === null) {
          return fail(id, INVALID_PARAMS, "Only text model context up to 16 KB is supported");
        }
        // The context reaches the model with every later request, so the user allows it once
        // per mounted view (this host lives as long as the view's document; a remount asks
        // again, and nothing is persisted). After Allow, the view can change its context until
        // it unmounts. Its server can already put any text in front of the model through tool
        // results; this keeps context the user never agreed to out. Clearing needs no consent.
        if (text !== "" && !modelContextAllowed) {
          if (!(await options.requestConsent({ kind: "context", text }))) {
            return fail(id, REQUEST_FAILED, "Context update denied");
          }
          modelContextAllowed = true;
        }
        try {
          await options.updateModelContext(text);
          return respond(id, {});
        } catch (error) {
          return fail(id, REQUEST_FAILED, error instanceof Error ? error.message : String(error));
        }
      }
      case "ui/request-display-mode": {
        const parsed = DisplayModeParams.safeParse(params);
        if (!parsed.success) return fail(id, INVALID_PARAMS, "Invalid display mode request");
        // Requests that arrive after an accepted move (between its reply and the move) cannot
        // change it: this instance is leaving, and the view ends up in the pending mode.
        if (pendingDisplayMode !== undefined) return respond(id, { mode: pendingDisplayMode });
        const context = options.getHostContext();
        const current = viewMode(context.displayMode);
        const requested = context.availableDisplayModes.find((mode) => mode === parsed.data.mode);
        // An unavailable mode, or one the view did not declare (the host MUST NOT switch to it),
        // leaves the mode unchanged; the spec has the host return the current mode, not fail.
        const move =
          requested !== undefined &&
          requested !== current &&
          (viewDisplayModes?.includes(requested) ?? true)
            ? options.setDisplayMode(requested)
            : null;
        const mode = move != null && requested !== undefined ? requested : current;
        respond(id, { mode });
        displayModeChanged(mode);
        if (move == null) return;
        pendingDisplayMode = mode;
        // The move unmounts this instance, and a frame removed before a queued postMessage
        // runs never gets it. The teardown reply comes after the view handled the mode reply
        // (messages arrive in order), and the view must get a teardown before it goes anyway.
        await teardown("display-mode");
        move();
        return;
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
        const text = parsed.success ? messageText(parsed.data.content) : null;
        if (text === null) return fail(id, INVALID_PARAMS, "Only user text messages are supported");
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
    /** The view's display mode changed (also from outside the view); notifies once per change. */
    displayModeChanged,
    sendHostContextChanged(context: Partial<McpAppHostContext>) {
      // Context changes only make sense once the view has its initial context.
      if (!initialized) return;
      notify("ui/notifications/host-context-changed", context);
    },
    teardown,
  };
}

export type McpAppHost = ReturnType<typeof createMcpAppHost>;
