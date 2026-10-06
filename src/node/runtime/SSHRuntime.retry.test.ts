import { describe, expect, it } from "bun:test";
import type { ExecOptions, ExecStream, InitLogger } from "./Runtime";
import { SSHRuntime } from "./SSHRuntime";
import type { RemoteProjectLayout } from "./remoteProjectLayout";
import type { SSHRuntimeConfig } from "./sshConnectionPool";
import type { PtyHandle, PtySessionParams, SSHTransport } from "./transports";

const noop = (): void => undefined;

const noopInitLogger: InitLogger = {
  logStep: noop,
  logStdout: noop,
  logStderr: noop,
  logComplete: noop,
};

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

interface SyncAction {
  label: string;
  error?: Error;
  abortController?: AbortController;
}

function createDeferred(): Deferred {
  let resolve: () => void = noop;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createMockTransport(config: SSHRuntimeConfig): SSHTransport {
  return {
    spawnRemoteProcess() {
      return Promise.reject(new Error("Unexpected transport use in SSHRuntime retry test"));
    },
    isConnectionFailure() {
      return false;
    },
    acquireConnection() {
      return Promise.resolve();
    },
    getConfig() {
      return config;
    },
    createPtySession(_params: PtySessionParams): Promise<PtyHandle> {
      return Promise.reject(new Error("Unexpected PTY creation in SSHRuntime retry test"));
    },
    openReverseForward(): Promise<never> {
      return Promise.reject(new Error("Unexpected reverse forward in SSHRuntime retry test"));
    },
  };
}

function createTextStream(text: string): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (encoded.byteLength > 0) {
        controller.enqueue(encoded);
      }
      controller.close();
    },
  });
}

const resolveVoid = (): Promise<void> => Promise.resolve();
const discardChunk = (_chunk: Uint8Array): Promise<void> => Promise.resolve();

function createExecStream(stdout: string, stderr = "", exitCode = 0): ExecStream {
  return {
    stdout: createTextStream(stdout),
    stderr: createTextStream(stderr),
    stdin: new WritableStream<Uint8Array>({
      write: discardChunk,
      close: resolveVoid,
      abort: resolveVoid,
    }),
    exitCode: Promise.resolve(exitCode),
    duration: Promise.resolve(0),
  };
}

class TestSSHRuntime extends SSHRuntime {
  readonly callOrder: string[] = [];
  readonly cleanupCalls: string[] = [];
  readonly backoffCalls: number[] = [];
  /** Records `options.forceNoThin` per attempt so tests can assert the retry
   *  loop opts the next push into `--no-thin` after a thin-pack failure. */
  readonly forceNoThinPerAttempt: boolean[] = [];

  private readonly actions: SyncAction[] = [];
  private cleanupHook?: () => Promise<void>;

  constructor() {
    const config: SSHRuntimeConfig = {
      host: "example.test",
      srcBaseDir: "/remote/src",
    };
    super(config, createMockTransport(config));
  }

  queueActions(...actions: SyncAction[]): void {
    this.actions.push(...actions);
  }

  setCleanupHook(cleanupHook?: () => Promise<void>): void {
    this.cleanupHook = cleanupHook;
  }

  async runSync(projectPath: string, abortSignal?: AbortSignal): Promise<void> {
    await this.syncProjectToRemote(projectPath, noopInitLogger, abortSignal);
  }

  protected override syncProjectToRemoteOnce(
    _projectPath: string,
    _layout: RemoteProjectLayout,
    _initLogger: InitLogger,
    _abortSignal?: AbortSignal,
    options: { forceNoThin?: boolean } = {}
  ): Promise<void> {
    const action = this.actions.shift();
    if (!action) {
      return Promise.reject(new Error("Missing sync action"));
    }

    this.callOrder.push(action.label);
    this.forceNoThinPerAttempt.push(options.forceNoThin === true);
    action.abortController?.abort();
    if (action.error) {
      return Promise.reject(action.error);
    }
    return Promise.resolve();
  }

  protected override async cleanupRetryableProjectSyncFailure(
    baseRepoPathArg: string,
    _attempt: number,
    _maxAttempts: number,
    _abortSignal?: AbortSignal
  ): Promise<void> {
    this.cleanupCalls.push(baseRepoPathArg);
    await this.cleanupHook?.();
  }

  protected override waitForProjectSyncRetryDelay(
    ms: number,
    abortSignal?: AbortSignal
  ): Promise<void> {
    this.backoffCalls.push(ms);
    if (abortSignal?.aborted) {
      return Promise.reject(new Error("Operation aborted"));
    }
    return Promise.resolve();
  }
}

