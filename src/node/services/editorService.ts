import { exec as childProcessExec, spawn, spawnSync } from "child_process";
import * as fsPromises from "fs/promises";
import { promisify } from "util";
import type { Config } from "@/node/config";
import { isDockerRuntime, isSSHRuntime, isDevcontainerRuntime } from "@/common/types/runtime";
import { log } from "@/node/services/log";
import { sanitizeXumChildEnv } from "@/node/runtime/childProcessEnv";
import { getErrorMessage } from "@/common/utils/errors";

const execAsync = promisify(childProcessExec);

/**
 * Quote a string for safe use in shell commands.
 *
 * IMPORTANT: Prefer spawning commands with an args array instead of building a
 * single shell string. This helper exists only for custom editor commands.
 */
function shellQuote(value: string): string {
  if (value.length === 0) return process.platform === "win32" ? '""' : "''";

  // cmd.exe: use double quotes (single quotes are treated as literal characters)
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '""')}"`;
  }

  // POSIX shells: single quotes with proper escaping for embedded single quotes.
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

function getExecutableFromShellCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const endQuoteIndex = trimmed.indexOf(quote, 1);
    if (endQuoteIndex === -1) {
      return null;
    }
    return trimmed.slice(1, endQuoteIndex);
  }

  return trimmed.split(/\s+/)[0] ?? null;
}

function looksLikePath(command: string): boolean {
  return (
    command.startsWith("./") ||
    command.startsWith("../") ||
    command.includes("/") ||
    command.includes("\\") ||
    /^[A-Za-z]:/.test(command)
  );
}

export interface EditorConfig {
  editor: string;
  customCommand?: string;
}

/**
 * Service for opening workspaces in code editors.
 *
 * NOTE: VS Code/Cursor/Zed are opened via deep links in the renderer.
 * This service is only responsible for spawning the user's custom editor command.
 */
export class EditorService {
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Open a path in the user's configured code editor.
   *
   * @param workspaceId - The workspace (used to determine runtime + validate constraints)
   * @param targetPath - The path to open (workspace directory or specific file)
   * @param editorConfig - Editor configuration from user settings
   */
  async openInEditor(
    workspaceId: string,
    targetPath: string,
    editorConfig: EditorConfig
  ): Promise<{ success: true; data: void } | { success: false; error: string }> {
    try {
      if (editorConfig.editor !== "custom") {
        return {
          success: false,
          error:
            "Built-in editors are opened via deep links. Select Custom editor to use a command.",
        };
      }

      const customCommand = editorConfig.customCommand?.trim();
      if (!customCommand) {
        return { success: false, error: "No editor command configured" };
      }

      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const workspace = allMetadata.find((w) => w.id === workspaceId);

      if (!workspace) {
        return { success: false, error: `Workspace not found: ${workspaceId}` };
      }

      // Remote runtimes: custom commands run on the local machine and can't access remote paths.
      if (isSSHRuntime(workspace.runtimeConfig)) {
        return {
          success: false,
          error: "Custom editors do not support SSH connections for SSH workspaces",
        };
      }

      if (isDevcontainerRuntime(workspace.runtimeConfig)) {
        return { success: false, error: "Custom editors do not support Dev Containers" };
      }
      if (isDockerRuntime(workspace.runtimeConfig)) {
        return { success: false, error: "Custom editors do not support Docker containers" };
      }

      const executable = getExecutableFromShellCommand(customCommand);
      if (!executable) {
        return { success: false, error: `Invalid custom editor command: ${customCommand}` };
      }

      if (!(await this.isCommandAvailable(executable))) {
        return { success: false, error: `Editor command not found: ${executable}` };
      }

      // Local - expand tilde (shellQuote prevents shell expansion)
      const resolvedPath = targetPath.startsWith("~/")
        ? targetPath.replace("~", process.env.HOME ?? "~")
        : targetPath;

      const shellCmd = `${customCommand} ${shellQuote(resolvedPath)}`;
      log.info(`Opening local path in custom editor: ${shellCmd}`);
      const child = spawn(shellCmd, [], {
        detached: true,
        stdio: "ignore",
        shell: true,
        windowsHide: true,
        // Strip xum-internal vars (e.g. CHROME_DESKTOP, our Linux desktop
        // identity) so GUI editors don't inherit xum's window identity.
        // sanitizeXumChildEnv copies its input, so pass process.env directly.
        env: sanitizeXumChildEnv(process.env),
      });
      child.unref();

      return { success: true, data: undefined };
    } catch (err) {
      const message = getErrorMessage(err);
      log.error(`Failed to open in editor: ${message}`);
      return { success: false, error: message };
    }
  }

  async installVsCodeExtension(
    editor: "vscode" | "cursor"
  ): Promise<{ installed: boolean; alreadyInstalled: boolean; error?: string }> {
    try {
      const cli = editor === "cursor" ? "cursor" : "code";
      const extensionId = "coder.mux";

      const { stdout } = await execAsync(`${cli} --list-extensions`, {
        timeout: 10_000,
        windowsHide: true,
      });
      const extensionListOutput = String(stdout);
      const alreadyInstalled = extensionListOutput
        .split(/\r?\n/)
        .some((line) => line.trim().toLowerCase() === extensionId);

      if (alreadyInstalled) {
        return { installed: true, alreadyInstalled: true };
      }

      await execAsync(`${cli} --install-extension ${extensionId}`, {
        timeout: 30_000,
        windowsHide: true,
      });

      return { installed: true, alreadyInstalled: false };
    } catch (error) {
      log.debug("Failed to install VS Code extension", {
        editor,
        error: String(error),
      });
      return {
        installed: false,
        alreadyInstalled: false,
        error: String(error),
      };
    }
  }

  /**
   * Check if a command is available in the system PATH.
   * Inherits enriched PATH from process.env (set by initShellEnv at startup).
   */
  private async isCommandAvailable(command: string): Promise<boolean> {
    try {
      if (looksLikePath(command)) {
        await fsPromises.access(command);
        return true;
      }

      const lookupCommand = process.platform === "win32" ? "where" : "which";
      const result = spawnSync(lookupCommand, [command], { encoding: "utf8" });
      return result.status === 0;
    } catch {
      return false;
    }
  }
}
