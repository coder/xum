import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { getBashPath, getBashPathForPlatform, resetBashPathCache } from "./bashPath";

describe("getBashPath (Unix)", () => {
  let tempDir: string;

  beforeEach(async () => {
    resetBashPathCache();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-bash-path-test-"));
  });

  afterEach(async () => {
    resetBashPathCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("resolves the first executable bash on PATH to an absolute path and caches it", async () => {
    const fakeBash = path.join(tempDir, "bash");
    await fs.writeFile(fakeBash, "#!/bin/sh\n", { mode: 0o755 });
    const missingDir = path.join(tempDir, "missing");
    const env = { PATH: [missingDir, tempDir].join(path.delimiter) };

    expect(getBashPath({ platform: "linux", env })).toBe(fakeBash);

    // Cached: a different PATH on a later call does not trigger re-resolution.
    expect(getBashPath({ platform: "linux", env: { PATH: "" } })).toBe(fakeBash);
  });

  it.skipIf(process.platform === "win32")("skips non-executable bash files on PATH", async () => {
    const nonExecDir = path.join(tempDir, "nonexec");
    const execDir = path.join(tempDir, "exec");
    await fs.mkdir(nonExecDir);
    await fs.mkdir(execDir);
    await fs.writeFile(path.join(nonExecDir, "bash"), "", { mode: 0o644 });
    const fakeBash = path.join(execDir, "bash");
    await fs.writeFile(fakeBash, "#!/bin/sh\n", { mode: 0o755 });

    const env = { PATH: [nonExecDir, execDir].join(path.delimiter) };
    expect(getBashPath({ platform: "linux", env })).toBe(fakeBash);
  });

  it("falls back when bash is not on PATH", async () => {
    const hasBinBash = await fs
      .access("/bin/bash")
      .then(() => true)
      .catch(() => false);
    const result = getBashPath({ platform: "linux", env: { PATH: path.join(tempDir, "empty") } });
    expect(result).toBe(hasBinBash ? "/bin/bash" : "bash");
  });
});

describe("getBashPathForPlatform (Windows)", () => {
  it("skips WSL launcher when it is first in PATH", () => {
    const execSyncFn = (command: string) => {
      if (command === "where git") {
        throw new Error("git not in PATH");
      }

      if (command === "where bash") {
        return ["C:\\Windows\\System32\\bash.exe", "D:\\Custom\\Git\\usr\\bin\\bash.exe"].join(
          "\r\n"
        );
      }

      throw new Error(`unexpected command: ${command}`);
    };

    const existing = new Set<string>([
      "C:\\Windows\\System32\\bash.exe",
      "D:\\Custom\\Git\\usr\\bin\\bash.exe",
      "D:\\Custom\\Git\\cmd\\git.exe",
    ]);

    const existsSyncFn = (p: unknown) => existing.has(String(p));

    expect(
      getBashPathForPlatform({
        platform: "win32",
        env: {},
        execSyncFn,
        existsSyncFn,
      })
    ).toBe("D:\\Custom\\Git\\usr\\bin\\bash.exe");
  });

  it("throws when only WSL bash is available", () => {
    const execSyncFn = (command: string) => {
      if (command === "where git") {
        throw new Error("git not in PATH");
      }

      if (command === "where bash") {
        return "C:\\Windows\\System32\\bash.exe\r\n";
      }

      throw new Error(`unexpected command: ${command}`);
    };

    const existing = new Set<string>(["C:\\Windows\\System32\\bash.exe"]);
    const existsSyncFn = (p: unknown) => existing.has(String(p));

    expect(() =>
      getBashPathForPlatform({
        platform: "win32",
        env: {},
        execSyncFn,
        existsSyncFn,
      })
    ).toThrow(/WSL is not supported/);
  });
});

describe("getBashPath (Windows)", () => {
  beforeEach(() => {
    resetBashPathCache();
  });

  it("caches failures to avoid repeated `where` probes", () => {
    let execCalls = 0;
    const execSyncFn = () => {
      execCalls++;
      throw new Error("not in PATH");
    };

    const existsSyncFn = () => false;
    const nowFn = () => 0;

    expect(() =>
      getBashPath({
        platform: "win32",
        env: {},
        execSyncFn,
        existsSyncFn,
        nowFn,
      })
    ).toThrow(/Git Bash not found/);

    const callsAfterFirst = execCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    expect(() =>
      getBashPath({
        platform: "win32",
        env: {},
        execSyncFn,
        existsSyncFn,
        nowFn,
      })
    ).toThrow(/Git Bash not found/);

    expect(execCalls).toBe(callsAfterFirst);
  });
});