class CleanupCommandSSHRuntime extends SSHRuntime {
  readonly commands: string[] = [];
  readonly timeouts: number[] = [];
  readonly steps: string[] = [];

  countObjectsStdout = "count: 0\npacks: 0\n";
  countObjectsStderr = "";
  countObjectsExitCode = 0;
  promisorStdout = "/remote/src/project/.mux-base.git/objects/pack/pack-a.promisor\n";
  gcStdout = "";
  gcStderr = "";
  gcExitCode = 0;

  constructor() {
    const config: SSHRuntimeConfig = {
      host: "example.test",
      srcBaseDir: "/remote/src",
    };
    super(config, createMockTransport(config));
  }

  async runCleanup(baseRepoPathArg: string, abortSignal?: AbortSignal): Promise<void> {
    await this.cleanupRetryableProjectSyncFailure(baseRepoPathArg, 1, 3, abortSignal);
  }

  async runEnsureHealthy(baseRepoPathArg: string, abortSignal?: AbortSignal): Promise<void> {
    await this.ensureHealthyBaseRepoForSync(
      baseRepoPathArg,
      {
        ...noopInitLogger,
        logStep: (step) => {
          this.steps.push(step);
        },
      },
      abortSignal
    );
  }

  override exec(command: string, options: ExecOptions): Promise<ExecStream> {
    this.commands.push(command);
    this.timeouts.push(options.timeout ?? -1);

    if (command.includes("count-objects -v")) {
      return Promise.resolve(
        createExecStream(
          this.countObjectsStdout,
          this.countObjectsStderr,
          this.countObjectsExitCode
        )
      );
    }
    if (command.startsWith("find ")) {
      return Promise.resolve(createExecStream(this.promisorStdout));
    }
    if (command.includes(" gc --prune=now")) {
      // Spawn-only call: production code returns as soon as the remote shell
      // has detached `git gc`. The mock mirrors that shape (stdout/stderr/exit
      // here represent the detached spawn, not gc itself).
      return Promise.resolve(createExecStream(this.gcStdout, this.gcStderr, this.gcExitCode));
    }
    return Promise.resolve(createExecStream(""));
  }
}

// Single-line shell pipeline that strips partial-clone config from a shared
// bare base repo. The exact text is asserted in tests because order matters:
// the strip must precede the on-disk `.promisor` marker cleanup so that even
// a half-completed repair leaves the repo non-promisor (and therefore safe
// from the upstream `check_connected()` sideband deadlock — see the doc
// comment on `stripBaseRepoPromisorConfig` in SSHRuntime.ts).
// Detached gc invocation: `setsid -f` puts gc in its own session/PGID before
// execing git so that neither the SSH channel closing nor the `timeout -s KILL`
// process-group kill that `RemoteRuntime.exec` wraps every command in can
// SIGKILL gc mid-finalization. Retry cleanup uses `setsid -w` to wait for
// the detached child; proactive preflight only waits for the detached spawn.
function expectedGcCommand(baseRepoPathArg: string, waitForGc: boolean): string {
  const setsidArgs = waitForGc ? "-f -w" : "-f";
  return [
    `base_repo=${baseRepoPathArg}`,
    "command -v setsid >/dev/null 2>&1 || { echo 'setsid command not found; cannot detach git gc' >&2; exit 127; }",
    `setsid ${setsidArgs} sh -c 'exec git -C "$1" gc --prune=now >>/tmp/.mux-base-repo-gc.log 2>&1' sh "$base_repo" </dev/null`,
  ].join("\n");
}

function expectedReindexCommand(baseRepoPathArg: string): string {
  return [
    `pack_dir=${baseRepoPathArg}/objects/pack`,
    'if [ ! -d "$pack_dir" ]; then exit 0; fi',
    `for pack in "$pack_dir"/pack-*.pack; do`,
    '  [ -e "$pack" ] || continue',
    '  idx="${pack%.pack}.idx"',
    '  if [ -f "$idx" ]; then continue; fi',
    `  if git index-pack "$pack" >/dev/null 2>&1; then`,
    '    echo "reindexed $pack"',
    "  else",
    '    echo "reindex-failed $pack" >&2',
    "  fi",
    "done",
  ].join("\n");
}

function expectedStripPromisorCommand(baseRepoPathArg: string): string {
  return (
    `git -C ${baseRepoPathArg} config --unset-all remote.origin.promisor; ` +
    `git -C ${baseRepoPathArg} config --unset-all remote.origin.partialclonefilter; ` +
    `git -C ${baseRepoPathArg} config --unset-all extensions.partialclone; ` +
    `true`
  );
}

