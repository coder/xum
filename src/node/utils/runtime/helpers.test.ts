import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecOptions, ExecStream, FileStat, Runtime } from "@/node/runtime/Runtime";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { getLegacyPlanFilePath, getPlanFilePath } from "@/common/utils/planStorage";
import { copyPlanFileAcrossRuntimes, movePlanFile, readPlanFile } from "./helpers";
import { drainFifoReaders } from "../../../../tests/ipc/fifoRelease";

interface MockRuntimeState {
  xumHome: string;
  files: Map<string, string>;
  readAttempts: string[];
  writes: Array<{ path: string; content: string }>;
  execCalls: Array<{ command: string; options: ExecOptions }>;
  resolvedPaths: Map<string, string>;
}

function createRuntimeState(
  xumHome: string,
  initialFiles: Record<string, string> = {}
): MockRuntimeState {
  return {
    xumHome,
    files: new Map(Object.entries(initialFiles)),
    readAttempts: [],
    writes: [],
    execCalls: [],
    resolvedPaths: new Map(),
  };
}

function createTextStream(content: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content));
      controller.close();
    },
  });
}

function createExecStream(stdout = "", stderr = "", exitCode = 0, duration = 0): ExecStream {
  return {
    stdout: createTextStream(stdout),
    stderr: createTextStream(stderr),
    stdin: new WritableStream<Uint8Array>({
      write(_chunk) {
        return Promise.resolve();
      },
      close() {
        return Promise.resolve();
      },
    }),
    exitCode: Promise.resolve(exitCode),
    duration: Promise.resolve(duration),
  };
}

function toFileStat(content: string): FileStat {
  return {
    size: content.length,
    modifiedTime: new Date(0),
    isDirectory: false,
  };
}

