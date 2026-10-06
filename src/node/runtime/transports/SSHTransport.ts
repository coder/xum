import type { SpawnResult } from "../RemoteRuntime";
import type { SSHConnectionConfig } from "../sshConnectionPool";

export type SSHTransportConfig = SSHConnectionConfig;

export interface PtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(handler: (data: string) => void): { dispose: () => void };
  onExit(handler: (event: { exitCode: number; signal?: number }) => void): { dispose: () => void };
}

export interface SpawnOptions {
  forcePTY?: boolean;
  timeout?: number;
  abortSignal?: AbortSignal;
  /** Absolute client-side deadline (Date.now milliseconds) for queueing + execution. */
  deadlineMs?: number;
}

export interface PtySessionParams {
  workspacePath: string;
  cols: number;
  rows: number;
  /**
   * Shell commands run after the cd, before the interactive shell starts (ends with "; ").
   * Visible in the remote command line: never put secrets here.
   */
  shellPrelude?: string;
}

export interface SSHTransportAcquireOptions {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  maxWaitMs?: number;
  onWait?: (waitMs: number) => void;
}

/**
 * A remote listener on the SSH host's 127.0.0.1:remotePort whose connections reach
 * 127.0.0.1:localPort on the backend host (`ssh -R`). Used by the bash AI proxy so commands on
 * SSH and Coder runtimes can reach it.
 */
export interface ReverseForward {
  /** Settles when the forward ends: connection lost, process exit, or close(). Never rejects. */
  readonly closed: Promise<void>;
  close(): void;
}

export interface SSHTransport {
  /** Spawn a command on the remote host, returning a ChildProcess-compatible object. */
  spawnRemoteProcess(command: string, options: SpawnOptions): Promise<SpawnResult>;

  /** Determine if an exit code represents a connection-level failure for this transport. */
  isConnectionFailure(exitCode: number, stderr: string): boolean;

  /** Pre-flight connection check with backoff enforcement. */
  acquireConnection(options?: SSHTransportAcquireOptions): Promise<void>;

  /** Get underlying config (for PTY terminal spawning). */
  getConfig(): SSHTransportConfig;

  /** Create interactive PTY session for the transport. */
  createPtySession(params: PtySessionParams): Promise<PtyHandle>;

  /**
   * Starts a reverse forward. Resolving means the request was made, not that the remote port is
   * bound: the caller must prove the forward end to end (the bash AI proxy probes its health
   * endpoint through it). Rejects when the forward cannot start at all.
   */
  openReverseForward(remotePort: number, localPort: number): Promise<ReverseForward>;
}
