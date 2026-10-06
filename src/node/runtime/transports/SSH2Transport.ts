import type { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as net from "net";
import { PassThrough } from "stream";
import type { Client, ClientChannel } from "ssh2";
import { RuntimeError as RuntimeErrorClass } from "../Runtime";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { attachStreamErrorHandler, isIgnorableStreamError } from "@/node/utils/streamErrors";
import { expandTildeForSSH } from "../tildeExpansion";
import { ssh2ConnectionPool } from "../SSH2ConnectionPool";
import { DEFAULT_SSH_MAX_WAIT_MS } from "../sshBackoff";
import { SSH2_CHANNEL_OPEN_TIMEOUT_MS } from "@/constants/sshChannels";
import type { SpawnResult } from "../RemoteRuntime";
import type {
  SSHTransport,
  SSHTransportAcquireOptions,
  SSHTransportConfig,
  SpawnOptions,
  PtyHandle,
  PtySessionParams,
  ReverseForward,
} from "./SSHTransport";

/**
 * Pooled ssh2 clients whose connection has closed. ssh2 emits the client's
 * "close" BEFORE it closes the channels still open on it, so a channel close
 * can tell a dead connection from a normal remote close. One listener per
 * client (not per exec) keeps concurrent execs under the listener limit.
 */
const watchedClients = new WeakSet<object>();
const closedClients = new WeakSet<object>();

/** Pipes each connection the host forwards to 127.0.0.1:localPort on the backend host. */
function routeForwardedConnections(client: Client, localPort: number): void {
  client.on("tcp connection", (_info, accept) => {
    // Accept in the event handler itself, and let the pipe buffer until the socket connects.
    const channel = accept();
    attachStreamErrorHandler(channel, "ssh2 reverse forward channel");
    const socket = net.connect(localPort, "127.0.0.1");
    socket.on("error", () => socket.destroy());
    socket.pipe(channel).pipe(socket);
    channel.once("close", () => socket.destroy());
    socket.once("close", () => channel.close());
  });
}

function watchForConnectionClose(client: EventEmitter): void {
  if (watchedClients.has(client)) return;
  watchedClients.add(client);
  client.once("close", () => closedClients.add(client));
}

class SSH2ChildProcess extends EventEmitter {
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  readonly stdin: NodeJS.WritableStream;

  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  pid = 0;

  constructor(
    private readonly channel: ClientChannel,
    isConnectionClosed: () => boolean
  ) {
    super();

    const stdoutPipe = new PassThrough();
    const stderrPipe = new PassThrough();
    const stdinPipe = new PassThrough();

    channel.pipe(stdoutPipe);
    if (channel.stderr) {
      channel.stderr.pipe(stderrPipe);
    } else {
      // SSH2 PTY exec merges remote stderr into stdout. Expose an already-closed
      // stderr stream so init-hook readers never hang waiting for a channel that
      // cannot exist; otherwise SSH workspaces can get stuck on "Running init hook...".
      stderrPipe.end();
    }
    stdinPipe.pipe(channel);

    this.stdout = stdoutPipe;
    this.stderr = stderrPipe;
    this.stdin = stdinPipe;

    let closeEventFired = false;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    let closeEmitted = false;

    const emitClose = () => {
      if (closeEmitted) {
        return;
      }
      closeEmitted = true;

      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }

      // When the TCP connection dies, ssh2 closes every open channel with EOF
      // and no exit status. Reporting that as exit 0 turned a mid-exec drop into
      // a successful, truncated result (an empty read; a stat that parses as
      // garbage, i.e. "missing"). Surface it as a transport failure (#4835).
      if (this.exitCode === null && this.signalCode === null && isConnectionClosed()) {
        this.emit(
          "error",
          new RuntimeErrorClass("SSH2 connection closed before the command exited", "network")
        );
        return;
      }

      this.emit("close", this.exitCode ?? 0, this.signalCode);
    };

    channel.on("exit", (code: number | null, signal: string | null) => {
      this.exitCode = typeof code === "number" ? code : null;
      this.signalCode = typeof signal === "string" ? signal : null;

      // ssh2 sometimes emits "close" before "exit"; if that happens, ensure we still
      // report the real exit code.
      if (closeEventFired) {
        emitClose();
      }
    });

    channel.on("close", (...args: unknown[]) => {
      closeEventFired = true;

      // ssh2 sometimes emits "close" with the exit code/signal. Capture it so we still
      // report the correct exit status even if we missed the earlier "exit" event
      // (e.g. extremely fast commands).
      const [code, signal] = args;

      if (this.exitCode === null && typeof code === "number") {
        this.exitCode = code;
      }

      if (this.signalCode === null && typeof signal === "string") {
        this.signalCode = signal;
      }

      if (this.exitCode !== null || this.signalCode !== null) {
        emitClose();
        return;
      }

      // Grace period: allow the "exit" event to arrive after "close".
      // Without this, we can incorrectly report exitCode=0 for failed commands.
      closeTimer = setTimeout(() => emitClose(), 250);
      closeTimer.unref?.();
    });

    channel.on("error", (err: Error) => {
      // An errored channel is dead: end our pipes so stdout readers finish
      // instead of waiting out the exec timeout, and report one terminal event
      // (no later "close" that would mark the connection healthy again). The
      // channel was acquired, so its failure is a transport failure, never a
      // missing path (#4835); RemoteRuntime keeps aborts/timeouts out of that.
      closeEmitted = true;
      if (closeTimer) clearTimeout(closeTimer);
      stdoutPipe.end();
      stderrPipe.end();
      this.emit(
        "error",
        new RuntimeErrorClass(`SSH2 channel failed: ${err.message}`, "network", err)
      );
    });
  }

  kill(signal?: string): boolean {
    this.killed = true;
    try {
      if (signal && typeof this.channel.signal === "function") {
        this.channel.signal(signal);
      }
    } catch {
      // Ignore signal errors.
    }

    try {
      this.channel.close();
    } catch {
      // Ignore close errors.
    }

    return true;
  }
}

