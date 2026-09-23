import { spawn } from "child_process";

import { spawnPtyProcess } from "../ptySpawn";
import { expandTildeForSSH } from "../tildeExpansion";
import {
  appendOpenSSHHostKeyPolicyArgs,
  sshConnectionPool,
  type SSHConnectionConfig,
} from "../sshConnectionPool";
import type { SpawnResult } from "../RemoteRuntime";
import type {
  SSHTransport,
  SSHTransportAcquireOptions,
  SSHTransportConfig,
  SpawnOptions,
  PtyHandle,
  PtySessionParams,
} from "./SSHTransport";

const MAX_REPORTED_FAILURE_STDERR_CHARS = 1000;
const OPENSSH_EXEC_SHARD_COUNT = 4;
const nextShardByConnection = new Map<string, number>();

function summarizeFailureStderr(stderr: string, exitCode: number): string {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) {
    return `SSH exited with code ${exitCode}`;
  }
  if (trimmed.length <= MAX_REPORTED_FAILURE_STDERR_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_REPORTED_FAILURE_STDERR_CHARS)}…`;
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
    await sshConnectionPool.acquireConnection(this.config, {
      abortSignal: options?.abortSignal,
      timeoutMs: options?.timeoutMs,
      maxWaitMs: options?.maxWaitMs,
      onWait: options?.onWait,
    });
  }

  async spawnRemoteProcess(fullCommand: string, options: SpawnOptions): Promise<SpawnResult> {
    const remainingWaitMs =
      options.deadlineMs != null ? Math.max(0, options.deadlineMs - Date.now()) : undefined;
    const controlPath = getShardedControlPath(this.config);
    await sshConnectionPool.acquireConnection(this.config, {
      abortSignal: options.abortSignal,
      timeoutMs: remainingWaitMs,
      maxWaitMs: remainingWaitMs,
      controlPath,
    });

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
          sshConnectionPool.reportFailure(this.config, summarizeFailureStderr(stderr, exitCode));
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
    args.push(`cd ${expandedPath} && exec $SHELL -i`);

    return spawnPtyProcess({
      runtimeLabel: "SSH",
      command: "ssh",
      args,
      cwd: process.cwd(),
      cols: params.cols,
      rows: params.rows,
    });
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
