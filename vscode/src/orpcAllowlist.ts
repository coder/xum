import assert from "node:assert";

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
  ]),
  providers: new Set(["list", "getConfig", "onConfigChanged", "setModels"]),
  // Read-only agent descriptors (names, descriptions, UI flags, model defaults, tool patterns) for
  // the agent picker and agent-cycle shortcut (#4751). agents.get (full prompt bodies) stays
  // blocked, and sanitizeWebviewOrpcInput limits the input to workspaces the webview is shown.
  agents: new Set(["list"]),
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
    default:
      return false;
  }
}

/**
 * Workspace IDs the extension has sent to the webview: the workspace list plus the selected ID.
 * On a fresh extension host the restored selection is posted before the list refresh finishes, and
 * the webview's agent lookup for it must not be rejected in that window.
 */
export function webviewKnownWorkspaceIds(
  listedWorkspaceIds: Iterable<string>,
  selectedWorkspaceId: string | null
): Set<string> {
  const known = new Set(listedWorkspaceIds);
  if (selectedWorkspaceId) {
    known.add(selectedWorkspaceId);
  }
  return known;
}

export type SanitizedOrpcInput = { ok: true; input: unknown } | { ok: false; error: string };

/**
 * Narrows webview-supplied input for procedures whose input could otherwise reach beyond what the
 * webview is shown. The webview is less trusted than the extension host (it renders model output).
 *
 * agents.list: a free-form projectPath would let the webview read agent-file frontmatter from any
 * directory, so only a workspaceId the extension already sent to the webview is accepted, and only
 * {workspaceId, disableWorkspaceAgents} is forwarded (projectPath/includeDisabled are dropped).
 */
export function sanitizeWebviewOrpcInput(
  path: string[],
  input: unknown,
  knownWorkspaceIds: ReadonlySet<string>
): SanitizedOrpcInput {
  assert(isAllowedOrpcPath(path), "sanitizeWebviewOrpcInput requires an allowed path");

  if (path[0] !== "agents" || path[1] !== "list") {
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
