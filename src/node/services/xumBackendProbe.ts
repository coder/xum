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
  return new Promise<BackendProbe>((resolve) => {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      return resolve("no");
    }
    const client = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
    if (client == null || url.username !== "" || url.password !== "") return resolve("no");
    // The base URL can carry a path prefix (a reverse proxy mount), so append rather than resolve.
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/version`;
    url.search = "";
    url.hash = "";

    const timeout = AbortSignal.timeout(timeoutMs);
    let connected = false;
    let responded = false;
    const request = client.get(url, { signal: timeout }, (response) => {
      responded = true;
      const settle = (answer: BackendProbe) => {
        resolve(answer);
        request.destroy();
      };
      if (response.statusCode !== 200) return settle("no");
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_ANSWER_BYTES) return settle("no");
        chunks.push(chunk);
      });
      response.on("end", () =>
        settle(isVersionAnswer(Buffer.concat(chunks).toString("utf8")) ? "answers" : "no")
      );
      response.on("error", () => settle("no"));
    });
    request.on("socket", (socket) => {
      if (socket.connecting) socket.once("connect", () => (connected = true));
      else connected = true; // a socket that the agent kept from an earlier request
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
