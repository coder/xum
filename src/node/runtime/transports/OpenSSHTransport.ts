import { spawn } from "child_process";

import { spawnPtyProcess } from "../ptySpawn";
import { cdThenExecShell, runInPosixShell } from "../streamUtils";
import { expandTildeForSSH } from "../tildeExpansion";
import {
  appendOpenSSHHostKeyPolicyArgs,
  sshConnectionPool,
  type SSHConnectionConfig,
} from "../sshConnectionPool";
import type { SpawnResult } from "../RemoteRuntime";
import { RuntimeError } from "../Runtime";
import { assert } from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import type {
  SSHTransport,
  SSHTransportAcquireOptions,
  SSHTransportConfig,
  SpawnOptions,
  PtyHandle,
  PtySessionParams,
  ReverseForward,
} from "./SSHTransport";

const OPENSSH_EXEC_SHARD_COUNT = 4;
const nextShardByConnection = new Map<string, number>();

/**
 * Pool acquisition failures (backoff, unhealthy host, failed probe) mean the
 * host is unreachable, not that a remote file is missing: report them as
 * transport failures like SSH2Transport does (#4438). Aborts stay as-is.
 * The message is preserved so existing string checks keep working.
 */
function toAcquisitionError(error: unknown, abortSignal: AbortSignal | undefined): unknown {
  if (abortSignal?.aborted === true || error instanceof RuntimeError) return error;
  return new RuntimeError(getErrorMessage(error), "network", error);
}

function getShardedControlPath(config: SSHConnectionConfig): string {
  const baseControlPath = sshConnectionPool.getControlPath(config);
  const nextShard = nextShardByConnection.get(baseControlPath) ?? 0;
  nextShardByConnection.set(baseControlPath, (nextShard + 1) % OPENSSH_EXEC_SHARD_COUNT);
  return `${baseControlPath}-${nextShard}`;
}

export class OpenSSHTransport implements SSHTransport {
  constructor(private readonly config: SSHConnectionConfig) {}

  isConnectionFailure(exitCode: number, _stderr: string): boolean {
    return exitCode === 255;
  }

  getConfig(): SSHTransportConfig {
    return this.config;
  }

  async acquireConnection(options?: SSHTransportAcquireOptions): Promise<void> {
    try {
      await sshConnectionPool.acquireConnection(this.config, {
        abortSignal: options?.abortSignal,
        timeoutMs: options?.timeoutMs,
        maxWaitMs: options?.maxWaitMs,
        onWait: options?.onWait,
      });
    } catch (error) {
      throw toAcquisitionError(error, options?.abortSignal);
    }
  }

