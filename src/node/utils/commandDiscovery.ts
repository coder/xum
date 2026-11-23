/**
 * Utilities for discovering available commands in the system.
 * Used by terminalService and openInEditor to find executables.
 */

import * as fs from "fs/promises";
import { findExecutableOnPath, isExecutableFile } from "@/node/utils/findExecutableOnPath";

/** Known installation paths for GUI editors on macOS */
const MACOS_APP_PATHS: Record<string, string[]> = {
  cursor: ["/Applications/Cursor.app/Contents/Resources/app/bin/cursor", "/usr/local/bin/cursor"],
  code: [
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    "/usr/local/bin/code",
  ],
  zed: ["/Applications/Zed.app/Contents/MacOS/cli", "/usr/local/bin/zed"],
  subl: ["/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl", "/usr/local/bin/subl"],
  ghostty: [
    "/opt/homebrew/bin/ghostty",
    "/Applications/Ghostty.app/Contents/MacOS/ghostty",
    "/usr/local/bin/ghostty",
  ],
};

/**
 * Check if a command is available in the system PATH or known locations.
 * First checks macOS-specific paths for known apps, then scans PATH in-process
 * without spawning `which`/`where`.
 */
export async function isCommandAvailable(command: string): Promise<boolean> {
  if (!command) {
    return false;
  }

  // Check known paths for macOS apps
  if (process.platform === "darwin" && command in MACOS_APP_PATHS) {
    for (const appPath of MACOS_APP_PATHS[command]) {
      try {
        const stats = await fs.stat(appPath);
        // Check if it's a file and any executable bit is set
        if (stats.isFile() && (stats.mode & 0o111) !== 0) {
          return true;
        }
      } catch {
        // Try next path
      }
    }
  }

  if (command.includes("/") || command.includes("\\")) {
    return isExecutableFile(command);
  }

  return findExecutableOnPath(command) !== null;
}

/**
 * Find the first available command from a list of candidates.
 * Returns the command name (not full path) of the first available one.
 */
export async function findAvailableCommand(commands: string[]): Promise<string | null> {
  for (const cmd of commands) {
    if (await isCommandAvailable(cmd)) {
      return cmd;
    }
  }
  return null;
}
