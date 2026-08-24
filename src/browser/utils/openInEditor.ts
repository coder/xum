import { readPersistedState } from "@/browser/hooks/usePersistedState";
import {
  getEditorDeepLink,
  getDockerDeepLink,
  getDevcontainerDeepLink,
  isLocalhost,
  type DeepLinkEditor,
} from "@/browser/utils/editorDeepLinks";
import {
  DEFAULT_EDITOR_CONFIG,
  EDITOR_CONFIG_KEY,
  normalizeEditorConfig,
  type EditorConfig,
} from "@/common/constants/storage";
import type { RuntimeConfig } from "@/common/types/runtime";
import { isSSHRuntime, isDockerRuntime, isDevcontainerRuntime } from "@/common/types/runtime";
import type { APIClient } from "@/browser/contexts/API";

export interface OpenInEditorResult {
  success: boolean;
  error?: string;
}

// Browser mode: window.api is not set (only exists in Electron via preload)
const isBrowserMode = typeof window !== "undefined" && !window.api;

// Helper for opening URLs - allows testing in Node environment
function openUrl(url: string): void {
  if (typeof window !== "undefined" && window.open) {
    window.open(url, "_blank");
  }
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function normalizePathSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

function mapHostPathToContainerPath(options: {
  hostWorkspacePath: string;
  containerWorkspacePath: string;
  targetPath: string;
}): string {
  // Normalize backslashes for Windows compatibility
  const hostWorkspacePath = trimTrailingSlash(normalizePathSeparators(options.hostWorkspacePath));
  const containerWorkspacePath = trimTrailingSlash(options.containerWorkspacePath);
  const targetPath = trimTrailingSlash(normalizePathSeparators(options.targetPath));

  if (targetPath === hostWorkspacePath) {
    return containerWorkspacePath || "/";
  }

  const prefix = `${hostWorkspacePath}/`;
  if (targetPath.startsWith(prefix)) {
    const relative = targetPath.slice(hostWorkspacePath.length);
    if (!relative) {
      return containerWorkspacePath || "/";
    }

    if (containerWorkspacePath === "/") {
      return relative;
    }

    return `${containerWorkspacePath}${relative}`;
  }

  return containerWorkspacePath || "/";
}

/**
 * Get parent directory from a path.
 */
function getParentDirectory(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  const isRootLevelPath = lastSlash === 0; // e.g., /file.txt at root
  return isRootLevelPath ? "/" : path.substring(0, lastSlash) || "/";
}

export async function openInEditor(args: {
  api: APIClient | null | undefined;
  openSettings?: (section?: string) => void;
  workspaceId: string;
  targetPath: string;
  runtimeConfig?: RuntimeConfig;
  /**
   * When true, indicates targetPath is a file.
   *
   * Some deep link formats (e.g. VS Code's Docker attached-container URI) can only
   * open folders/workspaces, so we fall back to opening the parent directory.
   */
  isFile?: boolean;
}): Promise<OpenInEditorResult> {
  const editorConfig = normalizeEditorConfig(
    readPersistedState<EditorConfig>(EDITOR_CONFIG_KEY, DEFAULT_EDITOR_CONFIG)
  );

  const isSSH = isSSHRuntime(args.runtimeConfig);
  const isDocker = isDockerRuntime(args.runtimeConfig);

  // For custom editor with no command configured, open settings (if available)
  if (editorConfig.editor === "custom" && !editorConfig.customCommand) {
    args.openSettings?.("general");
    return { success: false, error: "Please configure a custom editor command in Settings" };
  }

  // For SSH workspaces, validate the editor supports SSH connections
  if (isSSH) {
    if (editorConfig.editor === "custom") {
      return {
        success: false,
        error: "Custom editors do not support SSH connections for SSH workspaces",
      };
    }
  }

  // Record the open before launching any editor: external editors are untrackable once open
  // (deep links leave no process handle), so model-driven snapshot archives consult this
  // durable record — and an archive already in progress must refuse the open. Recording is
  // conservative: refusals below this point leave a sticky false positive, which only makes
  // archive gating stricter. Custom-editor opens are recorded again on the backend route;
  // recording is idempotent. Fail closed: a transient client disconnect (api null while
  // reconnecting) or a failed recording RPC does not stop backend agents, so launching
  // unrecorded would let a concurrent archive remove the checkout under the new editor.
  if (!args.api) {
    return {
      success: false,
      error:
        "Cannot open the editor while disconnected from Xum: the open must be recorded first so archive safety checks can see it. Retry once reconnected.",
    };
  }
  try {
    const recorded = await args.api.general.recordEditorOpen({ workspaceId: args.workspaceId });
    if (!recorded.success) {
      return { success: false, error: recorded.error };
    }
  } catch (error) {
    return {
      success: false,
      error: `Cannot open the editor: recording the open failed (${error instanceof Error ? error.message : String(error)}), and archive safety checks depend on that record.`,
    };
  }

  // Docker workspaces always use deep links (VS Code connects to container remotely)
  if (isDocker && args.runtimeConfig?.type === "docker") {
    if (editorConfig.editor === "zed") {
      return { success: false, error: "Zed does not support Docker containers" };
    }
    if (editorConfig.editor === "custom") {
      return { success: false, error: "Custom editors do not support Docker containers" };
    }

    const containerName = args.runtimeConfig.containerName;
    if (!containerName) {
      return {
        success: false,
        error: "Container name not available. Try reopening the workspace.",
      };
    }

    // VS Code's attached-container URI scheme only supports opening folders as workspaces,
    // not individual files. Open the parent directory so the file is visible in the file tree.
    const targetDir = args.isFile ? getParentDirectory(args.targetPath) : args.targetPath;
    const deepLink = getDockerDeepLink({
      editor: editorConfig.editor as DeepLinkEditor,
      containerName,
      path: targetDir,
    });

    if (!deepLink) {
      return { success: false, error: `${editorConfig.editor} does not support Docker containers` };
    }

    openUrl(deepLink);
    return { success: true };
  }

  // Devcontainer workspaces use deep links with container info from backend
  const isDevcontainer = isDevcontainerRuntime(args.runtimeConfig);
  if (isDevcontainer && args.runtimeConfig?.type === "devcontainer") {
    if (editorConfig.editor === "zed") {
      return { success: false, error: "Zed does not support Dev Containers" };
    }
    if (editorConfig.editor === "custom") {
      return { success: false, error: "Custom editors do not support Dev Containers" };
    }

    // Fetch container info from backend (on-demand discovery)
    const info = await args.api?.workspace.getDevcontainerInfo({ workspaceId: args.workspaceId });
    if (!info) {
      return {
        success: false,
        error: "Dev Container not running. Try reopening the workspace.",
      };
    }

    // VS Code's dev-container URI scheme only supports opening folders as workspaces,
    // not individual files. Open the parent directory so the file is visible in the file tree.
    const normalizedTargetPath = normalizePathSeparators(args.targetPath);
    const targetDir = args.isFile ? getParentDirectory(normalizedTargetPath) : normalizedTargetPath;

    const hostWorkspacePath = trimTrailingSlash(info.hostWorkspacePath);
    const containerPath = mapHostPathToContainerPath({
      hostWorkspacePath,
      containerWorkspacePath: info.containerWorkspacePath,
      targetPath: targetDir,
    });

    // Build the config file path if available
    const configFilePath = args.runtimeConfig.configPath
      ? isAbsolutePath(args.runtimeConfig.configPath)
        ? args.runtimeConfig.configPath
        : `${hostWorkspacePath}/${args.runtimeConfig.configPath}`
      : undefined;

    const deepLink = getDevcontainerDeepLink({
      editor: editorConfig.editor as DeepLinkEditor,
      containerName: info.containerName,
      hostPath: hostWorkspacePath,
      containerPath,
      configFilePath,
    });

    if (!deepLink) {
      return { success: false, error: `${editorConfig.editor} does not support Dev Containers` };
    }

    openUrl(deepLink);
    return { success: true };
  }

  // VS Code / Cursor / Zed: always use deep links (works in browser + Electron)
  if (editorConfig.editor !== "custom") {
    // Determine SSH host for deep link
    let sshHost: string | undefined;
    if (isSSH && args.runtimeConfig?.type === "ssh") {
      // SSH workspace: use the configured SSH host
      sshHost = args.runtimeConfig.host;
      if (editorConfig.editor === "zed" && args.runtimeConfig.port != null) {
        sshHost = sshHost + ":" + args.runtimeConfig.port;
      }
    } else if (isBrowserMode && !isLocalhost(window.location.hostname)) {
      // Remote server + local workspace: need SSH to reach server's files
      const serverSshHost = await args.api?.server.getSshHost();
      sshHost = serverSshHost ?? window.location.hostname;
    }
    // else: localhost access to local workspace → no SSH needed

    // VS Code/Cursor SSH deep links treat the path as a folder unless a line/column is present.
    const deepLink = getEditorDeepLink({
      editor: editorConfig.editor as DeepLinkEditor,
      path: args.targetPath,
      sshHost,
      line: args.isFile && sshHost ? 1 : undefined,
      column: args.isFile && sshHost ? 1 : undefined,
    });

    if (!deepLink) {
      return {
        success: false,
        error: `${editorConfig.editor} does not support SSH remote connections`,
      };
    }

    openUrl(deepLink);
    return { success: true };
  }

  // Custom editor:
  // - Browser mode: can't spawn processes on the server
  // - Electron mode: spawn via backend API
  if (isBrowserMode) {
    return {
      success: false,
      error: "Custom editors are not supported in browser mode. Use VS Code, Cursor, or Zed.",
    };
  }

  const result = await args.api?.general.openInEditor({
    workspaceId: args.workspaceId,
    targetPath: args.targetPath,
    editorConfig,
  });

  if (!result) {
    return { success: false, error: "API not available" };
  }

  if (!result.success) {
    return { success: false, error: result.error };
  }

  return { success: true };
}