describe("SSHRuntime project sync retry orchestration", () => {
  it("strips legacy partial-clone keys before any on-disk maintenance", async () => {
    const runtime = new CleanupCommandSSHRuntime();
    const baseRepoPathArg = '"/remote/src/project/.mux-base.git"';

    await runtime.runCleanup(baseRepoPathArg);

    // Strip must be the first remote call in repair — see comment above.
    expect(runtime.commands[0]).toBe(expectedStripPromisorCommand(baseRepoPathArg));
    expect(runtime.timeouts[0]).toBe(10);
  });

  it("removes stale promisor markers before running git gc", async () => {
    const runtime = new CleanupCommandSSHRuntime();
    const baseRepoPathArg = '"/remote/src/project/.mux-base.git"';

    await runtime.runCleanup(baseRepoPathArg);

    expect(runtime.commands).toEqual([
      expectedStripPromisorCommand(baseRepoPathArg),
      `find ${baseRepoPathArg}/objects/pack -name '*.promisor' -print -delete 2>/dev/null || true`,
      expectedReindexCommand(baseRepoPathArg),
      expectedGcCommand(baseRepoPathArg, true),
    ]);
    // Last timeout waits for `setsid -w`. It can stop waiting without killing
    // the detached gc process itself.
    expect(runtime.timeouts).toEqual([10, 10, 10, 30 * 60]);
  });

  it("proactively repairs fragmented base repos before sync", async () => {
    const runtime = new CleanupCommandSSHRuntime();
    const baseRepoPathArg = '"/remote/src/project/.mux-base.git"';
    runtime.countObjectsStdout = "count: 0\npacks: 50\n";

    await runtime.runEnsureHealthy(baseRepoPathArg);

    expect(runtime.steps).toEqual([
      "Shared base repository is fragmented (50 pack files); running maintenance before sync...",
    ]);
    expect(runtime.commands).toEqual([
      `git -C ${baseRepoPathArg} count-objects -v`,
      expectedStripPromisorCommand(baseRepoPathArg),
      `find ${baseRepoPathArg}/objects/pack -name '*.promisor' -print -delete 2>/dev/null || true`,
      expectedReindexCommand(baseRepoPathArg),
      expectedGcCommand(baseRepoPathArg, false),
    ]);
    // Last timeout is the SSH spawn round-trip, NOT gc itself.
    expect(runtime.timeouts).toEqual([10, 10, 10, 10, 10]);
  });

  it("skips proactive maintenance for healthy base repos", async () => {
    const runtime = new CleanupCommandSSHRuntime();
    const baseRepoPathArg = '"/remote/src/project/.mux-base.git"';
    runtime.countObjectsStdout = "count: 0\npacks: 5\n";

    await runtime.runEnsureHealthy(baseRepoPathArg);

    expect(runtime.steps).toEqual([]);
    expect(runtime.commands).toEqual([`git -C ${baseRepoPathArg} count-objects -v`]);
    expect(runtime.timeouts).toEqual([10]);
  });

  it("treats base repo health probe failures as best-effort", async () => {
    const runtime = new CleanupCommandSSHRuntime();
    const baseRepoPathArg = '"/remote/src/project/.mux-base.git"';
    runtime.countObjectsExitCode = 128;
    runtime.countObjectsStderr = "fatal: not a git repository";

    await runtime.runEnsureHealthy(baseRepoPathArg);

    expect(runtime.steps).toEqual([]);
    expect(runtime.commands).toEqual([`git -C ${baseRepoPathArg} count-objects -v`]);
    expect(runtime.timeouts).toEqual([10]);
  });

  it("keeps proactive maintenance best-effort when the gc spawn fails", async () => {
    const runtime = new CleanupCommandSSHRuntime();
    const baseRepoPathArg = '"/remote/src/project/.mux-base.git"';
    runtime.countObjectsStdout = "count: 0\npacks: 50\n";
    runtime.gcExitCode = 1;
    runtime.gcStderr = "setsid: command not found";

    await runtime.runEnsureHealthy(baseRepoPathArg);

    expect(runtime.steps).toEqual([
      "Shared base repository is fragmented (50 pack files); running maintenance before sync...",
    ]);
    expect(runtime.commands).toEqual([
      `git -C ${baseRepoPathArg} count-objects -v`,
      expectedStripPromisorCommand(baseRepoPathArg),
      `find ${baseRepoPathArg}/objects/pack -name '*.promisor' -print -delete 2>/dev/null || true`,
      expectedReindexCommand(baseRepoPathArg),
      expectedGcCommand(baseRepoPathArg, false),
    ]);
    expect(runtime.timeouts).toEqual([10, 10, 10, 10, 10]);
  });

  it("propagates aborts during proactive maintenance preflight", async () => {
    const runtime = new CleanupCommandSSHRuntime();
    const baseRepoPathArg = '"/remote/src/project/.mux-base.git"';
    const abortController = new AbortController();
    abortController.abort();

    let failure: unknown;
    try {
      await runtime.runEnsureHealthy(baseRepoPathArg, abortController.signal);
      throw new Error("Expected preflight maintenance to stop when aborted");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("Expected aborted preflight maintenance to throw an Error");
    }
    expect(failure.message).toBe("Operation aborted");
    expect(runtime.commands).toEqual([]);
    expect(runtime.timeouts).toEqual([]);
  });

  it("skips cleanup and backoff when a retryable failure was user-aborted", async () => {
    const runtime = new TestSSHRuntime();
    const abortController = new AbortController();
    const projectPath = `/tmp/abort-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    runtime.queueActions({
      label: "attempt-1",
      abortController,
      error: new Error("Failed to push to remote: Command killed by signal SIGTERM"),
    });

    let failure: unknown;
    try {
      await runtime.runSync(projectPath, abortController.signal);
      throw new Error("Expected sync to fail after the abort-driven push kill");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("Expected sync failure to surface as an Error");
    }
    expect(failure.message).toContain("Command killed by signal SIGTERM");
    expect(runtime.callOrder).toEqual(["attempt-1"]);
    expect(runtime.cleanupCalls).toEqual([]);
    expect(runtime.backoffCalls).toEqual([]);
  });

  it("keeps retry cleanup serialized with later syncs for the same project", async () => {
    const runtime = new TestSSHRuntime();
    const projectPath = `/tmp/serialized-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const cleanupEntered = createDeferred();
    const releaseCleanup = createDeferred();

    runtime.queueActions(
      {
        label: "first-1",
        error: new Error("Failed to push to remote: Command killed by signal SIGTERM"),
      },
      { label: "first-2" },
      { label: "second-1" }
    );
    runtime.setCleanupHook(async () => {
      cleanupEntered.resolve();
      await releaseCleanup.promise;
    });

    const firstSync = runtime.runSync(projectPath);
    await cleanupEntered.promise;

    const secondSync = runtime.runSync(projectPath);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.callOrder).toEqual(["first-1"]);

    releaseCleanup.resolve();
    await firstSync;
    await secondSync;

    expect(runtime.callOrder).toEqual(["first-1", "first-2", "second-1"]);
    expect(runtime.cleanupCalls).toHaveLength(1);
    expect(runtime.backoffCalls).toEqual([1000]);
  });

  it("retries thin-pack receive-pack failures with --no-thin on the next attempt", async () => {
    // Real-world failure shape: receive-pack routes the first push through
    // `unpack-objects` (because the object count is below
    // `transfer.unpackLimit`), unpack-objects cannot resolve the thin pack's
    // delta bases, and the push is rejected. The retry path runs base-repo
    // maintenance (gc, pack reindex, receive.unpackLimit config) and the next
    // attempt must opt out of thin-pack encoding entirely so the receiver can
    // unpack without any cross-pack delta-base lookup.
    const runtime = new TestSSHRuntime();
    const projectPath = `/tmp/no-thin-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    runtime.queueActions(
      {
        label: "attempt-1",
        error: new Error(
          "Failed to push to remote: remote: fatal: unresolved deltas left after unpacking\n" +
            "error: remote unpack failed: unpack-objects abnormal exit\n" +
            " ! [remote rejected]     main -> refs/mux-bundle/main (unpacker error)"
        ),
      },
      { label: "attempt-2" }
    );

    await runtime.runSync(projectPath);

    expect(runtime.callOrder).toEqual(["attempt-1", "attempt-2"]);
    // First attempt uses the default thin-pack push; the retry forces
    // --no-thin so the receiver doesn't need to resolve delta bases.
    expect(runtime.forceNoThinPerAttempt).toEqual([false, true]);
    expect(runtime.cleanupCalls).toHaveLength(1);
    expect(runtime.backoffCalls).toEqual([1000]);
  });

  it("does not flip --no-thin for unrelated retryable failures", async () => {
    // Connection-reset / killed-by-signal failures benefit from the standard
    // retry, but forcing --no-thin would needlessly enlarge a pack that was
    // never the problem. The flag must stay off for non-unpack errors.
    const runtime = new TestSSHRuntime();
    const projectPath = `/tmp/thin-default-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    runtime.queueActions(
      {
        label: "attempt-1",
        error: new Error("Failed to push to remote: Connection reset by peer"),
      },
      { label: "attempt-2" }
    );

    await runtime.runSync(projectPath);

    expect(runtime.callOrder).toEqual(["attempt-1", "attempt-2"]);
    expect(runtime.forceNoThinPerAttempt).toEqual([false, false]);
  });
});
