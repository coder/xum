/**
 * Renderer-safe path utilities for cross-platform compatibility.
 * Handles differences between Unix-style paths (/) and Windows paths (\).
 *
 * This module is safe for BOTH main and renderer, but intentionally avoids any
 * Node globals (process/env). Main-only helpers live in './paths.main'.
 */

export interface PathComponents {
  root: string; // "/" on Unix, "C:\\" on Windows, "" for relative paths
  segments: string[]; // Directory segments (excluding basename)
  basename: string; // Final path component
}

/**
 * Determine if current platform is Windows (renderer-safe)
 */
function isWindowsPlatform(): boolean {
  if (typeof navigator !== "undefined" && navigator.platform) {
    return navigator.platform.toLowerCase().includes("win");
  }
  // Default to Unix-style when navigator is unavailable (e.g., Node context)
  return false;
}

function getSeparator(): string {
  return isWindowsPlatform() ? "\\" : "/";
}

/**
 * OS-aware path utilities that handle Windows and Unix paths correctly.
 * This class provides a single source of truth for path operations that need
 * to be aware of platform differences.
 */
export class PlatformPaths {
  /**
   * Get the appropriate path separator for the current platform
   */
  static get separator(): string {
    return getSeparator();
  }

  /**
   * Extract basename from path (OS-aware)
   *
   * @param filePath - Path to extract basename from
   * @returns The final component of the path
   *
   * @example
   * // Unix
   * basename("/home/user/project") // => "project"
   *
   * // Windows
   * basename("C:\\Users\\user\\project") // => "project"
   */
  static basename(filePath: string): string {
    if (!filePath || typeof filePath !== "string") {
      return filePath;
    }

    const lastSlash = isWindowsPlatform()
      ? Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"))
      : filePath.lastIndexOf("/");
    if (lastSlash === -1) {
      return filePath;
    }
    return filePath.slice(lastSlash + 1);
  }

  /**
   * Split path into components (OS-aware)
   *
   * @param filePath - Path to parse
   * @returns Object with root, segments, and basename
   *
   * @example
   * // Unix
   * parse("/home/user/project") // => { root: "/", segments: ["home", "user"], basename: "project" }
   *
   * // Windows
   * parse("C:\\Users\\user\\project") // => { root: "C:\\", segments: ["Users", "user"], basename: "project" }
   */
  static parse(filePath: string): PathComponents {
    if (!filePath || typeof filePath !== "string") {
      return { root: "", segments: [], basename: filePath };
    }

    const original = filePath;
    let root = "";
    let dir = "";
    let base = "";

    // Determine basename and directory
    const lastSlash = isWindowsPlatform()
      ? Math.max(original.lastIndexOf("/"), original.lastIndexOf("\\"))
      : original.lastIndexOf("/");
    if (lastSlash === -1) {
      base = original;
      dir = "";
    } else {
      base = original.slice(lastSlash + 1);
      dir = original.slice(0, lastSlash);
    }

    // Determine root
    if (isWindowsPlatform()) {
      const driveMatch = /^[A-Za-z]:[\\/]/.exec(original);
      if (driveMatch) {
        root = driveMatch[0];
        // Ensure dir does not include root
        if (dir.startsWith(root)) {
          dir = dir.slice(root.length);
        }
      } else if (original.startsWith("\\\\")) {
        // UNC paths - treat leading double-backslash as root
        root = "\\\\";
        if (dir.startsWith(root)) {
          dir = dir.slice(root.length);
        }
      }
      // Also treat Unix-style absolute paths as absolute even on Windows
      if (!root && original.startsWith("/")) {
        root = "/";
        if (dir.startsWith(root)) {
          dir = dir.slice(root.length);
        }
      }
    } else if (original.startsWith("/")) {
      root = "/";
      if (dir.startsWith(root)) {
        dir = dir.slice(root.length);
      }
    }

    const separatorRegex = isWindowsPlatform() ? /[\\/]+/ : /\/+/;
    const segments = dir ? dir.split(separatorRegex).filter(Boolean) : [];

    return {
      root,
      segments,
      basename: base,
    };
  }

  /**
   * Format path for display with fish-style abbreviation (OS-aware)
   * Abbreviates all directory components except the last one to their first letter
   *
   * @param filePath - Path to abbreviate
   * @returns Abbreviated path
   *
   * @example
   * // Unix
   * abbreviate("/home/user/Projects/mux") // => "/h/u/P/mux"
   *
   * // Windows
   * abbreviate("C:\\Users\\john\\Documents\\project") // => "C:\\U\\j\\D\\project"
   */
  static abbreviate(filePath: string): string {
    if (!filePath || typeof filePath !== "string") {
      return filePath;
    }

    const { root, segments, basename } = this.parse(filePath);

    // Abbreviate all segments to first character
    const abbreviated = segments.map((seg) => (seg.length > 0 ? seg[0] : seg));

    // Reconstruct path - handle root separately to avoid double separator
    if (!root && abbreviated.length === 0) {
      return basename;
    }

    const sep = isWindowsPlatform() ? (filePath.includes("\\") ? "\\" : "/") : "/";
    const joined = [...abbreviated, basename].filter(Boolean).join(sep);
    if (!root) {
      return joined;
    }
    const rootEndsWithSep = root.endsWith("\\") || root.endsWith("/");
    return rootEndsWithSep ? root + joined : root + sep + joined;
  }

  /**
   * Split an abbreviated path into directory path and basename
   *
   * @param filePath - Abbreviated path
   * @returns Object with dirPath (including trailing separator) and basename
   *
   * @example
   * splitAbbreviated("/h/u/P/mux") // => { dirPath: "/h/u/P/", basename: "mux" }
   */
  static splitAbbreviated(filePath: string): { dirPath: string; basename: string } {
    if (!filePath || typeof filePath !== "string") {
      return { dirPath: "", basename: filePath };
    }

    const sep = isWindowsPlatform() ? (filePath.includes("\\") ? "\\" : "/") : "/";
    const lastSlash = filePath.lastIndexOf(sep);
    if (lastSlash === -1) {
      return { dirPath: "", basename: filePath };
    }
    return {
      dirPath: filePath.slice(0, lastSlash + 1),
      basename: filePath.slice(lastSlash + 1),
    };
  }

  /**
   * NOTE: Home expansion and formatting helpers are main-only.
   * Use './paths.main' for expandHome/formatHome in Node contexts.
   */

  /**
   * Get project name from path (OS-aware)
   * Extracts the final directory name from a project path
   *
   * @param projectPath - Path to the project
   * @returns Project name (final directory component)
   *
   * @example
   * getProjectName("/home/user/projects/mux") // => "mux"
   * getProjectName("C:\\Users\\john\\projects\\mux") // => "mux"
   */
  static getProjectName(projectPath: string): string {
    return this.basename(projectPath) || "unknown";
  }
}

/**
 * A display label for a path the SERVER sent: its last segment, split on "/" and "\\". The
 * renderer cannot tell the server's platform from the client's (a browser on Linux can talk to a
 * Windows server), so it splits on both. Display only: never use it to build a path or an id.
 * Returns `fallback` for an empty last segment (an empty path or a trailing separator) (#6714).
 */
export function serverPathLabel(serverPath: string, fallback: string): string {
  const lastSeparator = Math.max(serverPath.lastIndexOf("/"), serverPath.lastIndexOf("\\"));
  return serverPath.slice(lastSeparator + 1) || fallback;
}