function createMockRuntime(state: MockRuntimeState): Runtime {
  return {
    getXumHome: () => state.xumHome,
    readFile: (path: string) => {
      state.readAttempts.push(path);
      const content = state.files.get(path);
      if (content === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return createTextStream(content);
    },
    writeFile: (path: string) => {
      const decoder = new TextDecoder("utf-8");
      let content = "";

      return new WritableStream<Uint8Array>({
        write(chunk) {
          content += decoder.decode(chunk, { stream: true });
        },
        close() {
          content += decoder.decode();
          state.files.set(path, content);
          state.writes.push({ path, content });
        },
      });
    },
    exec: (command: string, options: ExecOptions) => {
      state.execCalls.push({ command, options });
      return Promise.resolve(createExecStream());
    },
    stat: (path: string) => {
      const content = state.files.get(path);
      if (content === undefined) {
        return Promise.reject(new Error(`ENOENT: ${path}`));
      }
      return Promise.resolve(toFileStat(content));
    },
    resolvePath: (path: string) => {
      const resolvedPath = state.resolvedPaths.get(path);
      if (resolvedPath !== undefined) {
        return Promise.resolve(resolvedPath);
      }
      return Promise.resolve(path);
    },
  } as unknown as Runtime;
}

describe("copyPlanFileAcrossRuntimes", () => {
  const sourceWorkspaceName = "source-workspace";
  const sourceWorkspaceId = "source-workspace-id";
  const targetWorkspaceName = "target-workspace";
  const projectName = "demo-project";
  const sourceMuxHome = "/source-mux";
  const targetXumHome = "/target-mux";

  it("reads from source runtime and writes to target runtime", async () => {
    const sourcePath = getPlanFilePath(sourceWorkspaceName, projectName, sourceMuxHome);
    const legacyPath = getLegacyPlanFilePath(sourceWorkspaceId, sourceMuxHome);
    const targetPath = getPlanFilePath(targetWorkspaceName, projectName, targetXumHome);
    const sourceContent = "# source plan\n";

    const sourceState = createRuntimeState(sourceMuxHome, {
      [sourcePath]: sourceContent,
      // If this is read instead of sourcePath, this assertion would fail.
      [legacyPath]: "# legacy plan\n",
    });
    const targetState = createRuntimeState(targetXumHome);

    await copyPlanFileAcrossRuntimes(
      createMockRuntime(sourceState),
      createMockRuntime(targetState),
      sourceWorkspaceName,
      sourceWorkspaceId,
      targetWorkspaceName,
      projectName
    );

    expect(sourceState.readAttempts).toEqual([sourcePath]);
    expect(sourceState.writes).toEqual([]);
    expect(targetState.readAttempts).toEqual([]);
    expect(targetState.writes).toEqual([{ path: targetPath, content: sourceContent }]);
    expect(targetState.files.get(targetPath)).toBe(sourceContent);
  });

  it("falls back to legacy source path when the new source path is missing", async () => {
    const sourcePath = getPlanFilePath(sourceWorkspaceName, projectName, sourceMuxHome);
    const legacyPath = getLegacyPlanFilePath(sourceWorkspaceId, sourceMuxHome);
    const targetPath = getPlanFilePath(targetWorkspaceName, projectName, targetXumHome);
    const legacyContent = "# legacy plan\n";

    const sourceState = createRuntimeState(sourceMuxHome, {
      [legacyPath]: legacyContent,
    });
    const targetState = createRuntimeState(targetXumHome);

    await copyPlanFileAcrossRuntimes(
      createMockRuntime(sourceState),
      createMockRuntime(targetState),
      sourceWorkspaceName,
      sourceWorkspaceId,
      targetWorkspaceName,
      projectName
    );

    expect(sourceState.readAttempts).toEqual([sourcePath, legacyPath]);
    expect(targetState.writes).toEqual([{ path: targetPath, content: legacyContent }]);
    expect(targetState.files.get(targetPath)).toBe(legacyContent);
  });

  it("silently no-ops when source plan is missing at both new and legacy paths", async () => {
    const sourcePath = getPlanFilePath(sourceWorkspaceName, projectName, sourceMuxHome);
    const legacyPath = getLegacyPlanFilePath(sourceWorkspaceId, sourceMuxHome);
    const targetPath = getPlanFilePath(targetWorkspaceName, projectName, targetXumHome);

    const sourceState = createRuntimeState(sourceMuxHome);
    const targetState = createRuntimeState(targetXumHome);

    await copyPlanFileAcrossRuntimes(
      createMockRuntime(sourceState),
      createMockRuntime(targetState),
      sourceWorkspaceName,
      sourceWorkspaceId,
      targetWorkspaceName,
      projectName
    );

    expect(sourceState.readAttempts).toEqual([sourcePath, legacyPath]);
    expect(targetState.writes).toEqual([]);
    expect(targetState.files.has(targetPath)).toBe(false);
  });
});

async function settleWithin<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Real filesystem: a fork copies the source plan, and the plan path is user/agent-writable, so a
 * writer-less FIFO there must not park a libuv worker per fork. Every FIFO is drained in afterEach
 * so a RED run never strands a reader.
 */
(process.platform !== "win32" ? describe : describe.skip)(
  "copyPlanFileAcrossRuntimes on non-regular source plan paths",
  () => {
    const sourceWorkspaceName = "source-workspace";
    const sourceWorkspaceId = "source-workspace-id";
    const targetWorkspaceName = "target-workspace";
    const projectName = "demo-project";

    class HomeRuntime extends LocalRuntime {
      constructor(private readonly xumHome: string) {
        super(xumHome);
      }

      override getXumHome(): string {
        return this.xumHome;
      }
    }

    let dir: string;
    let canonical: string;
    let legacy: string;
    let target: string;
    let fifos: string[];
    let attempts: Array<Promise<unknown>>;

    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-copy-plan-"));
      canonical = getPlanFilePath(sourceWorkspaceName, projectName, path.join(dir, "source"));
      legacy = getLegacyPlanFilePath(sourceWorkspaceId, path.join(dir, "source"));
      target = getPlanFilePath(targetWorkspaceName, projectName, path.join(dir, "target"));
      await fs.mkdir(path.dirname(canonical), { recursive: true });
      fifos = [];
      attempts = [];
    });

    afterEach(async () => {
      // Drain every FIFO concurrently: a reader released from the canonical FIFO falls through to
      // the legacy one.
      const drains = await Promise.all(
        fifos.map((fifo) => drainFifoReaders(fifo, attempts, 10_000))
      );
      await fs.rm(dir, { recursive: true, force: true });
      expect(drains.every((drain) => drain.settled)).toBe(true);
    });

    function mkfifo(p: string): void {
      execFileSync("mkfifo", [p]);
      fifos.push(p);
    }

    function copy(): Promise<void> {
      const attempt = copyPlanFileAcrossRuntimes(
        new HomeRuntime(path.join(dir, "source")),
        new HomeRuntime(path.join(dir, "target")),
        sourceWorkspaceName,
        sourceWorkspaceId,
        targetWorkspaceName,
        projectName
      );
      attempts.push(attempt);
      return settleWithin(attempt, 2000, "copyPlanFileAcrossRuntimes");
    }

    // A nonblocking write-open succeeds iff some reader holds or awaits the FIFO.
    function writeOpenError(fifo: string): string | undefined {
      try {
        fsSync.closeSync(
          fsSync.openSync(fifo, fsSync.constants.O_WRONLY | fsSync.constants.O_NONBLOCK)
        );
        return undefined;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code;
      }
    }

    it("skips a writer-less canonical FIFO promptly and falls back to the regular legacy plan", async () => {
      mkfifo(canonical);
      await fs.writeFile(legacy, "# legacy plan\n");
      await copy();
      expect(await fs.readFile(target, "utf8")).toBe("# legacy plan\n");
      expect(writeOpenError(canonical)).toBe("ENXIO");
    });

    it("treats writer-less FIFOs at both candidate paths as no plan", async () => {
      mkfifo(canonical);
      mkfifo(legacy);
      await copy();
      expect(fsSync.existsSync(target)).toBe(false);
      expect(writeOpenError(canonical)).toBe("ENXIO");
      expect(writeOpenError(legacy)).toBe("ENXIO");
    });

    it.each([
      { label: "regular file", mode: 0o644, viaSymlink: false },
      { label: "read-only regular file", mode: 0o444, viaSymlink: false },
      { label: "symlink to a regular file", mode: 0o644, viaSymlink: true },
    ])("copies a canonical $label unchanged", async ({ mode, viaSymlink }) => {
      const content = "# canonical plan\n\n" + "step\n".repeat(5000);
      const file = viaSymlink ? path.join(dir, "elsewhere.md") : canonical;
      await fs.writeFile(file, content, { mode });
      await fs.chmod(file, mode);
      if (viaSymlink) await fs.symlink(file, canonical);
      await fs.writeFile(legacy, "# legacy plan\n");
      await copy();
      expect(await fs.readFile(target, "utf8")).toBe(content);
    });
  }
);

