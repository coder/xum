import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { findExecutableOnPath } from "./findExecutableOnPath";

const isWindows = process.platform === "win32";
const TOOL = "xum-find-exe-tool";

let rootDir: string;

beforeEach(async () => {
  rootDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "find-exe-on-path-")));
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

async function makeDir(name: string): Promise<string> {
  const dir = path.join(rootDir, name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Writes a file the platform treats as an executable named TOOL and returns its path. */
async function writeTool(dir: string): Promise<string> {
  const filePath = path.join(dir, isWindows ? `${TOOL}.exe` : TOOL);
  await fs.writeFile(filePath, "#!/bin/sh\nexit 0\n");
  if (!isWindows) await fs.chmod(filePath, 0o755);
  return filePath;
}

function find(pathValue: string | undefined, cwd: string): string | null {
  return findExecutableOnPath(TOOL, { env: { PATH: pathValue }, cwd });
}

describe("findExecutableOnPath", () => {
  test("returns the first match in PATH order, skipping directories that lack it", async () => {
    const cwd = await makeDir("cwd");
    const missDir = await makeDir("miss");
    const firstDir = await makeDir("first");
    const secondDir = await makeDir("second");
    const expected = await writeTool(firstDir);
    await writeTool(secondDir);

    expect(find([missDir, firstDir, secondDir].join(path.delimiter), cwd)).toBe(expected);
    expect(find([missDir, secondDir, firstDir].join(path.delimiter), cwd)).toBe(
      path.join(secondDir, path.basename(expected))
    );
  });

  test("returns null when no PATH entry has the executable, or PATH is empty or unset", async () => {
    const cwd = await makeDir("cwd");
    const missDir = await makeDir("miss");

    expect(find(missDir, cwd)).toBeNull();
    // Even with the tool in cwd, an empty or unset PATH searches no directories on POSIX.
    if (!isWindows) {
      await writeTool(cwd);
      expect(find("", cwd)).toBeNull();
      expect(find(undefined, cwd)).toBeNull();
    }
  });

  test.skipIf(isWindows)(
    "skips non-executable files and directories with the same name",
    async () => {
      const cwd = await makeDir("cwd");
      const nonExecutableDir = await makeDir("non-executable");
      await fs.writeFile(path.join(nonExecutableDir, TOOL), "#!/bin/sh\n");
      await fs.chmod(path.join(nonExecutableDir, TOOL), 0o644);
      const directoryDir = await makeDir("directory");
      await fs.mkdir(path.join(directoryDir, TOOL));
      const realDir = await makeDir("real");
      const expected = await writeTool(realDir);

      expect(find([nonExecutableDir, directoryDir].join(":"), cwd)).toBeNull();
      expect(find([nonExecutableDir, directoryDir, realDir].join(":"), cwd)).toBe(expected);
    }
  );

  test.skipIf(isWindows)(
    "resolves relative and empty PATH entries against cwd to absolute paths",
    async () => {
      const relativeBin = await makeDir("rel-bin");
      const expectedRelative = await writeTool(relativeBin);
      expect(find("rel-bin", rootDir)).toBe(expectedRelative);

      const cwd = await makeDir("cwd");
      const expectedCwd = await writeTool(cwd);
      // A leading empty entry means the current directory, like execvp.
      expect(find(`:${await makeDir("miss")}`, cwd)).toBe(expectedCwd);
    }
  );

  test.if(isWindows)("tries PATHEXT extensions in order within a directory", async () => {
    const cwd = await makeDir("cwd");
    const binDir = await makeDir("bin");
    await fs.writeFile(path.join(binDir, `${TOOL}.cmd`), "@echo off\r\n");
    await fs.writeFile(path.join(binDir, `${TOOL}.exe`), "");

    expect(find(binDir, cwd)?.toLowerCase()).toBe(path.join(binDir, `${TOOL}.exe`).toLowerCase());
    expect(
      findExecutableOnPath(TOOL, { env: { PATH: binDir, PATHEXT: ".CMD;.EXE" }, cwd })?.toLowerCase()
    ).toBe(path.join(binDir, `${TOOL}.cmd`).toLowerCase());
  });

  test.if(isWindows)("searches the current directory before PATH, like where.exe", async () => {
    const cwd = await makeDir("cwd");
    const binDir = await makeDir("bin");
    await writeTool(binDir);
    const expected = await writeTool(cwd);

    expect(find(binDir, cwd)?.toLowerCase()).toBe(expected.toLowerCase());
  });
});
