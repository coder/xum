import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { createBashTool } from "./bash";
import type { BashToolResult } from "@/common/types/tools";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { migrateToBackground } from "@/node/services/backgroundProcessExecutor";
import type { ExecStream } from "@/node/runtime/Runtime";
import { TestTempDir, createTestToolConfig, mockToolCallOptions } from "./testHelpers";

async function waitFor(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Full GCs until the target is collected; rounds absorb stale conservative stack slots. */
async function collected(ref: WeakRef<object>): Promise<boolean> {
  for (let round = 0; round < 40 && ref.deref() !== undefined; round++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    Bun.gc(true);
  }
  return ref.deref() === undefined;
}

/**
 * Runs a foreground command, sends it to the background, lets it exit, and returns only a
 * WeakRef to the tool configuration, so this frame's locals cannot keep it alive.
 */
async function migrateAndExit(
  manager: BackgroundProcessManager,
  dir: string
): Promise<{ configRef: WeakRef<object>; processId: string; workspaceId: string }> {
  const config = createTestToolConfig(process.cwd());
  config.runtimeTempDir = dir;
  config.backgroundProcessManager = manager;
  const pidFile = path.join(dir, "migrated.pid");
  const goFile = path.join(dir, "go");
  const resultPromise = createBashTool(config).execute!(
    {
      script: `echo $$ > "${pidFile}"; while [ ! -f "${goFile}" ]; do sleep 0.05; done`,
      timeout_secs: 60,
      run_in_background: false,
      display_name: "migrated-retention",
    },
    mockToolCallOptions
  ) as Promise<BashToolResult>;
  await waitFor(() => fs.existsSync(pidFile), "the command to start");
  expect(manager.sendToBackground(mockToolCallOptions.toolCallId).success).toBe(true);
  const result = await resultPromise;
  expect(result.success).toBe(true);
  const processId = result.success ? result.backgroundProcessId : undefined;
  if (processId == null) throw new Error("the command must have been sent to the background");

  fs.writeFileSync(goFile, "");
  await waitFor(
    async () => (await (await manager.getProcess(processId))?.handle.getExitCode()) != null,
    "the migrated command to exit"
  );
  const workspaceId = config.workspaceId;
  if (workspaceId == null) throw new Error("the test tool config must have a workspace");
  return { configRef: new WeakRef(config), processId, workspaceId };
}

describe("bash migrated to background: retention after exit", () => {
  // F29 heap snapshot: 128 finished migrated records kept 1783 MB alive. Each record's handle
  // kept the `kill` closure, whose scope held the turn's ToolConfiguration and, through its
  // callbacks, the whole turn scope.
  it("a finished migrated record does not keep the tool configuration alive", async () => {
    using tempDir = new TestTempDir("test-bash-migrated-retention");
    const manager = new BackgroundProcessManager(path.join(tempDir.path, "bg-root"));
    const { configRef, processId, workspaceId } = await migrateAndExit(manager, tempDir.path);
    try {
      // The record itself stays tracked (removing exited records is a separate decision).
      expect(await manager.getProcess(processId)).not.toBeNull();
      expect(await collected(configRef)).toBe(true);
      expect(await manager.getProcess(processId)).not.toBeNull();
    } finally {
      await manager.cleanup(workspaceId);
    }
  }, 30_000);

  // The bash helper keeps `kill` from capturing the execute scope, but any other caller's kill
  // can capture more: the handle itself must drop it once the command has exited.
  it("a migrated handle drops its kill callback after exit and drain", async () => {
    using tempDir = new TestTempDir("test-migrated-handle-release");
    const stream = (): { readable: ReadableStream<Uint8Array>; close: () => void } => {
      let close = (): void => undefined;
      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          close = () => controller.close();
        },
      });
      return { readable, close };
    };
    const stdout = stream();
    const stderr = stream();
    const exit = Promise.withResolvers<number>();
    const execStream: ExecStream = {
      stdout: stdout.readable,
      stderr: stderr.readable,
      stdin: new WritableStream<Uint8Array>(),
      exitCode: exit.promise,
      duration: exit.promise.then(() => 0),
    };
    // Stand-in for a turn scope that a kill closure captures; only a WeakRef leaves this frame.
    const { scopeRef, migration } = ((): {
      scopeRef: WeakRef<object>;
      migration: ReturnType<typeof migrateToBackground>;
    } => {
      const turnScope = { payload: new Array<number>(1000).fill(1) };
      return {
        scopeRef: new WeakRef(turnScope),
        migration: migrateToBackground(
          execStream,
          {
            cwd: tempDir.path,
            workspaceId: "ws",
            processId: "proc",
            script: "true",
            existingOutput: [],
            kill: () => void turnScope.payload.length,
          },
          tempDir.path
        ),
      };
    })();
    const migrated = await migration;
    expect(migrated.success).toBe(true);

    exit.resolve(0);
    stdout.close();
    stderr.close();
    if (!migrated.success) return;
    await waitFor(async () => (await migrated.handle.getExitCode()) === 0, "the exit code");
    expect(await collected(scopeRef)).toBe(true);
    // The handle stays usable: a terminate after release is a no-op.
    await migrated.handle.terminate();
  }, 30_000);
});
