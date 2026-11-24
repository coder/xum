import type { WebviewToExtensionMessage } from "./webview/protocol";

/**
 * Runtime validation boundary for untrusted data coming from the VS Code webview.
 *
 * The webview can send arbitrary `postMessage` payloads, so we validate shape/types
 * before processing and return `null` for anything unexpected.
 */
export function parseWebviewToExtensionMessage(raw: unknown): WebviewToExtensionMessage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== "string") {
    return null;
  }

  switch (type) {
    case "ready":
    case "refreshWorkspaces":
    case "configureConnection":
      return { type };

    case "selectWorkspace": {
      const workspaceId = record.workspaceId;
      if (typeof workspaceId !== "string" && workspaceId !== null) {
        return null;
      }

      return { type, workspaceId };
    }

    case "openWorkspace": {
      if (typeof record.workspaceId !== "string") {
        return null;
      }

      return { type, workspaceId: record.workspaceId };
    }

    case "debugLog": {
      if (typeof record.message !== "string") {
        return null;
      }

      return { type, message: record.message, data: record.data };
    }

    case "copyDebugLog": {
      if (typeof record.text !== "string") {
        return null;
      }

      return { type, text: record.text };
    }

    case "orpcCall": {
      if (typeof record.requestId !== "string") {
        return null;
      }

      const path = record.path;
      if (!Array.isArray(path) || !path.every((segment) => typeof segment === "string")) {
        return null;
      }

      const lastEventId = typeof record.lastEventId === "string" ? record.lastEventId : undefined;

      return {
        type,
        requestId: record.requestId,
        path: path,
        input: record.input,
        lastEventId,
      };
    }

    case "orpcCancel": {
      if (typeof record.requestId !== "string") {
        return null;
      }

      return { type, requestId: record.requestId };
    }

    case "orpcStreamCancel": {
      if (typeof record.streamId !== "string") {
        return null;
      }

      return { type, streamId: record.streamId };
    }

    default:
      return null;
  }
}
