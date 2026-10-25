/**
 * TurnResources owns what a turn holds outside its parts: the per-stream temp
 * directory, the startup abort controller and resource scope, the teardown of
 * a registered stream's resources, and the workspace's MCP lease while the
 * turn runs. StreamManager keeps createTempDirForStream and cleanupStreamTempDir
 * as delegates, and keeps the MCP manager that setMCPServerManager sets.
 */
import * as path from "path";
import type { LanguageModel } from "ai";
import { Effect, Exit, Scope } from "effect";
import { PlatformPaths } from "@/common/utils/paths";
import { getErrorMessage } from "@/common/utils/errors";
import { shellQuote } from "@/common/utils/shell";
import type { Runtime } from "@/node/runtime/Runtime";
import type { EffectRunner } from "@/node/services/di/effectRunner";
import { runLanguageModelCleanup } from "@/node/services/languageModelCleanup";
import { log } from "@/node/services/log";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import type { StreamToken, WorkspaceId } from "@/node/services/turnEngine/types";
import type { TurnHandles, WorkspaceStreamInfo } from "@/node/services/turnEngine/turnState";
import type { ToolCallDisplayRegistry } from "@/node/services/toolCallDisplayRegistry";
import type { PartialJournal } from "@/node/services/turnEngine/PartialJournal";
import { linkAbortSignal } from "@/node/utils/abort";

/** What a start owns until its stream registers; the stream info holds them after. */
export interface TurnStartup {
  readonly abortController: AbortController;
  readonly unlinkAbortSignal: () => void;
  readonly resourceScope: Scope.Closeable;
}

export interface TurnResourcesDeps {
  readonly effectRunner: EffectRunner;
  readonly toolCallDisplayRegistry: Pick<ToolCallDisplayRegistry, "close">;
  readonly partialJournal: Pick<PartialJournal, "retire" | "interruptScheduled" | "awaitPending">;
  /** Read at call time: StreamManager.setMCPServerManager sets it after construction. */
  readonly mcpServerManager: () => MCPServerManager | undefined;
  /** StreamManager.createTempDirForStream, read at call time (tests spy on it). */
  readonly createTempDirForStream: (streamToken: StreamToken, runtime: Runtime) => Promise<string>;
  /** StreamManager.cleanupStreamTempDir, read at call time (tests replace it). */
  readonly cleanupStreamTempDir: (runtime: Runtime, runtimeTempDir: string) => void;
}

export class TurnResources {
  constructor(private readonly deps: TurnResourcesDeps) {}

  acquireMcpLease(workspaceId: WorkspaceId): void {
    this.deps.mcpServerManager()?.acquireLease(workspaceId as string);
  }

  releaseMcpLease(workspaceId: WorkspaceId): void {
    this.deps.mcpServerManager()?.releaseLease(workspaceId as string);
  }

  /**
   * Open the resources a start owns until its stream registers: an abort
   * controller linked to the caller's signal and the stream's resource scope.
   */
  openStartup(abortSignal: AbortSignal | undefined): TurnStartup {
    const streamAbortController = new AbortController();
    const unlinkAbortSignal = linkAbortSignal(abortSignal, streamAbortController);

    // Owns this stream's Effect-managed resources (temp dir, debounce
    // fiber). Ownership transfers to processStreamWithCleanup once the
    // stream registers; otherwise releaseStartup closes it.
    const resourceScope = Scope.makeUnsafe();
    return { abortController: streamAbortController, unlinkAbortSignal, resourceScope };
  }

  /**
   * Release a start's resources: a stream that registered owns them now, so its
   * teardown runs; otherwise the model, the signal link and the scope close here.
   */
  async releaseStartup(
    startup: TurnStartup,
    model: LanguageModel,
    registeredStream: WorkspaceStreamInfo | undefined
  ): Promise<void> {
    // streamText may already have invoked the provider while the envelope awaited I/O.
    // A refused startup must cancel that request before releasing its owned resources.
    if (!startup.abortController.signal.aborted)
      startup.abortController.abort(new Error("Stream startup did not complete"));
    if (registeredStream) return this.closeStreamResources(registeredStream);
    runLanguageModelCleanup(model);
    startup.unlinkAbortSignal();
    try {
      await this.deps.effectRunner.runPromise(Scope.close(startup.resourceScope, Exit.void));
    } catch (error) {
      log.error("Startup resource cleanup failed", { error });
    }
  }

