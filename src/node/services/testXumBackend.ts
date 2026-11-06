import * as http from "http";
import type { AddressInfo, Socket } from "net";
import { spawn, type ChildProcess } from "child_process";
import { getSelfIdentity, linuxBirth } from "../utils/concurrency/processLiveness";

/**
 * Test doubles for the processes that server.lock can name. A real ServerLockfile.peek() asks the
 * lock's baseUrl whether a xum backend answers there, so a test that writes a lock for a live
 * backend needs something that answers like one, and a test for a recycled pid needs an unrelated
 * live process.
 */

export type FakeBackendMode =
  /** Answers `GET <prefix>/version` like a xum backend. */
  | "xum"
  /** Answers every request with a 404 page: some other server owns the port. */
  | "other"
  /** Accepts connections and never answers. */
  | "hang";

export interface FakeBackend {
  baseUrl: string;
  /** Every request received, with the headers it carried. */
  requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }>;
  close: () => Promise<void>;
}

export async function startFakeBackend(
  mode: FakeBackendMode,
  options: { prefix?: string; onRequest?: () => Promise<void> } = {}
): Promise<FakeBackend> {
  const prefix = options.prefix ?? "";
  const requests: FakeBackend["requests"] = [];
  const sockets = new Set<Socket>();
  const answer = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    if (mode === "hang") return;
    // A test that changes the world while the request is pending (a restart during the probe).
    await options.onRequest?.();
    if (mode === "xum" && req.method === "GET" && req.url === `${prefix}/version`) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ git_commit: "abc", git_describe: "v0.0.0-test", mode: "server" }));
      return;
    }
    res.statusCode = 404;
    res.end("<html>not found</html>");
  };
  const server = http.createServer((req, res) => {
    answer(req, res).catch(() => res.destroy());
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}${prefix}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A base URL that nothing serves: a port that was free a moment ago. */
export async function unservedBaseUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/**
 * A live process that is not a xum backend and not this one: the process that now holds a dead
 * backend's pid. Kill it with `kill()`. `exited` settles once the process is gone and reaped, so
 * its pid is free (until then a killed process is a zombie, which still holds the pid).
 */
export function startUnrelatedProcess(): {
  pid: number;
  kill: () => void;
  exited: Promise<void>;
} {
  const child: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  if (child.pid == null) throw new Error("could not start an unrelated process");
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return { pid: child.pid, kill: () => child.kill("SIGKILL"), exited };
}

/**
 * The process identity that a backend with `pid` records in its lock (this host and boot, that
 * pid's start time). Meaningful where /proc exists; elsewhere `birth` is null.
 */
export function identityOf(pid: number): Record<string, unknown> {
  return { ...getSelfIdentity(), birth: linuxBirth(pid) };
}
