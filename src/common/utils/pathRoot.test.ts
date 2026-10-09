import { describe, expect, test } from "bun:test";
import { isRootPathString } from "./pathRoot";

// #5924: every root spelling that a project key or a resolved path can take.
describe("isRootPathString", () => {
  const windowsRoots = [
    // POSIX root, and the root of the current drive on Windows.
    "/",
    "//",
    "\\",
    // Drive roots.
    "C:",
    "C:\\",
    "c:/",
    "C:\\\\",
    // UNC server and share roots.
    "\\\\srv",
    "\\\\srv\\share",
    "\\\\srv\\share\\",
    "//srv/share/",
    // Namespaced drive roots.
    "\\\\?\\C:\\",
    "\\\\.\\C:",
    // Namespaced UNC roots: path.win32 reports their root as "\\\\?\\UNC\\" only.
    "\\\\?\\UNC\\",
    "\\\\?\\UNC\\srv",
    "\\\\?\\UNC\\srv\\share",
    "\\\\?\\unc\\srv\\share\\",
    "\\\\.\\UNC\\srv\\share",
    // Other device names: one segment after the prefix.
    "\\\\?\\Volume{0b5c6c7e-0000-0000-0000-100000000000}\\",
    "\\\\.\\PhysicalDrive0\\",
    "\\\\?\\",
  ];

  const windowsNonRoots = [
    "",
    "C:\\a",
    // Drive-relative: a folder on drive C, not its root.
    "C:a",
    "1:\\",
    // A POSIX directory named ":".
    "/:",
    "/home/u/repo",
    "\\\\srv\\share\\a",
    "//srv//share",
    "\\\\?\\C:\\repo",
    "\\\\?\\UNC\\srv\\share\\repo",
    "\\\\.\\UNC\\srv\\share\\a\\b",
    "\\\\?\\Volume{0b5c6c7e-0000-0000-0000-100000000000}\\repo",
    "repo",
  ];

  test("classifies Windows and POSIX spellings with the win32 rules", () => {
    for (const root of windowsRoots)
      expect([root, isRootPathString(root, "win32")]).toEqual([root, true]);
    for (const nonRoot of windowsNonRoots) {
      expect([nonRoot, isRootPathString(nonRoot, "win32")]).toEqual([nonRoot, false]);
    }
  });

  // On POSIX a backslash is an ordinary file-name character, so "/\\?\\C:\\" is a directory.
  test("treats only slashes as separators with the posix rules", () => {
    for (const root of ["/", "//", "///"]) expect(isRootPathString(root, "posix")).toBe(true);
    for (const nonRoot of ["", "/\\", "\\", "C:\\", "C:", "/home/u", "/\\\\?\\C:\\", "/:"]) {
      expect([nonRoot, isRootPathString(nonRoot, "posix")]).toEqual([nonRoot, false]);
    }
  });
});
