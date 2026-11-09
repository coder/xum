import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocketServer } from "ws";
import { BROWSER_BRIDGE_WS_PATH, DESKTOP_WS_PATH, ORPC_WS_PATH } from "../src/node/orpc/wsPaths";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SECRET = "browser-token-that-must-not-leak";

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

// While nodemon restarts the backend, its TCP port is free for any local account to bind. The
// browser reconnects through the Vite proxy and its URL carries the token, so the proxy must send
// that traffic only to a name that other accounts cannot create: the backend's socket in a private
// folder. This test runs the real vite.config.ts with a fake backend on that socket and a squatter
// on the backend's TCP port.
describe.skipIf(process.platform === "win32")(
  "the dev server's hop from Vite to the backend",
  () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "xum-vite-sock-"));
    const socketPath = path.join(base, "b.sock");
    const backendSeen: string[] = [];
    const squatterBytes: Buffer[] = [];
    let squatterConnections = 0;
    let vitePort = 0;
    let backend: http.Server;
    let squatter: net.Server;
    let vite: ReturnType<typeof Bun.spawn>;

    beforeAll(async () => {
      const wss = new WebSocketServer({ noServer: true });
      backend = http.createServer((req, res) => {
        backendSeen.push(`http ${req.url}`);
        res.end("backend");
      });
      backend.on("upgrade", (req, socket, head) => {
        backendSeen.push(`ws ${req.url}`);
        wss.handleUpgrade(req, socket, head, (ws) => ws.send("backend"));
      });
      await new Promise<void>((resolve) => backend.listen(socketPath, resolve));

      squatter = net.createServer((socket) => {
        squatterConnections++;
        socket.on("data", (chunk) => squatterBytes.push(chunk));
        socket.on("error", () => undefined);
      });
      const backendPort = await freePort();
      await new Promise<void>((resolve) => squatter.listen(backendPort, "127.0.0.1", resolve));

      vitePort = await freePort();
      const script = `
      import { createServer } from "vite";
      const server = await createServer({ configFile: "vite.config.ts", logLevel: "silent" });
      await server.listen();
      console.log("READY");
      process.stdin.on("end", async () => { await server.close(); process.exit(0); });
      process.stdin.resume();`;
      vite = Bun.spawn(["node", "--input-type=module", "-e", script], {
        cwd: REPO_ROOT,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          XUM_VITE_PORT: String(vitePort),
          XUM_BACKEND_PORT: String(backendPort),
          XUM_BACKEND_SOCKET: socketPath,
        },
      });
      const reader = (vite.stdout as ReadableStream<Uint8Array>).getReader();
      let out = "";
      while (!out.includes("READY")) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`Vite exited before it was ready: ${out}`);
        out += new TextDecoder().decode(value);
      }
    }, 60_000);

    afterAll(async () => {
      (vite.stdin as { end(): void }).end();
      await vite.exited;
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
      if (backend.listening) {
        await new Promise<void>((resolve) => backend.close(() => resolve()));
      }
      fs.rmSync(base, { recursive: true, force: true });
    });

    // A squatter never answers, so a request that reaches it must time out instead of hanging the test.
    const fetchText = async (url: string) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
        return await res.text();
      } catch {
        return "unreachable";
      }
    };

    const openWebSocket = (route: string) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${vitePort}${route}`);
        const timer = setTimeout(() => resolve("timeout"), 5_000);
        ws.onmessage = (event) => {
          clearTimeout(timer);
          ws.close();
          resolve(String(event.data));
        };
        ws.onerror = () => {
          clearTimeout(timer);
          resolve("error");
        };
      });

    test("HTTP and all three WebSocket routes, token included, reach only the backend's socket", async () => {
      const answers: string[] = [];
      for (const route of ["/api/ping", "/auth/x", "/health", "/version"]) {
        answers.push(await fetchText(`http://127.0.0.1:${vitePort}${route}?token=${SECRET}`));
      }
      for (const route of [ORPC_WS_PATH, BROWSER_BRIDGE_WS_PATH, DESKTOP_WS_PATH]) {
        answers.push(await openWebSocket(`${route}?token=${SECRET}`));
      }

      expect(squatterConnections).toBe(0);
      expect(Buffer.concat(squatterBytes).toString()).not.toContain(SECRET);
      expect(answers).toEqual(Array.from({ length: 7 }, () => "backend"));
      expect(backendSeen).toHaveLength(7);
      expect(backendSeen.every((line) => line.endsWith(`token=${SECRET}`))).toBe(true);
    }, 30_000);

    test("a WebSocket upgrade with a disallowed Host is refused before the backend sees it", async () => {
      const before = backendSeen.length;
      const response = await new Promise<string>((resolve) => {
        const socket = net.connect(vitePort, "127.0.0.1", () => {
          socket.write(
            `GET ${ORPC_WS_PATH}?token=${SECRET} HTTP/1.1\r\nHost: evil.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${Buffer.from("0123456789abcdef").toString("base64")}\r\n\r\n`
          );
        });
        let data = "";
        socket.on("data", (chunk) => (data += chunk.toString()));
        socket.on("close", () => resolve(data));
        socket.on("error", () => resolve(data));
      });
      expect(response.split("\r\n")[0]).toBe("HTTP/1.1 404 Not Found");
      expect(backendSeen).toHaveLength(before);
      expect(squatterConnections).toBe(0);
    });

    test("with the backend stopped mid-restart, a process on its TCP port gets nothing", async () => {
      await new Promise<void>((resolve) => backend.close(() => resolve()));
      backend.closeAllConnections();
      fs.rmSync(socketPath, { force: true });

      const res = await fetch(`http://127.0.0.1:${vitePort}/api/ping?token=${SECRET}`);
      expect(res.status).toBe(500);
      expect(await openWebSocket(`${ORPC_WS_PATH}?token=${SECRET}`)).not.toBe("backend");

      expect(squatterConnections).toBe(0);
      expect(Buffer.concat(squatterBytes).toString()).not.toContain(SECRET);
    });
  }
);
