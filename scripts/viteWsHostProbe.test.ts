import { describe, expect, test } from "bun:test";
import * as path from "path";

import { BROWSER_BRIDGE_WS_PATH, DESKTOP_WS_PATH } from "../src/node/orpc/wsPaths";

const PROBE = path.join(import.meta.dir, "viteWsHostProbe.mjs");

interface ProbeResult {
  context: string;
  host: string | null;
  status: string | null;
}

interface ProbeOutput {
  wsContexts: string[];
  results: ProbeResult[];
}

async function runProbe(): Promise<ProbeOutput> {
  const proc = Bun.spawn(["node", PROBE], {
    env: { ...process.env, NODE_ENV: "development" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  return JSON.parse(stdout.trim()) as ProbeOutput;
}

// Vite checks server.allowedHosts for HTTP and its HMR socket but not for proxied WebSocket
// upgrades, so the `bypass` on each `ws: true` proxy in vite.config.ts is the only guard. bun cannot
// import vite.config.ts, so the probe starts the real config under node.
describe("vite dev-server WebSocket proxies", () => {
  test("refuse a Host that is not allowed, and proxy a loopback Host", async () => {
    const { wsContexts, results } = await runProbe();

    // A new `ws: true` proxy must carry the bypass in vite.config.ts. List it here once it does.
    expect([...wsContexts].sort()).toEqual(["/orpc", BROWSER_BRIDGE_WS_PATH, DESKTOP_WS_PATH].sort());
    for (const context of wsContexts) {
      const own = results.filter((result) => result.context === context);
      expect(own.length, context).toBeGreaterThanOrEqual(5);
      for (const { host, status } of own) {
        const refused = host === null || host.startsWith("evil.example");
        expect(status, `${context} Host: ${host}`).toBe(
          refused ? "HTTP/1.1 404 Not Found" : "HTTP/1.1 101 Switching Protocols"
        );
      }
    }
  }, 60_000);
});
