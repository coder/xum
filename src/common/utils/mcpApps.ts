/**
 * MCP Apps (SEP-1865, `io.modelcontextprotocol/ui`, spec 2026-01-26) shared constants and pure
 * helpers. Gated by the artifacts experiment: with it off, Xum neither announces the extension
 * nor keeps any `_meta.ui`.
 */

export const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
/**
 * ChatGPT Apps SDK templates (reached through `_meta["openai/outputTemplate"]`) are served as
 * this legacy MIME type. Accepted for view resources next to MCP_APP_MIME_TYPE.
 */
export const MCP_APP_SKYBRIDGE_MIME_TYPE = "text/html+skybridge";
/** Largest view resource (decoded HTML) the host accepts from resources/read. */
export const MCP_APP_RESOURCE_MAX_BYTES = 2 * 1024 * 1024;
/** Longest ui:// URI kept on tool metadata and display snapshots. */
export const MCP_APP_RESOURCE_URI_MAX_CHARS = 512;
/** Largest ui/update-model-context text (UTF-8 bytes) a view may store; larger is -32602. */
export const MCP_APP_MODEL_CONTEXT_MAX_BYTES = 16 * 1024;
/** Longest URI a view may pass to resources/read (any scheme its server serves). */
export const MCP_APP_READ_URI_MAX_CHARS = 2048;

export type MCPToolVisibility = "model" | "app";

export interface MCPToolUi {
  /**
   * The tool's view. Optional: an app-only helper may declare `visibility` without a view of
   * its own, and its visibility must still apply. Callers that associate a view (result
   * records, display snapshots, "Open in Artifacts") require it.
   */
  resourceUri?: string;
  visibility: MCPToolVisibility[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMcpAppResourceUri(uri: unknown): uri is string {
  return (
    typeof uri === "string" &&
    uri.startsWith("ui://") &&
    uri.length > "ui://".length &&
    uri.length <= MCP_APP_RESOURCE_URI_MAX_CHARS
  );
}

/** The spec's default when a tool declares no visibility (including tools without `_meta.ui`). */
const DEFAULT_VISIBILITY: readonly MCPToolVisibility[] = ["model", "app"];

/**
 * Read a tool definition's `_meta.ui` (or the deprecated flat `_meta["ui/resourceUri"]`).
 * The view URI is taken from the first key present, in this order: `_meta.ui.resourceUri`,
 * `_meta["ui/resourceUri"]`, then ChatGPT's compatibility alias `_meta["openai/outputTemplate"]`
 * (so servers built for ChatGPT render here too). ChatGPT's `openai/visibility` and
 * `openai/widgetAccessible` are not mapped: their documented semantics do not say how they
 * combine with the spec's default visibility, so only `_meta.ui.visibility` counts.
 * The view URI and the visibility are parsed independently: an invalid or missing ui:// view
 * drops only `resourceUri`, never a declared visibility (a `visibility: ["app"]` helper must
 * stay hidden from the model). Returns undefined when neither is declared. Visibility defaults
 * to ["model", "app"] per the spec; unknown visibility entries are ignored.
 */
export function parseMCPToolUiMeta(meta: unknown): MCPToolUi | undefined {
  if (!isRecord(meta)) return undefined;
  const ui = isRecord(meta.ui) ? meta.ui : undefined;
  const rawResourceUri = ui?.resourceUri ?? meta["ui/resourceUri"] ?? meta["openai/outputTemplate"];
  const resourceUri = isMcpAppResourceUri(rawResourceUri) ? rawResourceUri : undefined;
  const rawVisibility = ui?.visibility;
  if (resourceUri === undefined && !Array.isArray(rawVisibility)) return undefined;
  const visibility = Array.isArray(rawVisibility)
    ? [
        ...new Set(
          rawVisibility.filter((v): v is MCPToolVisibility => v === "model" || v === "app")
        ),
      ]
    : ([...DEFAULT_VISIBILITY] satisfies MCPToolVisibility[]);
  return resourceUri !== undefined ? { resourceUri, visibility } : { visibility };
}

/** Whether a tool belongs in the agent's tool list. */
export function isModelVisibleTool(ui: MCPToolUi | undefined): boolean {
  return (ui?.visibility ?? DEFAULT_VISIBILITY).includes("model");
}

/**
 * Whether a view may call the tool through tools/call (the host MUST reject it otherwise).
 * Tools without `_meta.ui` get the default visibility, so they are app-callable but, being
 * model-visible too, need a per-call user confirmation.
 */
export function isAppCallableTool(ui: MCPToolUi | undefined): boolean {
  return (ui?.visibility ?? DEFAULT_VISIBILITY).includes("app");
}
