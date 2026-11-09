#!/usr/bin/env node
// Starts the real vite.config.ts dev server in front of a fake backend and prints, as one JSON line,
// the status line that each `ws: true` proxy answers to a WebSocket upgrade for several Host headers.
//
// Why a script: bun cannot import vite.config.ts (vite-plugin-top-level-await needs node), and Vite
// applies server.allowedHosts to HTTP and its HMR socket but not to proxied upgrades, so the proxy
// `bypass` in vite.config.ts is the only guard. scripts/viteWsHostProbe.test.ts runs this under node.
//
// Usage: node scripts/viteWsHostProbe.mjs

import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function freePort() {
  const probe = net.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// Sends one upgrade request and returns the first response line, or null if the socket closed unanswered.
function upgrade(port, requestPath, host) {
  return new Promise((resolve) => {
    const lines = [
      `GET ${requestPath} HTTP/1.1`,
      ...(host === null ? [] : [`Host: ${host}`]),
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "",
      "",
    ];
    const socket = net.connect(port, "127.0.0.1", () => socket.write(lines.join("\r\n")));
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString();
      if (received.includes("\r\n")) socket.destroy();
    });
    socket.on("close", () => resolve(received.split("\r\n")[0] || null));
    socket.on("error", () => socket.destroy());
  });
}

const watchdog = setTimeout(() => {
  console.error("viteWsHostProbe timed out");
  process.exit(1);
}, 60_000);

// Every upgrade that reaches the backend is answered 101, so a 101 proves the request was proxied.
const backend = http.createServer();
backend.on("upgrade", (_req, socket) => {
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
});
const backendPort = await listen(backend);
const vitePort = await freePort();

for (const name of [
  "XUM_VITE_ALLOWED_HOSTS",
  "MUX_VITE_ALLOWED_HOSTS",
  "VITE_ALLOWED_HOSTS",
  "XUM_VITE_HOST",
  "MUX_VITE_HOST",
]) {
  delete process.env[name];
}
process.env.XUM_VITE_PORT = String(vitePort);
process.env.XUM_BACKEND_PORT = String(backendPort);
process.env.XUM_BACKEND_HOST = "127.0.0.1";

const vite = await createServer({
  root: ROOT,
  configFile: path.join(ROOT, "vite.config.ts"),
  logLevel: "silent",
  // No dependency scan and no file watcher: the probe only needs the proxy.
  optimizeDeps: { noDiscovery: true },
  server: { watch: null },
});
await vite.listen();

const wsContexts = Object.entries(vite.config.server.proxy ?? {})
  .filter(([, options]) => options.ws)
  .map(([context]) => context);

const hosts = [
  `localhost:${vitePort}`,
  `127.0.0.1:${vitePort}`,
  "evil.example",
  `evil.example:${vitePort}`,
  null,
];
const results = [];
for (const context of wsContexts) {
  for (const host of hosts) {
    results.push({ context, host, status: await upgrade(vitePort, context, host) });
  }
}
console.log(JSON.stringify({ wsContexts, results }));

await vite.close();
backend.close();
clearTimeout(watchdog);
process.exit(0);
