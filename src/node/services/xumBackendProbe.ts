import * as http from "http";
import * as https from "https";
import { z } from "zod";

/**
 * How long probeXumBackend() waits for a backend that has connected and not answered. A listener
 * that accepts a connection and never answers cannot hold up a reader of server.lock for longer.
 */
export const XUM_BACKEND_PROBE_TIMEOUT_MS = 2_000;

/** A /version answer is a few hundred bytes. A longer one is not from a xum backend. */
const MAX_ANSWER_BYTES = 4_096;

/** What the server's own `GET /version` returns: `{ ...VERSION, mode: "server" }`. */
const VersionAnswerSchema = z.object({ mode: z.literal("server"), git_describe: z.string() });

/**
 * - `answers`: a xum backend answered.
 * - `silent`: something accepted the connection and sent no answer within the timeout. A backend
 *   that is frozen (SIGSTOP, a long synchronous task, a debugger stop) looks like this, because
 *   the kernel accepts connections for it.
 * - `no`: nothing connected (refused, unreachable, an unusable URL), the connection ended
 *   without an answer, or the answer was not a xum backend's.
 */
export type BackendProbe = "answers" | "silent" | "no";

/** The client for a URL's scheme, or null for a scheme that is not plain http(s). */
function clientFor(url: URL): typeof http | typeof https | null {
  if (url.protocol === "https:") return https;
  return url.protocol === "http:" ? http : null;
}

/** `GET <baseUrl>/version`: its URL and client, or null when `baseUrl` cannot be used. */
function versionRequest(baseUrl: string): { url: URL; client: typeof http | typeof https } | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  const client = clientFor(url);
  if (client == null || url.username !== "" || url.password !== "") return null;
  // The base URL can carry a path prefix (a reverse proxy mount), so append rather than resolve.
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/version`;
  url.search = "";
  url.hash = "";
  return { url, client };
}

/** Whether a response is a 200 with a `/version` answer of a xum server, read within a size cap. */
function isVersionResponse(response: http.IncomingMessage): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (response.statusCode !== 200) return resolve(false);
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_ANSWER_BYTES) return resolve(false);
      chunks.push(chunk);
    });
    response.on("end", () => resolve(isVersionAnswer(Buffer.concat(chunks).toString("utf8"))));
    response.on("error", () => resolve(false));
  });
}

/**
 * Asks the lock's `baseUrl` whether a xum backend runs there. peek() uses it only where the
 * lock's process identity cannot decide: macOS, Windows, and locks that an older build wrote.
 *
 * The request carries no header and no token: the lock's `baseUrl` can name any process. A
 * redirect is not followed. The answer is public (`GET /version` needs no token), so a process
 * that copies it still reads as `answers`: on those platforms only the identity check can close
 * that case.
 */
export function probeXumBackend(
  baseUrl: string,
  timeoutMs: number = XUM_BACKEND_PROBE_TIMEOUT_MS
): Promise<BackendProbe> {
  const target = versionRequest(baseUrl);
  if (target == null) return Promise.resolve("no");
  const { url, client } = target;
  return new Promise<BackendProbe>((resolve) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    let connected = false;
    let responded = false;
    // agent: false is a new connection for this request only, so the socket below is never one that
    // an agent kept from an earlier request.
    const request = client.get(url, { signal: timeout, agent: false }, (response) => {
      responded = true;
      void isVersionResponse(response).then((isVersion) => {
        resolve(isVersion ? "answers" : "no");
        request.destroy();
      });
    });
    request.on("socket", (socket) => {
      socket.once("connect", () => (connected = true));
    });
    // Only the timeout of a connection that was made and never answered is "silent": a reset or
    // a close is an answer, and a connect that times out is no listener.
    request.on("error", () =>
      resolve(timeout.aborted && connected && !responded ? "silent" : "no")
    );
  });
}

function isVersionAnswer(body: string): boolean {
  try {
    return VersionAnswerSchema.safeParse(JSON.parse(body)).success;
  } catch {
    return false;
  }
}