describe("readPlanFile", () => {
  it("passes unresolved migration paths through pathEnv", async () => {
    const workspaceName = "workspace-a1b2";
    const projectName = "demo-project";
    const workspaceId = "legacy-workspace-id";
    const xumHome = "~/.mux";
    const legacyContent = "# legacy plan\n";

    const planPath = getPlanFilePath(workspaceName, projectName, xumHome);
    const legacyPath = getLegacyPlanFilePath(workspaceId, xumHome);
    const planDir = planPath.substring(0, planPath.lastIndexOf("/"));

    const resolvedPlanPath = "/home/dev/.mux/plans/demo-project/workspace-a1b2.md";

    const state = createRuntimeState(xumHome, {
      [legacyPath]: legacyContent,
    });

    state.resolvedPaths.set(planPath, resolvedPlanPath);

    const result = await readPlanFile(
      createMockRuntime(state),
      workspaceName,
      projectName,
      workspaceId
    );

    expect(result).toEqual({
      content: legacyContent,
      exists: true,
      path: resolvedPlanPath,
    });
    expect(state.readAttempts).toEqual([planPath, legacyPath]);
    expect(state.execCalls).toHaveLength(1);
    expect(state.execCalls[0]).toEqual({
      command: 'mkdir -p "$XUM_PLAN_DIR" && mv "$XUM_LEGACY_PLAN" "$XUM_PLAN"',
      options: {
        cwd: "/tmp",
        pathEnv: {
          XUM_PLAN_DIR: planDir,
          XUM_LEGACY_PLAN: legacyPath,
          XUM_PLAN: planPath,
        },
        timeout: 5,
      },
    });
  });

  it.each([
    { label: "local canonical", xumHome: "~/.xum" },
    { label: "SSH legacy", xumHome: "~/.mux" },
    { label: "Docker", xumHome: "/var/mux" },
  ])(
    "falls back to $label runtime-home legacy path, not a hardcoded ~/.xum root",
    async ({ xumHome }) => {
      const workspaceName = "workspace-a1b2";
      const projectName = "demo-project";
      const workspaceId = "legacy-workspace-id";
      const localCanonicalLegacyPath = getLegacyPlanFilePath(workspaceId, "~/.xum");
      const runtimeLegacyPath = getLegacyPlanFilePath(workspaceId, xumHome);
      const planPath = getPlanFilePath(workspaceName, projectName, xumHome);
      const legacyContent = "# runtime-home legacy plan\n";

      const state = createRuntimeState(xumHome, {
        [localCanonicalLegacyPath]: "# local-canonical leftover\n",
        [runtimeLegacyPath]: legacyContent,
      });
      state.resolvedPaths.set(planPath, planPath);
      state.resolvedPaths.set(runtimeLegacyPath, runtimeLegacyPath);

      const result = await readPlanFile(
        createMockRuntime(state),
        workspaceName,
        projectName,
        workspaceId
      );

      expect(result.content).toBe(legacyContent);
      expect(state.readAttempts).toEqual([planPath, runtimeLegacyPath]);
      if (xumHome !== "~/.xum") {
        expect(state.readAttempts).not.toContain(localCanonicalLegacyPath);
      }
    }
  );
});

describe("movePlanFile", () => {
  it("passes unresolved plan paths through pathEnv", async () => {
    const oldWorkspaceName = "old-workspace";
    const newWorkspaceName = "new-workspace";
    const projectName = "demo-project";
    const xumHome = "~/.mux";

    const oldPath = getPlanFilePath(oldWorkspaceName, projectName, xumHome);
    const newPath = getPlanFilePath(newWorkspaceName, projectName, xumHome);

    const state = createRuntimeState(xumHome, {
      [oldPath]: "# old plan\n",
    });

    await movePlanFile(createMockRuntime(state), oldWorkspaceName, newWorkspaceName, projectName);

    expect(state.execCalls).toHaveLength(1);
    expect(state.execCalls[0]).toEqual({
      command: 'mv "$XUM_OLD_PLAN" "$XUM_NEW_PLAN"',
      options: {
        cwd: "/tmp",
        pathEnv: {
          XUM_OLD_PLAN: oldPath,
          XUM_NEW_PLAN: newPath,
        },
        timeout: 5,
      },
    });
  });
});
