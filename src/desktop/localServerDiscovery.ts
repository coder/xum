import { parseRemoteConnectionUrl } from "@/common/types/remoteConnection";
import type { ServerLockData } from "@/node/services/serverLockfile";

/**
 * Turn this root's server.lock into the URL a sandboxed server window loads (#4846).
 *
 * SECURITY AUDIT: the result carries the server token as the browser client's `?token=`
 * parameter. Only the main process may hold it: pass it straight to RemoteConnectionManager,
 * never to the local renderer, a log line, or persisted state. The page moves the token to its
 * partition storage and strips it from the address bar.
 */
export function getLocalServerLoadUrl(lock: ServerLockData | null, selfPid: number): string | null {
  // The desktop's own API server is not "a running xum server" to open in another window.
  if (lock == null || lock.pid === selfPid) return null;
  let url: URL;
  try {
    // The lock's baseUrl is the server's own connectable URL (wildcard binds are recorded as
    // 127.0.0.1). Use it verbatim, but only as a credential-free HTTP(S) URL.
    url = parseRemoteConnectionUrl(lock.baseUrl);
  } catch {
    return null;
  }
  // Servers started with --no-auth record an empty token.
  if (lock.token) url.searchParams.set("token", lock.token);
  return url.href;
}
