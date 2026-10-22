import { ssh2ConnectionPool } from "../SSH2ConnectionPool";
import type { SSHConnectionConfig } from "../sshConnectionPool";
import {
  OpenSSHTransport,
  closeOpenSSHReverseForward,
  retireOpenSSHMasters,
} from "./OpenSSHTransport";
import { SSH2Transport } from "./SSH2Transport";
import type { SSHTransport } from "./SSHTransport";

export type { SSHTransport, PtyHandle, PtySessionParams, ReverseForward } from "./SSHTransport";
export { OpenSSHTransport };
export { ReverseForwardRefusedError } from "./SSHTransport";

export function createSSHTransport(config: SSHConnectionConfig, useSSH2: boolean): SSHTransport {
  return useSSH2 ? new SSH2Transport(config) : new OpenSSHTransport(config);
}

const retiredHostListeners = new Set<(host: string) => void>();

/**
 * Connections the pools do not hold (a reverse forward opens its own) close through these when
 * their host is retired. Returns the unsubscribe.
 */
export function onSshHostRetired(listener: (host: string) => void): () => void {
  retiredHostListeners.add(listener);
  return () => retiredHostListeners.delete(listener);
}

/** Retire the host's connections on both transports (credentials or gateway changed). */
export async function retireSshConnections(config: SSHConnectionConfig): Promise<void> {
  ssh2ConnectionPool.retireConnection(config);
  for (const listener of retiredHostListeners) listener(config.host);
  // The listeners close forwards this process owns; one adopted after a restart has no handle.
  await Promise.all([retireOpenSSHMasters(config), closeOpenSSHReverseForward(config)]);
}
