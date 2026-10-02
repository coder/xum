import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import assert from "@/common/utils/assert";
import {
  shellQuote,
  buildWrapperScript,
  buildSpawnCommand,
  buildStopCommand,
  GROUP_LIVE_FUNCTION,
  groupLiveCall,
  parseExitCode,
  parsePid,
  parseStopResult,
  SUPERVISOR_FILENAME,
  SUPERVISOR_SCRIPT,
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
    it("builds script with cd joined by &&, then the user script", () => {
      const result = buildWrapperScript({
        cwd: "/home/user/project",
        script: "echo hello",
      });

      expect(result).toBe(`cd '/home/user/project' || exit; echo hello`);
    });

    it("includes env exports", () => {
      const result = buildWrapperScript({
        cwd: "/home/user",
        env: { FOO: "bar", BAZ: "qux" },
        script: "env",
      });

      expect(result).toContain("export FOO='bar'");
      expect(result).toContain("export BAZ='qux'");
    });

    it("quotes paths with spaces", () => {
      const result = buildWrapperScript({
        cwd: "/home/user/my project",
        script: "ls",
      });

      expect(result).toContain("'/home/user/my project'");
    });

    it("escapes single quotes in env values", () => {
      const result = buildWrapperScript({
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

      // Runs the wrapper the way the supervisor does, from `root`, which stands in for the
      // spawn command's fallback cwd. The supervisor records the wrapper's exit status.
      const runWrapper = (script: string, cwd: string) => {
        const wrapper = buildWrapperScript({
          cwd,
          env: { XUM_TEST_VAR: "set" },
          script,
        });
        const child = spawnSync("bash", ["-c", wrapper], { cwd: root, encoding: "utf-8" });
        return { status: child.status, stdout: child.stdout };
      };

      it.skipIf(process.platform === "win32")(
        "a missing cwd fails the script instead of running later lines in the fallback cwd",
        () => {
          for (const command of MISSING_CWD_COMMANDS) {
            const result = runWrapper(command, path.join(root, "missing"));
            expect({ command, failed: result.status !== 0, stdout: result.stdout }).toEqual({
              command,
              failed: true,
              stdout: "",
            });
          }
        }
      );

      for (const c of MULTI_LINE_COMMAND_CASES) {
        it.skipIf(process.platform === "win32")(`keeps output and exit code: ${c.name}`, () => {
          expect(runWrapper(c.command, path.join(root, "workspace"))).toEqual({
            status: c.exitCode,
            stdout: c.stdout,
          });
        });
      }
    });
  });

  describe("buildSpawnCommand", () => {
    const base = {
      wrapperScript: "echo hello",
      outputPath: "/tmp/output.log",
      recordDir: "/tmp/rec",
      supervisorPath: "/tmp/rec/supervisor.sh",
      stopToken: "0123456789abcdef",
    };

    it("uses set -m, nohup, unified output with 2>&1, and echoes PID", () => {
      const result = buildSpawnCommand(base);

      expect(result).toMatch(/^\(set -m; nohup 'bash' -c '\. "\$0"' '\/tmp\/rec\/supervisor\.sh' /);
      expect(result).toContain("> '/tmp/output.log' 2>&1");
      expect(result).toContain("< /dev/null");
      expect(result).toContain("& echo $!)");
      // The supervisor script travels in a file: Windows' Git Bash mangled it inline.
      expect(result).not.toContain("__xum_glive");
    });

    it("uses custom bash path (including paths with spaces)", () => {
      const result = buildSpawnCommand({ ...base, bashPath: "/c/Program Files/Git/bin/bash.exe" });

      expect(result).toContain("'/c/Program Files/Git/bin/bash.exe' -c");
    });

    it("quotes the wrapper script and the record directory", () => {
      const result = buildSpawnCommand({
        ...base,
        wrapperScript: "echo 'hello world'",
        recordDir: "/tmp/my dir",
      });

      expect(result).toContain("'/tmp/my dir' 0123456789abcdef 'echo '\"'\"'hello world'\"'\"'' >");
    });

    it("rejects a stop token that is not generated hex", () => {
      expect(() => buildSpawnCommand({ ...base, stopToken: "../x" })).toThrow();
      expect(() => buildStopCommand(1234, "/tmp/rec", "a b")).toThrow();
    });

    it("rejects process group ids that would address every process", () => {
      expect(() => buildStopCommand(1, "/tmp/rec", base.stopToken)).toThrow();
      expect(() => groupLiveCall(0)).toThrow();
    });
  });

  describe("parseStopResult", () => {
    it("reads the outcome after an SSH banner and never invents an exit code", () => {
      expect(parseStopResult("banner\n__XUM_BG_STOP__ confirmed 3\n")).toEqual({
        confirmed: true,
        exitCode: 3,
      });
      expect(parseStopResult("__XUM_BG_STOP__ confirmed none\n")).toEqual({
        confirmed: true,
        exitCode: null,
      });
      expect(parseStopResult("__XUM_BG_STOP__ unconfirmed 3\n")).toEqual({ confirmed: false });
      expect(parseStopResult("")).toEqual({ confirmed: false });
    });
  });

  describe.skipIf(process.platform !== "linux")("GROUP_LIVE_FUNCTION", () => {
    // A group that answers `kill -0` but has no member in /proc: is it gone? Only when /proc
    // shows every process. The mount table is read from a copy, `kill` is stubbed to succeed.
    const verdict = async (mountOptions: string) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glive-"));
      try {
        const mountinfo = path.join(dir, "mountinfo");
        await fs.writeFile(
          mountinfo,
          `25 30 0:23 / /proc rw shared:13 - proc proc ${mountOptions}\n`
        );
        const dead = spawnSync("true").pid;
        assert(dead != null && dead > 1, "no pid");
        const fn = GROUP_LIVE_FUNCTION.replace("/proc/self/mountinfo", mountinfo);
        const result = spawnSync("bash", [
          "-c",
          `kill() { return 0; }\n${fn}\n__xum_glive ${dead}`,
        ]);
        return result.status === 0 ? "live" : "gone";
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    };

    it("fails closed when /proc hides other users' processes", async () => {
      const results: Record<string, string> = {};
      for (const options of [
        "rw,hidepid=2",
        "rw,hidepid=4",
        "rw,hidepid=ptraceable,gid=10",
        "rw,hidepid=invisible",
        "rw,subset=pid",
        "rw",
        "rw,hidepid=0",
        "rw,hidepid=off,gid=10",
      ]) {
        results[options] = await verdict(options);
      }
      expect(results).toEqual({
        "rw,hidepid=2": "live",
        "rw,hidepid=4": "live",
        "rw,hidepid=ptraceable,gid=10": "live",
        "rw,hidepid=invisible": "live",
        "rw,subset=pid": "live",
        rw: "gone",
        "rw,hidepid=0": "gone",
        "rw,hidepid=off,gid=10": "gone",
      });
    });

    it("is gone only on ESRCH from kill when nothing else is known", () => {
      const dead = spawnSync("true").pid;
      assert(dead != null && dead > 1, "no pid");
      const run = (script: string) =>
        spawnSync("bash", ["-c", `${GROUP_LIVE_FUNCTION}\n${script}`]).status;
      expect(run(`__xum_glive ${dead}`)).toBe(1);
      expect(run(`__xum_glive $(ps -o pgid= -p $$ | tr -d ' ')`)).toBe(0);
    });
  });

  // The supervisor protocol with real processes (formal/background-processes,
  // BgTerminateGroup.tla MC_group_supervisor). Signal issuance is asserted apart from exit codes:
  // BASH_ENV makes every bash involved log each `kill` call with the caller's process group.
  describe.skipIf(process.platform === "win32")("supervisor protocol (real processes)", () => {
    const TOKEN = "0123456789abcdef";
    let root: string;
    let killLog: string;
    let env: NodeJS.ProcessEnv;
    const spawned: number[] = [];

    beforeEach(async () => {
      root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bg-supervisor-")));
      killLog = path.join(root, "kills.log");
      const recorder = path.join(root, "record-kill.sh");
      await fs.writeFile(
        recorder,
        [
          "kill() {",
          `  printf '%s %s %s\\n' "$$" "$(ps -o pgid= -p $$ | tr -d ' ')" "$*" >> ${shellQuote(killLog)}`,
          '  builtin kill "$@"',
          "}",
        ].join("\n")
      );
      env = { ...process.env, BASH_ENV: recorder };
    });

    afterEach(async () => {
      // Test-only teardown of groups this test spawned that are still live.
      for (const pgid of spawned.splice(0)) {
        if (groupLive(pgid)) spawnSync("bash", ["-c", `kill -KILL -${pgid}`]);
      }
      await fs.rm(root, { recursive: true, force: true });
    });

    const run = (command: string) =>
      spawnSync("bash", ["-c", command], { encoding: "utf-8", env, cwd: root });

    const groupLive = (pgid: number) =>
      spawnSync("bash", ["-c", `${GROUP_LIVE_FUNCTION}\n${groupLiveCall(pgid)}`]).status === 0;

    const spawnSupervised = async (name: string, script: string) => {
      const dir = path.join(root, name);
      await fs.mkdir(dir);
      const supervisorPath = path.join(dir, SUPERVISOR_FILENAME);
      await fs.writeFile(supervisorPath, SUPERVISOR_SCRIPT);
      const command = buildSpawnCommand({
        wrapperScript: buildWrapperScript({ cwd: root, script }),
        outputPath: path.join(dir, "output.log"),
        recordDir: dir,
        supervisorPath,
        stopToken: TOKEN,
      });
      const pid = parsePid(run(command).stdout);
      assert(pid != null, "spawn printed no PID");
      spawned.push(pid);
      return { dir, pid };
    };

    const stop = (p: { dir: string; pid: number }) =>
      parseStopResult(run(buildStopCommand(p.pid, p.dir, TOKEN)).stdout);

    const waitUntil = async (condition: () => boolean | Promise<boolean>, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (!(await condition())) {
        if (Date.now() > deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return true;
    };

    const exitCodeFile = async (dir: string) =>
      (await fs.readFile(path.join(dir, "exit_code"), "utf-8").catch(() => null))?.trim() ?? null;

    /** Every kill call that sends a real signal, as "<caller pgid> <args>". */
    const signalsSent = async () =>
      (await fs.readFile(killLog, "utf-8").catch(() => ""))
        .split("\n")
        .map((line) => line.split(" "))
        .filter((fields) => fields.length > 2 && fields[2] !== "-0")
        .map((fields) => fields.slice(1).join(" "));

    it("records the exit code only once the group has ended; a later stop sends nothing", async () => {
      const p = await spawnSupervised("natural", "exit 3");
      expect(await waitUntil(() => !groupLive(p.pid), 5_000)).toBe(true);
      expect(await exitCodeFile(p.dir)).toBe("3");

      expect(stop(p)).toEqual({ confirmed: true, exitCode: 3 });
      expect(await signalsSent()).toEqual([]);
      expect(await fs.readdir(p.dir)).not.toContain(`stop.${TOKEN}`);
    }, 15_000);

    it("keeps a finished command running while its children live", async () => {
      const p = await spawnSupervised("linger", "sleep 3 & exit 3");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect({ live: groupLive(p.pid), code: await exitCodeFile(p.dir) }).toEqual({
        live: true,
        code: null,
      });
      expect(await waitUntil(async () => (await exitCodeFile(p.dir)) === "3", 8_000)).toBe(true);
      expect(await waitUntil(() => !groupLive(p.pid), 2_000)).toBe(true);
    }, 15_000);

    it("stops a running command from inside its group and reports its status", async () => {
      const p = await spawnSupervised("running", "sleep 30");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(stop(p)).toEqual({ confirmed: true, exitCode: 143 });
      expect(groupLive(p.pid)).toBe(false);
      const signals = await signalsSent();
      expect(signals).toEqual([`${p.pid} -TERM 0`, `${p.pid} -KILL 0`]);
    }, 20_000);

    it("keeps the command's own status when stopping lingering children", async () => {
      const p = await spawnSupervised("linger-stop", "sleep 30 & exit 3");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(stop(p)).toEqual({ confirmed: true, exitCode: 3 });
      expect(groupLive(p.pid)).toBe(false);
    }, 20_000);

    it("reports the command's own TERM handling, and 137 when only KILL ends it", async () => {
      const ownTrap = await spawnSupervised("own-trap", "trap 'exit 7' TERM; sleep 30 & wait");
      const resistant = await spawnSupervised("resistant", "trap '' TERM; sleep 30");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(stop(ownTrap)).toEqual({ confirmed: true, exitCode: 7 });
      expect(stop(resistant)).toEqual({ confirmed: true, exitCode: 137 });
      expect(groupLive(resistant.pid)).toBe(false);
    }, 30_000);

    it("never records a signal that interrupted the supervisor as the exit code", async () => {
      const p = await spawnSupervised(
        "interrupted",
        'g=$(ps -o pgid= -p $$ | tr -d " "); for i in 1 2 3 4 5 6 7 8 9 10; do kill -TERM "$g"; sleep 0.3; done; exit 5'
      );
      expect(await waitUntil(async () => (await exitCodeFile(p.dir)) !== null, 15_000)).toBe(true);
      expect(await exitCodeFile(p.dir)).toBe("5");
    }, 25_000);

    it("shares one stop between concurrent requests", async () => {
      const p = await spawnSupervised("concurrent", "sleep 30");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const command = buildStopCommand(p.pid, p.dir, TOKEN);
      const both = await Promise.all(
        [0, 1].map(
          () =>
            new Promise<string>((resolve) => {
              const child = spawn("bash", ["-c", command], { env });
              let out = "";
              child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
              child.on("close", () => resolve(out));
            })
        )
      );
      expect(both.map(parseStopResult)).toEqual([
        { confirmed: true, exitCode: 143 },
        { confirmed: true, exitCode: 143 },
      ]);
      expect(await signalsSent()).toEqual([`${p.pid} -TERM 0`, `${p.pid} -KILL 0`]);
    }, 20_000);

    it("reports unconfirmed and sends no signal when the supervisor is gone", async () => {
      const p = await spawnSupervised(
        "supervisor-killed",
        'g=$(ps -o pgid= -p $$ | tr -d " "); builtin kill -KILL "$g"; sleep 30'
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(stop(p)).toEqual({ confirmed: false });
      expect(groupLive(p.pid)).toBe(true);
      expect(await signalsSent()).toEqual([]);
    }, 20_000);

    it("ignores forged records and stop requests with another token", async () => {
      const p = await spawnSupervised("forged", "sleep 30");
      // Anything the user can run can write here: a fake exit code, a replaced control FIFO
      // nobody reads, and a stop request carrying another token.
      await fs.writeFile(path.join(p.dir, "exit_code"), "0\n");
      expect(run(`cd ${shellQuote(p.dir)} && rm -f ctl && mkfifo ctl`).status).toBe(0);
      await fs.mkdir(path.join(p.dir, "stop.ffffffffffffffff"));
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(groupLive(p.pid)).toBe(true);

      expect(stop(p)).toEqual({ confirmed: true, exitCode: 143 });
      expect(groupLive(p.pid)).toBe(false);
    }, 20_000);
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
