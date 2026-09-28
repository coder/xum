import assert from "node:assert";
import { isBashCollapsedSummaryMode } from "xum/common/constants/storage";
import { normalizeAgentAiDefaults } from "xum/common/types/agentAiDefaults";

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function hasSafeSegments(path: string[]): boolean {
  if (path.length === 0) {
    return false;
  }

  for (const segment of path) {
    if (!segment || FORBIDDEN_SEGMENTS.has(segment)) {
      return false;
    }

    // Keep the proxy surface tight and predictable.
    if (!/^[a-zA-Z0-9_]+$/.test(segment)) {
      return false;
    }
  }

  return true;
}

const ALLOWED_PROCEDURES = {
  general: new Set(["listDirectory", "createDirectory", "ping", "openInEditor"]),
  workspace: new Set([
    "sendMessage",
    "interruptStream",
    "updateAgentAISettings",
    "answerAskUserQuestion",
    "getPlanContent",
    // Send or drop a held input from its banner (#4771); limited to shown workspaces by
    // sanitizeWebviewOrpcInput.
    "sendHeldInput",
    "discardHeldInput",
  ]),
  // redactWebviewOrpcResult strips URL and key-file fields from providers.getConfig (#4766).
  providers: new Set(["list", "getConfig", "onConfigChanged", "setModels"]),
  // App config for the model routing and thinking-floor stores (#4766). getConfig is projected to
  // the fields those stores read (see redactWebviewOrpcResult); onConfigChanged only emits empty
  // change signals. Every write (saveConfig, update*) stays blocked.
  config: new Set(["getConfig", "onConfigChanged"]),
  // Read-only agent descriptors (names, descriptions, UI flags, model defaults, tool patterns) for
  // the agent picker and agent-cycle shortcut (#4751). agents.get (full prompt bodies) stays
  // blocked, and sanitizeWebviewOrpcInput limits the input to workspaces the webview is shown.
  agents: new Set(["list"]),
  // Read-only admin policy (provider/model allowlists, runtime and MCP flags) so the model list
  // matches what the backend enforces (#4739); onChanged only emits empty change signals.
  // redactWebviewOrpcResult strips provider forcedBaseUrl before policy.get reaches the webview.
  policy: new Set(["get", "onChanged"]),
} as const;

export function isAllowedOrpcPath(path: string[]): boolean {
  assert(Array.isArray(path), "isAllowedOrpcPath requires path array");

  if (!hasSafeSegments(path)) {
    return false;
  }

  // We only support direct procedure access from the VS Code webview.
  // Nested routers expand the surface area and aren't needed for the sidebar.
  if (path.length !== 2) {
    return false;
  }

  const [root, procedure] = path;

  switch (root) {
    case "general":
      return ALLOWED_PROCEDURES.general.has(procedure);
    case "workspace":
      return ALLOWED_PROCEDURES.workspace.has(procedure);
    case "providers":
      return ALLOWED_PROCEDURES.providers.has(procedure);
    case "agents":
      return ALLOWED_PROCEDURES.agents.has(procedure);
    case "policy":
      return ALLOWED_PROCEDURES.policy.has(procedure);
    case "config":
      return ALLOWED_PROCEDURES.config.has(procedure);
    default:
      return false;
  }
}

/**
 * Removes fields the webview does not need from results before they cross the bridge.
 *
 * policy.get: a provider's forcedBaseUrl is an internal gateway URL that could embed credentials,
 * and no webview code reads it; only the allowlists and flags are forwarded. The input is not
 * mutated. Every other result passes through unchanged.
 *
 * config.getConfig (#4766): the app config also holds prompts, the governor URL, preferences and
 * task settings. Only the fields AppConfigStore reads are forwarded (an allow-list, so fields added
 * later stay in the host).
 * Of the task settings, only proposePlanImplementReplacesChatHistory (a boolean) is forwarded (#4942).
 * Of the user preferences, only appearance.bashCollapsedSummaryMode (a valid mode) is forwarded, and
 * agentAiDefaults is forwarded rebuilt by normalizeAgentAiDefaults (#4972, #4962).
 *
 * providers.getConfig (#4766): it carries no keys (only apiKeySet-style booleans), but base URLs and
 * the deployment URL can embed credentials and apiKeyFile is a local path; no webview code reads
 * them, so they are removed from every provider entry.
 */
