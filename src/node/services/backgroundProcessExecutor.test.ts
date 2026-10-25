import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { BackgroundHandle } from "@/node/runtime/Runtime";
import { shellQuote } from "@/node/runtime/backgroundCommands";
import { ExecPathMappingRuntime } from "./testExecPathMappingRuntime";
import { BG_EXIT_CODE_FILENAME, spawnProcess } from "./backgroundProcessExecutor";

/**
 * Delegates to a real LocalRuntime but is NOT an instanceof LocalBaseRuntime, so
 * spawnProcess treats it like a remote runtime. With `throwOnSpawn`, its exec throws for the
 * spawn command itself, simulating a transport-level (SSH/Coder channel) error after dispatch.
 * `beforeTail.script` runs right before each `tail -c` read (after the size probe), with `{}`
 * replaced by the quoted output.log path.
 */
function createRemoteLikeRuntime(
  base: LocalRuntime,
  throwOnSpawn = false,
  beforeTail?: { script?: string }
): LocalRuntime {
  return new Proxy({} as LocalRuntime, {
    get(_target, prop) {
      if (prop === "exec") {
        return (command: string, opts: never) => {
          if (throwOnSpawn && command.includes("output.log")) {
            throw new Error("SSH channel error after dispatch");
          }
          const tailPath = /tail -c \+\d+ ('[^']+')/.exec(command)?.[1];
          if (beforeTail?.script != null && tailPath != null) {
            return base.exec(`${beforeTail.script.replaceAll("{}", tailPath)}; ${command}`, opts);
          }
          return base.exec(command, opts);
        };
      }
      const value = (base as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(base)
        : value;
    },
  });
}

async function waitForExit(handle: BackgroundHandle): Promise<number | null> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const exitCode = await handle.getExitCode();
    if (exitCode !== null) return exitCode;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

describe("spawnProcess", () => {
  const cleanupDirs: string[] = [];
  const handles: BackgroundHandle[] = [];

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.terminate()));
    await Promise.all(
      cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  it("preserves the output directory when a remote-like exec throws after dispatch", async () => {
    const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-remote-throw-"));
    cleanupDirs.push(hostDir);
    const base = new LocalRuntime(hostDir);
    const tempDir = await base.tempDir();
    const workspaceId = `remote-throw-${Date.now()}`;
    cleanupDirs.push(`${tempDir}/mux-bashes/${workspaceId}`);

    const result = await spawnProcess(createRemoteLikeRuntime(base, true), "echo hi", {
      cwd: hostDir,
      workspaceId,
      processId: "ambiguous",
    });

    expect(result.success).toBe(false);
    // A transport-level throw after dispatch is ambiguous on non-local runtimes — the
    // detached job may be running. The directory must survive as durable fail-closed
    // evidence (remote crash-orphan gating consumes these records; see #3944). Local
    // runtimes still remove theirs: local exec throws happen before anything dispatched.
    await fs.access(`${tempDir}/mux-bashes/${workspaceId}/ambiguous/output.log`);
  });

  it("removes a record directory on cwd failure only when the caller claimed it", async () => {
    const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-cwd-claim-"));
    cleanupDirs.push(hostDir);
    const runtime = new LocalRuntime(hostDir);
    const workspaceId = `cwd-claim-${Date.now()}`;
    const workspaceDir = `${await runtime.tempDir()}/mux-bashes/${workspaceId}`;
    cleanupDirs.push(workspaceDir);
    const recordDir = (name: string) => path.join(workspaceDir, name);
    // An existing record the caller did not claim (e.g. another backend's) must survive.
    await fs.mkdir(recordDir("existing"), { recursive: true });
    await fs.writeFile(path.join(recordDir("existing"), "output.log"), "kept");
    await fs.mkdir(recordDir("claimed"), { recursive: true });

    for (const [processId, recordDirClaimed] of [
      ["existing", false],
      ["claimed", true],
    ] as const) {
      const result = await spawnProcess(runtime, "echo hi", {
        cwd: path.join(hostDir, "missing"),
        workspaceId,
        processId,
        recordDirClaimed,
      });
      expect(result.success).toBe(false);
    }

    expect(await fs.readFile(path.join(recordDir("existing"), "output.log"), "utf-8")).toBe("kept");
    expect(await fs.stat(recordDir("claimed")).catch(() => null)).toBeNull();
  });

  it("removes a claimed record directory when the cwd check throws", async () => {
    const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-cwd-throw-"));
    cleanupDirs.push(hostDir);
    const base = new LocalRuntime(hostDir);
    const workspaceId = `cwd-throw-${Date.now()}`;
    const recordDir = `${await base.tempDir()}/mux-bashes/${workspaceId}/claimed`;
    cleanupDirs.push(path.dirname(recordDir));
    await fs.mkdir(recordDir, { recursive: true });
    // Transport error on the cwd check only (the only command that starts with printf).
    const runtime = new Proxy({} as LocalRuntime, {
      get(_target, prop) {
        if (prop === "exec") {
          return (command: string, opts: never) => {
            if (command.startsWith("printf")) throw new Error("SSH channel error");
            return base.exec(command, opts);
          };
        }
        const value = (base as unknown as Record<PropertyKey, unknown>)[prop];
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(base)
          : value;
      },
    });

    let threw = false;
    try {
      await spawnProcess(runtime, "echo hi", {
        cwd: hostDir,
        workspaceId,
        processId: "claimed",
        recordDirClaimed: true,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(await fs.stat(recordDir).catch(() => null)).toBeNull();
  });

  it("runs the wrapper from the cwd mapped into the exec namespace", async () => {
    const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-exec-host-"));
    const execDir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-exec-container-"));
    const resultDir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-exec-result-"));
    cleanupDirs.push(hostDir, execDir, resultDir);

    const outFile = path.join(resultDir, "pwd.txt");
    const runtime = new ExecPathMappingRuntime(hostDir, hostDir, execDir);
    const result = await spawnProcess(runtime, `pwd > ${shellQuote(outFile)}`, {
      cwd: hostDir,
      workspaceId: `mapped-cwd-${Date.now()}`,
      processId: "pwd",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    handles.push(result.handle);
    cleanupDirs.push(result.outputDir);

    expect(await waitForExit(result.handle)).toBe(0);
    expect((await fs.readFile(outFile, "utf8")).trim()).toBe(execDir);
  });

  it("pathEnv values win over colliding caller env in background wrappers", async () => {
    const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-pathenv-collision-"));
    const resultDir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-pathenv-result-"));
    cleanupDirs.push(hostDir, resultDir);

    const outFile = path.join(resultDir, "value.txt");
    const result = await spawnProcess(
      new LocalRuntime(hostDir),
      `printf %s "$XUM_TEST_TOOLENV" > ${shellQuote(outFile)}`,
      {
        cwd: hostDir,
        workspaceId: `pathenv-collision-${Date.now()}`,
        processId: "collision",
        env: { XUM_TEST_TOOLENV: "/wrong/value" },
        pathEnv: { XUM_TEST_TOOLENV: "/right/value" },
      }
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    handles.push(result.handle);
    cleanupDirs.push(result.outputDir);

    expect(await waitForExit(result.handle)).toBe(0);
    expect((await fs.readFile(outFile, "utf8")).trim()).toBe("/right/value");
  });

  it("probes local records with fs instead of spawning a shell per poll", async () => {
    const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-local-probe-"));
    cleanupDirs.push(hostDir);
    const runtime = new LocalRuntime(hostDir);
    const result = await spawnProcess(
      runtime,
      "printf 'one\\ntwo\\n'; sleep 0.3; printf 'three\\n'",
      {
        cwd: hostDir,
        workspaceId: `local-probe-${Date.now()}`,
        processId: "local-probe",
      }
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    handles.push(result.handle);
    cleanupDirs.push(result.outputDir);

    // Monitors tick every 100ms on local runtimes; each shell probe forks the main process, so
    // the local read path must not touch runtime.exec at all.
    const execSpy = spyOn(runtime, "exec");
    try {
      let offset = 0;
      let content = "";
      let exitCode: number | null = null;
      for (let attempt = 0; attempt < 200 && exitCode === null; attempt++) {
        const read = await result.handle.readOutputForMonitor!(offset);
        expect(read.success).toBe(true);
        if (read.success) {
          content += read.value.content;
          offset = read.value.newOffset;
        }
        const exit = await result.handle.getExitCodeForMonitor!();
        expect(exit.success).toBe(true);
        if (exit.success) exitCode = exit.value;
        if (exitCode === null) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // Drain the bytes written between the last read and the exit marker.
      const finalRead = await result.handle.readOutput(offset);
      content += finalRead.content;

      expect(exitCode).toBe(0);
      expect(content).toBe("one\ntwo\nthree\n");
      expect(await result.handle.getOutputFileSize()).toBe(Buffer.byteLength(content));
      expect(execSpy).not.toHaveBeenCalled();
    } finally {
      execSpy.mockRestore();
    }
  });

  it("fails the local strict probes when the output file is removed", async () => {
    const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-local-missing-"));
    cleanupDirs.push(hostDir);
    const result = await spawnProcess(new LocalRuntime(hostDir), "echo hi", {
      cwd: hostDir,
      workspaceId: `local-missing-${Date.now()}`,
      processId: "missing",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    handles.push(result.handle);
    cleanupDirs.push(result.outputDir);
    expect(await waitForExit(result.handle)).toBe(0);

    await fs.rm(path.join(result.outputDir, "output.log"));
    const probe = await result.handle.readOutputForMonitor?.(0);
    expect(probe?.success).toBe(false);
  });

  it("fails the strict exit probe when the exit marker is a dangling symlink", async () => {
    const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-dangling-marker-"));
    cleanupDirs.push(hostDir);
    const result = await spawnProcess(new LocalRuntime(hostDir), "echo hi", {
      cwd: hostDir,
      workspaceId: `dangling-marker-${Date.now()}`,
      processId: "dangling",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    handles.push(result.handle);
    cleanupDirs.push(result.outputDir);
    expect(await waitForExit(result.handle)).toBe(0);

    const markerPath = path.join(result.outputDir, BG_EXIT_CODE_FILENAME);
    await fs.rm(markerPath);
    await fs.symlink(path.join(result.outputDir, "missing-target"), markerPath);

    // -e follows the link and reports the occupied path as absent; the strict probe must
    // fail (feeding monitor retirement) rather than report a still-running process forever.
    const probe = await result.handle.getExitCodeForMonitor?.();
    expect(probe?.success).toBe(false);
  });

  /**
   * Spawns a script that creates $READY_FILE once its traps and children are in place, and waits
   * for it: a stop that lands while bash is still starting its first child would test startup.
   */
  async function spawnLive(script: string, tag: string) {
    const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), `bg-${tag}-`));
    cleanupDirs.push(hostDir);
    const readyFile = path.join(hostDir, "ready");
    const runtime = new LocalRuntime(hostDir);
    const result = await spawnProcess(runtime, script, {
      cwd: hostDir,
      workspaceId: `${tag}-${Date.now()}`,
      processId: tag,
      env: { READY_FILE: readyFile },
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    handles.push(result.handle);
    cleanupDirs.push(result.outputDir);
    const ready = () =>
      fs.access(readyFile).then(
        () => true,
        () => false
      );
    for (let attempt = 0; attempt < 500; attempt++) {
      if (await ready()) return { result, runtime };
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`${tag}: the script never became ready`);
  }

  function groupAlive(pgid: number): boolean {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it("concurrent terminate calls share one kill sequence", async () => {
    const { result, runtime } = await spawnLive(
      'sleep 30 & : > "$READY_FILE"; wait',
      "terminate-once"
    );

    const execSpy = spyOn(runtime, "exec");
    try {
      // task_stop and the timeout timer can both reach a running process's handle.
      await Promise.all([result.handle.terminate(), result.handle.terminate()]);
      await result.handle.terminate();
      const killSequences = execSpy.mock.calls.filter(([command]) => command.includes("kill -15"));
      expect(killSequences).toHaveLength(1);
    } finally {
      execSpy.mockRestore();
    }
    // Recorded by the wrapper's TERM trap (bash alone would record 0).
    expect(await result.handle.getExitCode()).toBe(143);
  });

  it("a stop keeps the exit code the script's own TERM trap recorded", async () => {
    const { result } = await spawnLive(
      'trap "exit 7" TERM; sleep 30 & : > "$READY_FILE"; wait',
      "own-term-trap"
    );
    await result.handle.terminate();
    // The kill command publishes 143 only when no exit_code exists.
    expect(await result.handle.getExitCode()).toBe(7);
  });

  it("a member that ignores SIGTERM is killed after the wrapper recorded its exit", async () => {
    const { result } = await spawnLive(
      `sh -c 'trap "" TERM; : > "$READY_FILE"; exec sleep 30' & wait`,
      "ignores-term"
    );
    await result.handle.terminate();
    // The wrapper's TERM trap recorded 143, but the member kept the group alive, so the
    // escalation sent SIGKILL and kept the recorded code.
    expect(await result.handle.getExitCode()).toBe(143);
    // Killed members can stay visible as zombies until their reaper collects them.
    for (let attempt = 0; attempt < 200 && groupAlive(result.pid); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(groupAlive(result.pid)).toBe(false);
  });

  describe("bounded output reads", () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    // Every kind of byte a page edge can cut: multi-byte characters, invalid bytes, a truncated
    // sequence, and lines that start with a byte-order mark.
    const raw = Buffer.concat(
      Array.from({ length: 300 }, (_, i) =>
        Buffer.concat([
          i % 3 === 0 ? bom : Buffer.alloc(0),
          Buffer.from(`${i} é€😀`.repeat((i % 7) + 1)),
          Buffer.from([0xff, 0xe2, 0x82]),
          Buffer.from("\n"),
        ])
      )
    );
    const decode = (bytes: Buffer) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);

    async function spawnWithLog(
      kind: "local" | "remote",
      log: Buffer,
      beforeTail?: { script?: string }
    ) {
      const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-bounded-read-"));
      cleanupDirs.push(hostDir);
      const base = new LocalRuntime(hostDir);
      const runtime = kind === "local" ? base : createRemoteLikeRuntime(base, false, beforeTail);
      const result = await spawnProcess(runtime, "sleep 60", {
        cwd: hostDir,
        workspaceId: `bounded-read-${kind}-${Date.now()}`,
        processId: "bounded-read",
      });
      if (!result.success) throw new Error(result.error);
      handles.push(result.handle);
      cleanupDirs.push(result.outputDir);
      const outputPath = path.join(result.outputDir, "output.log");
      await fs.appendFile(outputPath, log);
      return Object.assign(result.handle, { outputPath });
    }

    it.each(["local", "remote"] as const)(
      "reads %s output in bounded pages that decode to the whole log",
      async (kind) => {
        const handle = await spawnWithLog(kind, raw);
        let offset = 0;
        let text = "";
        for (let attempt = 0; attempt < 1_000 && offset < raw.length; attempt++) {
          const read = await handle.readOutput(offset, 1_000);
          // One page, plus at most 3 bytes to finish a character cut at its end.
          expect(read.newOffset - offset).toBeGreaterThanOrEqual(1);
          expect(read.newOffset - offset).toBeLessThanOrEqual(1_003);
          expect(read.fileSize).toBe(raw.length);
          text += read.content;
          offset = read.newOffset;
        }
        expect(offset).toBe(raw.length);
        expect(text).toBe(decode(raw));
      }
    );

    // A decoder strips U+FEFF at the start of its input as a byte-order mark, and the offset
    // came from the decoded size: the 3 bytes went missing and then came back on the next read.
    it("keeps a byte-order mark at the start of a remote read", async () => {
      const log = Buffer.concat([Buffer.from("a\n"), bom, Buffer.from("b\n")]);
      const handle = await spawnWithLog("remote", log);
      const read = await handle.readOutput(2);
      expect(read.content).toBe("\uFEFFb\n");
      expect(read.newOffset).toBe(log.length);
    });

    // The read pipes tail into head, and a pipeline exits with head's status. A log that turns
    // unreadable after the size probe (here a directory takes its place) must still fail the
    // strict read, as plain tail did, instead of reading as an empty page.
    it("fails the strict remote read when tail cannot read output.log", async () => {
      const beforeTail: { script?: string } = {};
      const handle = await spawnWithLog("remote", Buffer.from("hello\n"), beforeTail);
      beforeTail.script = "rm -f {} && mkdir {}";
      const read = await handle.readOutputForMonitor!(0);
      expect(read.success).toBe(false);
    });

    // head stops after one page, so tail dies of SIGPIPE on every capped read of a large log.
    it("keeps a capped remote read that ends tail with SIGPIPE", async () => {
      const handle = await spawnWithLog("remote", Buffer.alloc(1024 * 1024, "x"));
      const read = await handle.readOutput(0, 1_000);
      expect(read.newOffset).toBe(1_000);
      expect(read.content).toBe("x".repeat(1_000));
    });

    // A running process can write one character in two writes. The read that lands between them
    // must leave the first bytes for the next read instead of decoding them to U+FFFD.
    it.each(["local", "remote"] as const)(
      "rebuilds a %s character split across two writes at the end of the log",
      async (kind) => {
        const handle = await spawnWithLog(kind, Buffer.from([0x61, 0x62, 0xe2, 0x82]));
        const first = await handle.readOutput(0, 1_000);
        expect(first.newOffset).toBe(2);
        await fs.appendFile(handle.outputPath, Buffer.from([0xac, 0x0a]));
        const second = await handle.readOutput(first.newOffset, 1_000);
        expect(first.content + second.content).toBe("ab€\n");
        expect(second.newOffset).toBe(6);
      }
    );

    // Output that really ends in a truncated character settles on the final read (the drain
    // after exit), so the drain reaches the end of the file.
    it.each(["local", "remote"] as const)(
      "takes a %s truncated character on the final read",
      async (kind) => {
        const handle = await spawnWithLog(kind, Buffer.from([0x61, 0xe2, 0x82]));
        const held = await handle.readOutput(1, 1_000);
        expect(held.newOffset).toBe(1);
        const final = await handle.readOutput(1, 1_000, { final: true });
        expect(final.content).toBe("\uFFFD");
        expect(final.newOffset).toBe(final.fileSize);
      }
    );
  });
});
