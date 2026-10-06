/** Adapts an SSH (or Coder) workspace runtime to the reverse-forward manager. */
import assert from "node:assert/strict";

import { CoderSSHRuntime } from "@/node/runtime/CoderSSHRuntime";
import type { Runtime } from "@/node/runtime/Runtime";
import { SSHRuntime } from "@/node/runtime/SSHRuntime";
import { execBuffered } from "@/node/utils/runtime/helpers";

import type { ForwardTarget } from "./reverseForwards";
import { BASH_AI_PROXY_HEALTH_PATH, isHealthNonce } from "./stableIdentity";

/**
 * A request to the proxy health endpoint from the remote host, in bash only: the host needs no
 * curl. HTTP/1.0 makes the proxy close the connection, which ends `cat`.
 */
export function remoteHealthScript(remotePort: number, nonce: string): string {
  // Both values are checked to be digits and hex, so plain interpolation is safe here.
  assert(Number.isInteger(remotePort) && remotePort > 0 && remotePort < 65536, "bad remotePort");
  assert(isHealthNonce(nonce), "bad health nonce");
  return (
    `exec 3<>/dev/tcp/127.0.0.1/${remotePort} || exit 3; ` +
    `printf 'GET ${BASH_AI_PROXY_HEALTH_PATH}?nonce=${nonce} HTTP/1.0\\r\\n\\r\\n' >&3; cat <&3`
  );
}

export function createSshForwardTarget(runtime: Runtime): ForwardTarget | undefined {
  // MultiProjectRuntime, Docker and devcontainer are not SSH runtimes: no forward.
  if (!(runtime instanceof SSHRuntime)) return undefined;
  const config = runtime.getConfig();
  return {
    hostKey: [config.host, config.port ?? 22, config.identityFile ?? ""].join("|"),
    restoreAtStartup: !(runtime instanceof CoderSSHRuntime),
    openReverseForward: (remotePort, localPort) =>
      runtime.openReverseForward(remotePort, localPort),
    remoteHealth: async (remotePort, nonce) => {
      const result = await execBuffered(runtime, remoteHealthScript(remotePort, nonce), {
        cwd: "/",
        timeout: 8,
        maxOutputBytes: 4096,
      });
      return result.exitCode === 0 ? result.stdout : undefined;
    },
  };
}