export function redactWebviewOrpcResult(path: string[], value: unknown): unknown {
  const procedure = path.join(".");
  if (procedure === "config.getConfig") {
    return projectAppConfig(value);
  }
  if (procedure === "providers.getConfig") {
    return redactProvidersConfig(value);
  }
  if (procedure !== "policy.get") {
    return value;
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const response = value as { policy?: unknown };
  const policy = response.policy as { providerAccess?: unknown } | null | undefined;
  if (typeof policy !== "object" || policy === null || !Array.isArray(policy.providerAccess)) {
    return value;
  }
  return {
    ...response,
    policy: {
      ...policy,
      providerAccess: policy.providerAccess.map((entry: unknown) => {
        if (typeof entry !== "object" || entry === null) {
          return entry;
        }
        const { forcedBaseUrl: _forcedBaseUrl, ...rest } = entry as Record<string, unknown>;
        return rest;
      }),
    },
  };
}

const WEBVIEW_APP_CONFIG_FIELDS = ["routePriority", "routeOverrides", "minThinkingLevelByModel"];
const REDACTED_PROVIDER_CONFIG_FIELDS = new Set([
  "baseUrl",
  "baseUrlResolved",
  "deploymentUrl",
  "apiKeyFile",
]);

function projectAppConfig(value: unknown): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  if (typeof value !== "object" || value === null) {
    return projected;
  }
  const config = value as Record<string, unknown>;
  for (const field of WEBVIEW_APP_CONFIG_FIELDS) {
    if (config[field] !== undefined) {
      projected[field] = config[field];
    }
  }
  // The plan card needs this one task setting to refuse Implement when it would replace the chat
  // history, which the webview cannot do (#4942). Only the boolean crosses, never taskSettings.
  const taskSettings = config.taskSettings as Record<string, unknown> | null | undefined;
  const replacesHistory =
    typeof taskSettings === "object" && taskSettings !== null
      ? taskSettings.proposePlanImplementReplacesChatHistory
      : undefined;
  if (typeof replacesHistory === "boolean") {
    projected.taskSettings = { proposePlanImplementReplacesChatHistory: replacesHistory };
  }
  // Bash tool headers follow the user's collapsed-summary preference, as on desktop (#4972). Only
  // this one valid mode crosses, never the rest of userPreferences (theme, editor, paths, ...).
  const userPreferences = config.userPreferences as Record<string, unknown> | null | undefined;
  const appearance =
    typeof userPreferences === "object" && userPreferences !== null
      ? (userPreferences.appearance as Record<string, unknown> | null | undefined)
      : undefined;
  const bashMode =
    typeof appearance === "object" && appearance !== null
      ? appearance.bashCollapsedSummaryMode
      : undefined;
  if (isBashCollapsedSummaryMode(bashMode)) {
    projected.userPreferences = { appearance: { bashCollapsedSummaryMode: bashMode } };
  }
  // Agent switches and plan actions fall back to the per-agent defaults (Settings > Tasks) when the
  // workspace has no settings for the target agent (#4962). normalizeAgentAiDefaults rebuilds each
  // entry from named fields only, so unknown on-disk fields stay in the host.
  if (typeof config.agentAiDefaults === "object" && config.agentAiDefaults !== null) {
    projected.agentAiDefaults = normalizeAgentAiDefaults(config.agentAiDefaults);
  }
  return projected;
}

function redactProvidersConfig(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([provider, info]: [string, unknown]) => [
      provider,
      typeof info === "object" && info !== null
        ? Object.fromEntries(
            Object.entries(info).filter(([field]) => !REDACTED_PROVIDER_CONFIG_FIELDS.has(field))
          )
        : info,
    ])
  );
}

export type SanitizedOrpcInput = { ok: true; input: unknown } | { ok: false; error: string };

/**
 * Narrows webview-supplied input for procedures whose input could otherwise reach beyond what the
 * webview is shown. The webview is less trusted than the extension host (it renders model output).
 *
 * agents.list: a free-form projectPath would let the webview read agent-file frontmatter from any
 * directory, so only a workspaceId the extension already sent to the webview is accepted, and only
 * {workspaceId, disableWorkspaceAgents} is forwarded (projectPath/includeDisabled are dropped).
 *
 * workspace.sendHeldInput / discardHeldInput (#4771): only for a workspace the extension sent, and
 * only {workspaceId, heldInputId} is forwarded.
 */
export function sanitizeWebviewOrpcInput(
  path: string[],
  input: unknown,
  knownWorkspaceIds: ReadonlySet<string>
): SanitizedOrpcInput {
  assert(isAllowedOrpcPath(path), "sanitizeWebviewOrpcInput requires an allowed path");

  const procedure = path.join(".");
  if (procedure === "workspace.sendHeldInput" || procedure === "workspace.discardHeldInput") {
    return sanitizeHeldInputAction(procedure, input, knownWorkspaceIds);
  }

  if (procedure !== "agents.list") {
    return { ok: true, input };
  }

  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "agents.list requires an input object" };
  }
  const record = input as Record<string, unknown>;
  const workspaceId = record.workspaceId;
  if (typeof workspaceId !== "string" || !knownWorkspaceIds.has(workspaceId)) {
    return { ok: false, error: "agents.list is limited to known workspaces" };
  }
  return {
    ok: true,
    input: {
      workspaceId,
      ...(record.disableWorkspaceAgents === true ? { disableWorkspaceAgents: true } : {}),
    },
  };
}

function sanitizeHeldInputAction(
  procedure: string,
  input: unknown,
  knownWorkspaceIds: ReadonlySet<string>
): SanitizedOrpcInput {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: `${procedure} requires an input object` };
  }
  const record = input as Record<string, unknown>;
  const workspaceId = record.workspaceId;
  if (typeof workspaceId !== "string" || !knownWorkspaceIds.has(workspaceId)) {
    return { ok: false, error: `${procedure} is limited to known workspaces` };
  }
  if (typeof record.heldInputId !== "string") {
    return { ok: false, error: `${procedure} requires a heldInputId` };
  }
  return { ok: true, input: { workspaceId, heldInputId: record.heldInputId } };
}
