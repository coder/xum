import { ServerLockfile } from "@/node/services/serverLockfile";

/**
 * `make dev-server` starts the backend with a per-run token and records it in the root's
 * server.lock. The token authorizes command execution, so it goes only to the server the lock names.
 */
export async function readSandboxToken(args: { baseUrl: string; root: string }): Promise<string> {
  const lock = await new ServerLockfile(args.root).peek();
  if (lock == null) return "";
  if (new URL(lock.baseUrl).origin !== new URL(args.baseUrl).origin) {
    throw new Error(
      `--base-url ${args.baseUrl} is not the server that ${args.root}/server.lock names (${lock.baseUrl}); not sending its token there`
    );
  }
  return lock.token;
}
