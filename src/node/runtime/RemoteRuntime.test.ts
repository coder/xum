import { describe, expect, it } from "bun:test";
import type { ExecOptions, ExecStream } from "./Runtime";
import { RemoteRuntime, type SpawnResult } from "./RemoteRuntime";

class RecordingRemoteRuntime extends RemoteRuntime {
  spawnCount = 0;

  protected readonly commandPrefix = "Recording";

  protected getBasePath(): string {
    return "/workspace";
  }

  protected quoteForRemote(filePath: string): string {
    return `'${filePath}'`;
  }

  protected cdCommand(cwd: string): string {
    return `cd '${cwd}'`;
  }

  protected spawnRemoteProcess(): Promise<SpawnResult> {
    this.spawnCount += 1;
    throw new Error("spawn should not be called");
  }

  resolvePath(filePath: string): Promise<string> {
    return Promise.resolve(filePath);
  }

  getWorkspacePath(): string {
    return "/workspace";
  }

  createWorkspace() {
    return Promise.resolve({ success: false as const, error: "not implemented" });
  }

  initWorkspace() {
    return Promise.resolve({ success: true });
  }

  deleteWorkspace() {
    return Promise.resolve({ success: true as const, deletedPath: "/workspace" });
  }

  renameWorkspace() {
    return Promise.resolve({
      success: true as const,
      oldPath: "/workspace",
      newPath: "/workspace",
    });
  }

  forkWorkspace() {
    return Promise.resolve({ success: false as const, error: "not implemented" });
  }

  ensureReady() {
    return Promise.resolve({ ready: true as const });
  }
}

/**
 * Fake exec: records the abortSignal readFile passes and returns a wedged
 * cat whose stdout never yields — exactly the stalled remote read the r18
 * cancellation fix must be able to kill.
 */
class ReadFileRemoteRuntime extends RecordingRemoteRuntime {
  capturedSignal: AbortSignal | undefined;

  override exec(_command: string, options: ExecOptions): Promise<ExecStream> {
    this.capturedSignal = options.abortSignal;
    return Promise.resolve({
      stdout: new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
      }),
      stderr: new ReadableStream<Uint8Array>({
        start: (controller) => controller.close(),
      }),
      stdin: new WritableStream<Uint8Array>(),
      // Wedged process: never exits on its own.
      exitCode: new Promise<number>(() => undefined),
      duration: new Promise<number>(() => undefined),
    });
  }
}

describe("RemoteRuntime.readFile", () => {
  it("cancelling the stream aborts the underlying cat exec", async () => {
    // r18: without cancel forwarding, a cancelled reader (e.g. mux.load's
    // byte ceiling) left the remote cat blocked until its 300s timeout,
    // accumulating remote processes across repeated caught failures.
    const runtime = new ReadFileRemoteRuntime();
    const reader = runtime.readFile("/workspace/huge.bin").getReader();
    // Let start() run: exec is invoked and captures its signal.
    await Bun.sleep(0);
    expect(runtime.capturedSignal).toBeDefined();
    expect(runtime.capturedSignal?.aborted).toBe(false);

    await reader.cancel();
    expect(runtime.capturedSignal?.aborted).toBe(true);
  });

  it("a caller abort forwards into the cat exec", async () => {
    const runtime = new ReadFileRemoteRuntime();
    const abort = new AbortController();
    const stream = runtime.readFile("/workspace/huge.bin", abort.signal);
    const reader = stream.getReader();
    await Bun.sleep(0);
    expect(runtime.capturedSignal?.aborted).toBe(false);

    abort.abort();
    expect(runtime.capturedSignal?.aborted).toBe(true);
    reader.releaseLock();
  });
});

describe("RemoteRuntime.writeFile", () => {
  it("does not start a remote write command when aborted before the first write", async () => {
    const runtime = new RecordingRemoteRuntime();
    const writer = runtime.writeFile("/workspace/file.txt").getWriter();

    try {
      await writer.abort("cancelled");
      throw new Error("Expected writer abort to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("cancelled");
    }

    expect(runtime.spawnCount).toBe(0);
  });
});
