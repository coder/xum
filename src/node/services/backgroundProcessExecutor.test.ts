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