class SSH2Pty implements PtyHandle {
  private closed = false;

  constructor(private readonly channel: ClientChannel) {
    this.channel.on("close", () => {
      this.closed = true;
    });

    const closeChannel = () => {
      this.closed = true;
      try {
        this.channel.close();
      } catch {
        // Ignore close errors.
      }
    };

    // PTY channels can emit socket errors when sessions exit early.
    attachStreamErrorHandler(this.channel, "ssh2-pty-channel", {
      logger: log,
      onIgnorable: closeChannel,
      onUnexpected: closeChannel,
    });

    if (this.channel.stderr) {
      attachStreamErrorHandler(this.channel.stderr, "ssh2-pty-stderr", {
        logger: log,
        onIgnorable: closeChannel,
        onUnexpected: closeChannel,
      });
    }
  }

  write(data: string): void {
    if (this.closed || this.channel.destroyed || this.channel.writableEnded) {
      return;
    }

    try {
      this.channel.write(data);
    } catch (error) {
      if (isIgnorableStreamError(error)) {
        return;
      }

      const message = getErrorMessage(error);
      const code =
        error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : undefined;

      log.warn("SSH2 PTY write failed", { code, message });
    }
  }

  resize(cols: number, rows: number): void {
    this.channel.setWindow(rows, cols, 0, 0);
  }

  kill(): void {
    this.closed = true;
    this.channel.close();
  }

  onData(handler: (data: string) => void): { dispose: () => void } {
    const onStdout = (data: Buffer) => handler(data.toString());
    const onStderr = (data: Buffer) => handler(data.toString());

    this.channel.on("data", onStdout);
    this.channel.stderr?.on("data", onStderr);

    return {
      dispose: () => {
        this.channel.off("data", onStdout);
        this.channel.stderr?.off("data", onStderr);
      },
    };
  }

  onExit(handler: (event: { exitCode: number; signal?: number }) => void): { dispose: () => void } {
    const onClose = (code?: number | null) => {
      handler({ exitCode: typeof code === "number" ? code : 0 });
    };

    this.channel.on("close", onClose);

    return {
      dispose: () => {
        this.channel.off("close", onClose);
      },
    };
  }
}