  /**
   * Acquire the temp directory for this stream as a scoped resource. The
   * release finalizer registers only after acquisition succeeds, and
   * Scope.close runs it exactly once across both cleanup paths (startup
   * failure in startStream's finally, stream teardown in
   * processStreamWithCleanup). TurnRequestBuilder pre-creates this dir so
   * tool configuration can reference the same stable path; once startStream
   * receives it, the turn owns cleanup for both success and abort paths.
   */
  acquireTempDir(
    resourceScope: Scope.Closeable,
    streamToken: StreamToken,
    runtime: Runtime,
    providedRuntimeTempDir: string | undefined
  ): Promise<string> {
    return Effect.runPromise(
      Scope.provide(resourceScope)(
        Effect.acquireRelease(
          Effect.tryPromise({
            // Async thunk: createTempDirForStream failures follow the same
            // rejection path into startStream's catch as the previous
            // plain await.
            try: async () =>
              providedRuntimeTempDir ??
              (await this.deps.createTempDirForStream(streamToken, runtime)),
            catch: (error) => error,
          }),
          (dir) =>
            Effect.sync(() => {
              // Whitebox tests pass providedRuntimeTempDir: "" to skip
              // cleanup; mirror the previous falsy guard.
              if (dir) {
                this.deps.cleanupStreamTempDir(runtime, dir);
              }
            })
        )
      )
    );
  }

  /**
   * Create a temporary directory for a stream token
   * Use ~/.xum-tmp instead of system temp directory (e.g., /var/folders/...)
   * because macOS user-scoped temp paths are extremely long, which leads to:
   * - Agent mistakes when copying/manipulating paths
   * - Harder to read in tool outputs
   * - Potential path length issues on some systems
   *
   * Uses the Runtime abstraction so temp directories work for both local and SSH runtimes.
   */
  async createTempDirForStream(streamToken: StreamToken, runtime: Runtime): Promise<string> {
    const tempDir = `~/.xum-tmp/${streamToken}`;

    // Resolve ~ in the runtime's context: callers need the canonical absolute
    // path as a value, and reusing it for ensureDir avoids a second remote
    // resolution round trip per stream on SSH runtimes.
    let resolvedPath = (await runtime.resolvePath(tempDir)).trim();

    // In the main process, PlatformPaths defaults to POSIX behavior (no navigator),
    // so we normalize Windows paths to forward slashes.
    if (process.platform === "win32") {
      resolvedPath = resolvedPath.replace(/\\/g, "/");
    }

    try {
      await runtime.ensureDir(resolvedPath);
    } catch (err) {
      const msg = getErrorMessage(err);
      throw new Error(`Failed to create temp directory ${resolvedPath}: ${msg}`);
    }

    return resolvedPath;
  }

  cleanupStreamTempDir(runtime: Runtime, runtimeTempDir: string): void {
    // Use parent directory as cwd for safety - if runtimeTempDir is malformed,
    // we won't accidentally run rm -rf from root.
    const tempDirBasename = PlatformPaths.basename(runtimeTempDir);
    const tempDirParent = path.dirname(runtimeTempDir);

    // Fire-and-forget: don't block stream completion waiting for directory deletion.
    // This is especially important for SSH where rm -rf can take 500ms-2s.
    void runtime
      .exec(`rm -rf ${shellQuote(tempDirBasename)}`, {
        cwd: tempDirParent,
        timeout: 10,
      })
      .then(async (result) => {
        await result.exitCode;
        log.debug(`Cleaned up temp dir: ${runtimeTempDir}`);
      })
      .catch((error) => {
        log.error(`Failed to cleanup temp dir ${runtimeTempDir}:`, error);
      });
  }

  closeStreamResources(streamInfo: WorkspaceStreamInfo & TurnHandles): Promise<void> {
    if (streamInfo.executionScope)
      this.deps.toolCallDisplayRegistry.close(streamInfo.executionScope);
    if (streamInfo.resourceCleanup) return streamInfo.resourceCleanup;
    const closed = Promise.withResolvers<void>();
    streamInfo.resourceCleanup = closed.promise;
    (async () => {
      // Retire scheduled writes before joining their original Promise I/O. Scope close
      // interrupts debounce fibers; remote temp-directory removal remains best effort
      // (its registered finalizer only initiates removal, never awaits SSH).
      this.deps.partialJournal.retire(streamInfo);
      try {
        if (streamInfo.resourceScope) {
          await this.deps.effectRunner.runPromise(Scope.close(streamInfo.resourceScope, Exit.void));
        }
      } catch (error) {
        log.error("Stream resource cleanup failed", { error });
      }
      try {
        this.deps.partialJournal.interruptScheduled(streamInfo);
        await this.deps.partialJournal.awaitPending(streamInfo);
      } catch (error) {
        // A cleanup defect must not orphan a completed/failed handle or skip raw teardown.
        log.error("Pending partial write cleanup failed", { error });
      }

      runLanguageModelCleanup(streamInfo.request?.model);

      streamInfo.unlinkAbortSignal?.();
      streamInfo.unlinkAbortSignal = undefined;
    })().then(closed.resolve, closed.reject);
    return closed.promise;
  }
}
