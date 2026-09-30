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
}

export interface SSHTransportAcquireOptions {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  maxWaitMs?: number;
  onWait?: (waitMs: number) => void;
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
}