export class SSH2Transport implements SSHTransport {
  constructor(private readonly config: SSHTransportConfig) {}

  isConnectionFailure(_exitCode: number, _stderr: string): boolean {
    return false;
  }

  getConfig(): SSHTransportConfig {
    return this.config;
  }

  async acquireConnection(options?: SSHTransportAcquireOptions): Promise<void> {
    try {
      await ssh2ConnectionPool.acquireConnection(this.config, {
        abortSignal: options?.abortSignal,
        timeoutMs: options?.timeoutMs,
        maxWaitMs: options?.maxWaitMs,
        onWait: options?.onWait,
      });
    } catch (error) {
      // An unreachable host is a transport failure, never a missing path (#4438):
      // SSHRuntime.resolvePath preflights through here. Aborts pass through.
      if (options?.abortSignal?.aborted === true || error instanceof RuntimeErrorClass) throw error;
      throw new RuntimeErrorClass(getErrorMessage(error), "network", error);
    }
  }

  async spawnRemoteProcess(fullCommand: string, options: SpawnOptions): Promise<SpawnResult> {
    const connectTimeoutSec =
      options.timeout !== undefined ? Math.min(Math.ceil(options.timeout), 15) : 15;

    // Waiting through the pool's backoff counts against the exec deadline, as
    // for OpenSSH: otherwise a short read retry (#4830) could still wait out
    // the pool's default two-minute budget on a persistent outage.
    const remainingWaitMs =
      options.deadlineMs != null
        ? Math.min(Math.max(0, options.deadlineMs - Date.now()), DEFAULT_SSH_MAX_WAIT_MS)
        : undefined;

    let entry;
    try {
      // The pool reads maxWaitMs 0 as "fail fast in backoff" and would still wait out a pending
      // connect, so an exec whose deadline has already passed stops here (#5033).
      if (remainingWaitMs === 0) {
        throw new Error("the exec deadline passed before a connection was available");
      }
      entry = await ssh2ConnectionPool.acquireConnection(this.config, {
        abortSignal: options.abortSignal,
        timeoutMs: connectTimeoutSec * 1000,
        maxWaitMs: remainingWaitMs,
      });
    } catch (error) {
      // An abort (e.g. while waiting out a backoff) is not a transport failure.
      throw new RuntimeErrorClass(
        `SSH2 connection failed: ${getErrorMessage(error)}`,
        options.abortSignal?.aborted === true ? "exec" : "network",
        error instanceof Error ? error : undefined
      );
    }

    const { client } = entry;
    watchForConnectionClose(client);

    try {
      const channel = await new Promise<ClientChannel>((resolve, reject) => {
        let settled = false;
        let streamFromLateCallback: ClientChannel | undefined;
        // The connection is in use from the request on, not from ssh2's callback: a channel
        // open slower than the idle window must not let the idle timer end the client.
        const slot = ssh2ConnectionPool.reserveChannel(this.config, entry);

        const remainingDeadlineMs =
          options.deadlineMs != null ? Math.max(0, options.deadlineMs - Date.now()) : undefined;
        const timeoutMs =
          remainingDeadlineMs ??
          (options.timeout != null
            ? Math.max(0, options.timeout * 1000)
            : SSH2_CHANNEL_OPEN_TIMEOUT_MS);
        const timeoutHandle = setTimeout(() => {
          streamFromLateCallback?.close();
          fail(new Error("SSH2 exec channel timed out"));
        }, timeoutMs);
        timeoutHandle.unref?.();

        const cleanup = () => {
          options.abortSignal?.removeEventListener("abort", onAbort);
          clearTimeout(timeoutHandle);
        };

        const finish = (handler: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          handler();
        };

        // Every failure ends the slot here; success hands it to the channel instead.
        const fail = (error: Error) =>
          finish(() => {
            slot.release();
            reject(error);
          });

        const onAbort = () => {
          streamFromLateCallback?.close();
          fail(new Error("Operation aborted"));
        };

        options.abortSignal?.addEventListener("abort", onAbort, { once: true });
        if (options.abortSignal?.aborted) {
          onAbort();
          return;
        }

        const onExec = (err?: Error, stream?: ClientChannel) => {
          if (settled) {
            stream?.close();
            return;
          }
          streamFromLateCallback = stream;
          if (err) {
            fail(err);
            return;
          }
          if (!stream) {
            fail(new Error("SSH2 exec did not return a stream"));
            return;
          }
          // Attach inside the callback: ssh2 can emit this channel's close in
          // the same tick, before an await continuation would run (#4876).
          finish(() => {
            slot.attach(stream);
            resolve(stream);
          });
        };

        try {
          if (options.forcePTY) {
            client.exec(fullCommand, { pty: { term: "xterm-256color" } }, onExec);
          } else {
            client.exec(fullCommand, onExec);
          }
        } catch (error) {
          // ssh2 throws synchronously when the client is no longer connected.
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });

      // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
      const process = new SSH2ChildProcess(channel, () =>
        closedClients.has(client)
      ) as unknown as ChildProcess;
      return {
        process,
        onExit: () => {
          ssh2ConnectionPool.markHealthy(this.config);
        },
        onError: (error) => {
          ssh2ConnectionPool.reportFailure(this.config, getErrorMessage(error));
        },
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      const wasAborted =
        (options.abortSignal?.aborted ?? false) || errorMessage === "Operation aborted";
      if (!wasAborted) {
        ssh2ConnectionPool.reportFailure(this.config, errorMessage);
      }
      throw new RuntimeErrorClass(
        `SSH2 command failed: ${errorMessage}`,
        wasAborted ? "exec" : "network",
        error instanceof Error ? error : undefined
      );
    }
  }

  async openReverseForward(remotePort: number, localPort: number): Promise<ReverseForward> {
    // A dedicated connection, like OpenSSH's `ssh -N`: see openDedicatedConnection.
    const client = await ssh2ConnectionPool.openDedicatedConnection(this.config);
    const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
    routeForwardedConnections(client, localPort);
    try {
      await new Promise<void>((resolve, reject) => {
        client.forwardIn("127.0.0.1", remotePort, (err) => (err ? reject(err) : resolve()));
      });
    } catch (error) {
      client.destroy();
      throw error;
    }
    // destroy(), not end(): end() only half-closes, and a forward needs no graceful goodbye.
    return { closed, close: () => client.destroy() };
  }

  async createPtySession(params: PtySessionParams): Promise<PtyHandle> {
    const entry = await ssh2ConnectionPool.acquireConnection(this.config, { maxWaitMs: 0 });
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      // Busy from the request on, and bounded, as in spawnRemoteProcess.
      const slot = ssh2ConnectionPool.reserveChannel(this.config, entry);
      let settled = false;
      const timeoutHandle = setTimeout(
        () => fail(new Error("SSH2 shell channel timed out")),
        SSH2_CHANNEL_OPEN_TIMEOUT_MS
      );
      timeoutHandle.unref?.();
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        slot.release();
        reject(error);
      };
      try {
        entry.client.shell(
          {
            term: "xterm-256color",
            cols: params.cols,
            rows: params.rows,
          },
          (err, stream) => {
            if (settled) {
              // The open timed out: close the late channel, its slot is already free.
              stream?.close();
              return;
            }
            if (err) {
              fail(err);
              return;
            }
            if (!stream) {
              fail(new Error("SSH2 shell did not return a stream"));
              return;
            }
            settled = true;
            clearTimeout(timeoutHandle);
            // Same-tick close is possible here too (see spawnRemoteProcess).
            slot.attach(stream);
            resolve(stream);
          }
        );
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });

    // expandTildeForSSH already returns a quoted string (e.g., "$HOME/path")
    // Do NOT wrap with shellQuotePath - that would double-quote it
    // Exit on cd failure to match OpenSSH transport behavior (cd ... && exec $SHELL -i)
    const expandedPath = expandTildeForSSH(params.workspacePath);
    channel.write(`cd ${expandedPath} || exit 1\n`);
    if (params.shellPrelude) channel.write(`${params.shellPrelude}:\n`);

    return new SSH2Pty(channel);
  }
}
