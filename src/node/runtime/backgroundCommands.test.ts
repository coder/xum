import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { execSync, spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  shellQuote,
  buildWrapperScript,
  buildSpawnCommand,
  buildTerminateCommand,
  parseExitCode,
  parsePid,
} from "./backgroundCommands";
import { MISSING_CWD_COMMANDS, MULTI_LINE_COMMAND_CASES } from "./testRemoteRuntime";

describe("backgroundCommands", () => {
  describe("shellQuote", () => {
    it("quotes empty string", () => {
      expect(shellQuote("")).toBe("''");
    });

    it("quotes simple strings and paths", () => {
      expect(shellQuote("hello")).toBe("'hello'");
      expect(shellQuote("/path/with spaces/file")).toBe("'/path/with spaces/file'");
    });

    it("escapes single quotes", () => {
      expect(shellQuote("it's")).toBe("'it'\"'\"'s'");
      expect(shellQuote("it's a 'test'")).toBe("'it'\"'\"'s a '\"'\"'test'\"'\"''");
    });

    it("preserves special characters inside quotes", () => {
      expect(shellQuote("$HOME")).toBe("'$HOME'");
      expect(shellQuote("a && b")).toBe("'a && b'");
      expect(shellQuote("foo\nbar")).toBe("'foo\nbar'");
    });
  });

  describe("buildWrapperScript", () => {
    it("builds script with trap and cd joined by &&, then the user script", () => {
      const result = buildWrapperScript({
        exitCodePath: "/tmp/exit_code",
        cwd: "/home/user/project",
        script: "echo hello",
      });

      expect(result).toBe(
        `__MUX_EXIT_CODE_PATH='/tmp/exit_code' && trap 'echo $? > "$__MUX_EXIT_CODE_PATH"' EXIT && cd '/home/user/project' || exit; echo hello`
      );
    });

    it("includes env exports", () => {
      const result = buildWrapperScript({
        exitCodePath: "/tmp/exit_code",
        cwd: "/home/user",
        env: { FOO: "bar", BAZ: "qux" },
        script: "env",
      });

      expect(result).toContain("export FOO='bar'");
      expect(result).toContain("export BAZ='qux'");
    });

    it("quotes paths with spaces", () => {
      const result = buildWrapperScript({
        exitCodePath: "/tmp/my dir/exit_code",
        cwd: "/home/user/my project",
        script: "ls",
      });

      expect(result).toContain("'/tmp/my dir/exit_code'");
      expect(result).toContain("'/home/user/my project'");
    });

    it("produces valid bash when exit code path contains spaces", async () => {
      // Regression test: spaces in process ID (display_name) caused invalid trap syntax
      // The trap command needs to properly nest quoted paths
      const testDir = `/tmp/PR Checks ${Date.now()}`;
      const exitCodePath = `${testDir}/exit_code`;

      const result = buildWrapperScript({
        exitCodePath,
        cwd: "/tmp",
        script: "exit 42",
      });

      // The wrapper script should be valid bash - execute it and verify exit code is captured
      await fs.mkdir(testDir, { recursive: true });
      // Ensure no stale file
      await fs.rm(exitCodePath, { force: true });

      try {
        execSync(`bash -c ${shellQuote(result)}`, { stdio: "pipe" });
      } catch {
        // Expected - script exits with 42
      }

      // The exit code file MUST exist if the trap worked correctly
      const exitCode = await fs.readFile(exitCodePath, "utf-8");
      expect(exitCode.trim()).toBe("42");

      await fs.rm(testDir, { recursive: true });
    });

    it("escapes single quotes in env values", () => {
      const result = buildWrapperScript({
        exitCodePath: "/tmp/exit_code",
        cwd: "/home",
        env: { MSG: "it's a test" },
        script: "echo $MSG",
      });

      expect(result).toContain("export MSG='it'\"'\"'s a test'");
    });

    describe("multi-line scripts", () => {
      let root: string;

      beforeEach(async () => {
        root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bg-wrapper-lines-")));
        await fs.mkdir(path.join(root, "workspace"));
      });

      afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
      });

      // Runs the wrapper the way buildSpawnCommand does, from `root`, which stands in for the
      // spawn command's fallback cwd.
      const runWrapper = async (script: string, cwd: string) => {
        const exitCodePath = path.join(root, "exit_code");
        const wrapper = buildWrapperScript({
          exitCodePath,
          cwd,
          env: { XUM_TEST_VAR: "set" },
          script,
        });
        const child = spawnSync("bash", ["-c", wrapper], { cwd: root, encoding: "utf-8" });
        const recorded = await fs.readFile(exitCodePath, "utf-8");
        return { status: child.status, stdout: child.stdout, recorded: recorded.trim() };
      };

      it.skipIf(process.platform === "win32")(
        "a missing cwd fails the script instead of running later lines in the fallback cwd",
        async () => {
          for (const command of MISSING_CWD_COMMANDS) {
            const result = await runWrapper(command, path.join(root, "missing"));
            expect({
              command,
              failed: result.status !== 0,
              recordedFailure: result.recorded !== "0",
              stdout: result.stdout,
            }).toEqual({ command, failed: true, recordedFailure: true, stdout: "" });
          }
        }
      );

      for (const c of MULTI_LINE_COMMAND_CASES) {
        it.skipIf(process.platform === "win32")(
          `keeps output and exit code: ${c.name}`,
          async () => {
            const result = await runWrapper(c.command, path.join(root, "workspace"));
            expect(result).toEqual({
              status: c.exitCode,
              stdout: c.stdout,
              recorded: String(c.exitCode),
            });
          }
        );
      }
    });
  });

  describe("buildSpawnCommand", () => {
    it("uses set -m, nohup, unified output with 2>&1, and echoes PID", () => {
      const result = buildSpawnCommand({
        wrapperScript: "echo hello",
        outputPath: "/tmp/output.log",
      });

      expect(result).toMatch(/^\(set -m; nohup 'bash' -c /);
      expect(result).toContain("> '/tmp/output.log' 2>&1");
      expect(result).toContain("< /dev/null");
      expect(result).toContain("& echo $!)");
    });

    it("uses custom bash path (including paths with spaces)", () => {
      const result = buildSpawnCommand({
        wrapperScript: "echo hello",
        outputPath: "/tmp/output.log",
        bashPath: "/c/Program Files/Git/bin/bash.exe",
      });

      expect(result).toContain("'/c/Program Files/Git/bin/bash.exe' -c");
    });

    it("quotes the wrapper script", () => {
      const result = buildSpawnCommand({
        wrapperScript: "echo 'hello world'",
        outputPath: "/tmp/output.log",
      });

      expect(result).toContain("-c 'echo '\"'\"'hello world'\"'\"''");
    });
  });

  describe("buildTerminateCommand", () => {
    it("sends SIGTERM then SIGKILL to process group using negative PID", () => {
      const result = buildTerminateCommand(1234, "/tmp/exit_code");

      expect(result).toContain("kill -15 -1234 2>/dev/null || true");
      expect(result).toContain("sleep 2");
      expect(result).toContain("kill -0 -1234");
      expect(result).toContain("kill -9 -1234 2>/dev/null || true");
      expect(result).toContain("echo 137 >"); // SIGKILL exit code
      expect(result).toContain("echo 143 >"); // SIGTERM exit code (written after process exits)
    });

    it("quotes exit code path with spaces", () => {
      const result = buildTerminateCommand(1234, "/tmp/my dir/exit_code");

      expect(result).toContain("'/tmp/my dir/exit_code'");
    });

    it("uses custom quotePath function for SSH tilde expansion", () => {
      const expandTilde = (p: string) => (p.startsWith("~/") ? `"$HOME/${p.slice(2)}"` : `"${p}"`);
      const result = buildTerminateCommand(1234, "~/mux/exit_code", expandTilde);

      expect(result).toContain('"$HOME/mux/exit_code"');
    });
  });

  describe("parseExitCode", () => {
    it("parses valid exit codes with whitespace", () => {
      expect(parseExitCode("0")).toBe(0);
      expect(parseExitCode("  137\n")).toBe(137);
      expect(parseExitCode("\t42\t")).toBe(42);
    });

    it("returns null for empty or non-numeric input", () => {
      expect(parseExitCode("")).toBeNull();
      expect(parseExitCode("   ")).toBeNull();
      expect(parseExitCode("abc")).toBeNull();
    });
  });

  describe("parsePid", () => {
    it("parses valid PID with whitespace", () => {
      expect(parsePid("1234")).toBe(1234);
      expect(parsePid("  1234\n")).toBe(1234);
    });

    it("returns null for invalid input", () => {
      expect(parsePid("")).toBeNull();
      expect(parsePid("   ")).toBeNull();
      expect(parsePid("abc")).toBeNull();
      expect(parsePid("-1")).toBeNull();
      expect(parsePid("0")).toBeNull();
    });
  });
});