  async spawnRemoteProcess(fullCommand: string, options: SpawnOptions): Promise<SpawnResult> {
    const remainingWaitMs =
      options.deadlineMs != null ? Math.max(0, options.deadlineMs - Date.now()) : undefined;
    const controlPath = getShardedControlPath(this.config);
    try {
      await sshConnectionPool.acquireConnection(this.config, {
        abortSignal: options.abortSignal,
        timeoutMs: remainingWaitMs,
        maxWaitMs: remainingWaitMs,
        controlPath,
      });
    } catch (error) {
      throw toAcquisitionError(error, options.abortSignal);
    }

    // Shard short-lived SSH execs across a few deterministic ControlPaths so the host no longer
    // funnels all multiplexed sessions through one implicit master socket.
    const sshArgs: string[] = [
      options.forcePTY ? "-tt" : "-T",
      ...this.buildBaseSSHArgs(),
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPath=${controlPath}`,
      "-o",
      "ControlPersist=60",
    ];

    const connectTimeout =
      options.timeout !== undefined ? Math.min(Math.ceil(options.timeout), 15) : 15;
    sshArgs.push("-o", `ConnectTimeout=${connectTimeout}`);
    sshArgs.push("-o", "ServerAliveInterval=5");
    sshArgs.push("-o", "ServerAliveCountMax=2");
    sshArgs.push("-o", "BatchMode=yes");
    appendOpenSSHHostKeyPolicyArgs(sshArgs);
    sshArgs.push(this.config.host, fullCommand);

    const process = spawn("ssh", sshArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    return {
      process,
      onExit: (exitCode, stderr) => {
        if (this.isConnectionFailure(exitCode, stderr)) {
          // F3 (formal/ssh-pool, MC_openssh_fixed): ssh exits 255 both when the connection
          // fails and when the remote command itself exits 255 (a nested `ssh` that is
          // refused, `exit(-1)`), and the two look the same here. Ask for a re-probe instead
          // of a backoff: only the probe can tell, and its failure sets the backoff and the
          // pool's last error. The command's stderr is not the host's error: recording it
          // made a nested "Permission denied (" read as a permanent auth failure.
          sshConnectionPool.requireReprobe(this.config);
          return;
        }
        sshConnectionPool.markHealthy(this.config);
      },
      onError: (error) => {
        sshConnectionPool.reportFailure(this.config, error.message);
      },
    };
  }

  async createPtySession(params: PtySessionParams): Promise<PtyHandle> {
    await this.acquireConnection({ maxWaitMs: 0 });

    const args: string[] = [...this.buildBaseSSHArgs()];
    args.push("-o", "ControlMaster=no");
    args.push("-o", "ConnectTimeout=15");
    args.push("-o", "ServerAliveInterval=5");
    args.push("-o", "ServerAliveCountMax=2");
    args.push("-t");
    args.push(this.config.host);

    // expandTildeForSSH already returns a quoted string (e.g., "$HOME/path")
    // Do NOT wrap with shellQuotePath - that would double-quote it
    const expandedPath = expandTildeForSSH(params.workspacePath);
    // sh runs the cd and scratch prelude; $SHELL -i still opens the account's own shell.
    args.push(runInPosixShell(cdThenExecShell(expandedPath, params.shellPrelude, "$SHELL -i")));

    return spawnPtyProcess({
      runtimeLabel: "SSH",
      command: "ssh",
      args,
      cwd: process.cwd(),
      cols: params.cols,
      rows: params.rows,
    });
  }

  /**
   * A dedicated `ssh -N -R` process per forward. It never shares the exec ControlMasters: those
   * respawn implicitly (ControlMaster=auto, ControlPersist=60), which would drop a forward that
   * was added to them. ExitOnForwardFailure makes a refused or busy remote port end the process.
   */
  async openReverseForward(remotePort: number, localPort: number): Promise<ReverseForward> {
    assert(Number.isInteger(remotePort) && remotePort > 0 && remotePort < 65536, "bad remotePort");
    assert(Number.isInteger(localPort) && localPort > 0 && localPort < 65536, "bad localPort");
    await this.acquireConnection({ maxWaitMs: 0 });

    const args: string[] = [];
    if (this.config.port) args.push("-p", this.config.port.toString());
    if (this.config.identityFile) args.push("-i", this.config.identityFile);
    args.push(
      "-N",
      "-T",
      // ControlPath=none: never join a ControlMaster from the user's ~/.ssh/config either.
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=5",
      "-o",
      "ServerAliveCountMax=2",
      "-o",
      "BatchMode=yes",
      "-o",
      "LogLevel=ERROR",
      "-R",
      `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`
    );
    appendOpenSSHHostKeyPolicyArgs(args);
    args.push(this.config.host);

    const child = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString();
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => {
      child.once("close", (code) => {
        if (stderr.trim()) {
          log.debug("[ssh] reverse forward ended", { host: this.config.host, code, stderr });
        }
        resolve();
      });
    });
    return {
      closed,
      close: () => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      },
    };
  }

  private buildBaseSSHArgs(): string[] {
    const args: string[] = [];

    if (this.config.port) {
      args.push("-p", this.config.port.toString());
    }

    if (this.config.identityFile) {
      args.push("-i", this.config.identityFile);
    }

    args.push("-o", "LogLevel=FATAL");
    return args;
  }
}
