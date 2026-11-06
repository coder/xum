import * as http from "http";
import * as https from "https";
import { z } from "zod";

/**
 * How long answersAsXumBackend() waits for the whole answer. A backend that has not answered by
 * then counts as not running, so a listener that accepts a connection and never answers cannot
 * hold up every reader of server.lock.
 */
export const XUM_BACKEND_PROBE_TIMEOUT_MS = 2_000;

/** A /version answer is a few hundred bytes. A longer one is not from a xum backend. */
const MAX_ANSWER_BYTES = 4_096;

/** What the server's own `GET /version` returns: `{ ...VERSION, mode: "server" }`. */
const VersionAnswerSchema = z.object({ mode: z.literal("server"), git_describe: z.string() });

/**
 * Whether a xum backend answers at `baseUrl` (the `baseUrl` of a server.lock).
 *
 * server.lock names a pid, and the OS reuses pids: after a crash, an unrelated process (or the
 * next run of a container, where each run is pid 1) can hold the dead backend's pid, so the pid
 * alone reads such a lock as live. A backend that really runs answers `GET /version`.
 *
 * The request carries no header and no token: the lock's `baseUrl` can name any process, and this
 * answer decides whether the lock's token is ever sent there. A redirect is not followed. A URL
 * that cannot be used, a refused or timed-out connection, a status other than 200 and any other
 * answer all mean "no".
 */
export function answersAsXumBackend(
  baseUrl: string,
  timeoutMs: number = XUM_BACKEND_PROBE_TIMEOUT_MS
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      return resolve(false);
    }
    const client = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
    if (client == null || url.username !== "" || url.password !== "") return resolve(false);
    // The base URL can carry a path prefix (a reverse proxy mount), so append rather than resolve.
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/version`;
    url.search = "";
    url.hash = "";

    const request = client.get(url, { signal: AbortSignal.timeout(timeoutMs) }, (response) => {
      const settle = (answers: boolean) => {
        resolve(answers);
        request.destroy();
      };
      if (response.statusCode !== 200) return settle(false);
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_ANSWER_BYTES) return settle(false);
        chunks.push(chunk);
      });
      response.on("end", () => settle(isVersionAnswer(Buffer.concat(chunks).toString("utf8"))));
      response.on("error", () => settle(false));
    });
    request.on("error", () => resolve(false));
  });
}

function isVersionAnswer(body: string): boolean {
  try {
    return VersionAnswerSchema.safeParse(JSON.parse(body)).success;
  } catch {
    return false;
  }
}
