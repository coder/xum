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
    default:
      return false;
  }
}
