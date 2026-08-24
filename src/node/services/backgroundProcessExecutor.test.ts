import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { BackgroundHandle } from "@/node/runtime/Runtime";
import { shellQuote } from "@/node/runtime/backgroundCommands";
import { spawnProcess } from "./backgroundProcessExecutor";

class ExecPathMappingRuntime extends LocalRuntime {
  constructor(
    projectPath: string,
    private readonly hostPrefix: string,
    private readonly execPrefix: string
  ) {
    super(projectPath);
  }

  mapPathForExec(filePath: string): string {
    return filePath.startsWith(this.hostPrefix)
      ? this.execPrefix + filePath.slice(this.hostPrefix.length)
      : filePath;
  }
}

/**
 * Delegates to a real LocalRuntime but is NOT an instanceof LocalBaseRuntime, so
 * spawnProcess treats it like a remote runtime; its exec throws for the spawn command
 * itself, simulating a transport-level (SSH/Coder channel) error after dispatch.
 */
function createRemoteLikeThrowingRuntime(base: LocalRuntime): LocalRuntime {
  return new Proxy({} as LocalRuntime, {
    get(_target, prop) {
      if (prop === "exec") {
        return (command: string, opts: never) => {
          if (command.includes("output.log")) {
            throw new Error("SSH channel error after dispatch");
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

    const result = await spawnProcess(createRemoteLikeThrowingRuntime(base), "echo hi", {
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
});
