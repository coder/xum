import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { BrowserWindow } from "electron";
import { electronTest as test, electronExpect as expect } from "../electronTest";
import { ONCHAT_REPLAY_TIMING_LOG_MESSAGE } from "../../../src/node/services/onChatReplayTiming";
import { getFreePort, startXumServer, type XumServerProcess } from "../utils/xumServerProcess";

// The desktop normally takes server.lock with its own API server, and `xum server` refuses to
// start while another process holds it. Keep the desktop off the lock so this scenario can start
// and restart a real server on the same root while the app runs (#4846). Debug logs include the
// per-replay `onChat replay` lines (and give the token check more output to search).
const SCENARIO_ENV = { XUM_NO_API_SERVER: "1", XUM_LOG_LEVEL: "debug" } as const;
const previousEnv = new Map<string, string | undefined>();
test.beforeAll(() => {
  for (const [key, value] of Object.entries(SCENARIO_ENV)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
});
test.afterAll(() => {
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Count `onChat replay` log lines for one workspace. Desktop and server share <root>/logs. */
function countReplays(logsDir: string, workspaceId: string): number {
  if (!fs.existsSync(logsDir)) return 0;
  const marker = ` ${ONCHAT_REPLAY_TIMING_LOG_MESSAGE} {`;
  let count = 0;
  for (const file of fs.readdirSync(logsDir).filter((name) => /^mux(\.\d+)?\.log$/.test(name))) {
    for (const line of fs.readFileSync(path.join(logsDir, file), "utf-8").split("\n")) {
      const index = line.indexOf(marker);
      if (index === -1) continue;
      const fields = JSON.parse(line.slice(index + marker.length - 1)) as { workspaceId?: string };
      if (fields.workspaceId === workspaceId) count++;
    }
  }
  return count;
}

function readLogs(logsDir: string): string {
  if (!fs.existsSync(logsDir)) return "";
  return fs
    .readdirSync(logsDir)
    .map((name) => fs.readFileSync(path.join(logsDir, name), "utf-8"))
    .join("\n");
}

test("opens the running xum server next to the local window", async ({
  app,
  page,
  ui,
  workspace,
}, testInfo) => {
  test.setTimeout(240_000);
  const desktopOutput: string[] = [];
  app.process().stdout?.on("data", (chunk: Buffer) => desktopOutput.push(chunk.toString()));
  app.process().stderr?.on("data", (chunk: Buffer) => desktopOutput.push(chunk.toString()));
  const root = workspace.configRoot;
  const logsDir = path.join(root, "logs");
  const serverLog = testInfo.outputPath("xum-server.log");
  const localWorkspaceId = workspace.demoProject.workspaceId;
  const tokens: string[] = [];
  const servers: XumServerProcess[] = [];
  const openLocalServer = () =>
    page.evaluate(() => {
      const bridge = window.api?.remoteConnection;
      if (!bridge) throw new Error("The local window has no remote connection bridge");
      return bridge.openLocalServer();
    });
  // A signed-in server page answers oRPC calls over its WebSocket; a token prompt means it cannot.
  const serverProjectCount = (serverPage: Page) =>
    serverPage.evaluate(async () => {
      if (document.querySelector('input[type="password"]')) return "token prompt";
      const api = window.__ORPC_CLIENT__;
      if (!api) return "no client";
      return api.projects.list().then(
        (projects) => projects.length,
        () => "rejected"
      );
    });
  const getState = () =>
    page.evaluate(() => {
      const bridge = window.api?.remoteConnection;
      if (!bridge) throw new Error("The local window has no remote connection bridge");
      return bridge.getState();
    });

  try {
    // The local window keeps one onChat subscription (the demo workspace) throughout.
    await ui.projects.openFirstWorkspace();
    await expect.poll(() => countReplays(logsDir, localWorkspaceId)).toBeGreaterThan(0);
    const localReplays = countReplays(logsDir, localWorkspaceId);
    const localWindow = await app.browserWindow(page);

    // No server on this root yet.
    expect(await openLocalServer()).toEqual({ status: "unavailable" });
    expect((await getState()).error).toContain("No running xum server");

    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    tokens.push(randomBytes(32).toString("hex"));
    servers.push(await startXumServer({ root, port, token: tokens[0], logPath: serverLog }));

    const opened = app.waitForEvent("window");
    expect(await openLocalServer()).toEqual({ status: "shown" });
    const serverPage = await opened;
    // The server's own web UI signs in with the lock token: no token prompt.
    await expect.poll(() => serverProjectCount(serverPage), { timeout: 30_000 }).toBe(1);
    const serverPageInfo = await serverPage.evaluate(() => ({
      origin: location.origin,
      href: location.href,
      api: typeof window.api,
    }));
    expect(serverPageInfo.origin).toBe(baseUrl);
    expect(serverPageInfo.api).toBe("undefined");
    expect(serverPageInfo.href.includes(tokens[0])).toBe(false);
    expect(await getState()).toEqual({ status: "connected", serverUrl: baseUrl });

    // The local window stays visible and keeps using its own backend.
    expect(await localWindow.evaluate((window: BrowserWindow) => window.isVisible())).toBe(true);
    await ui.chat.sendMessage("local window still works");
    await ui.chat.expectTranscriptContains("Mock response: local window still works");

    // Re-invoking focuses the same page: no new window and no reload.
    let serverNavigations = 0;
    serverPage.on("framenavigated", (frame) => {
      if (frame === serverPage.mainFrame()) serverNavigations++;
    });
    const windowCount = app.windows().length;
    expect(await openLocalServer()).toEqual({ status: "shown" });
    expect(app.windows()).toHaveLength(windowCount);
    expect(serverNavigations).toBe(0);

    // A restart on the same port brings a new token. Re-invoking reloads the page with it.
    await servers[0].stop();
    tokens.push(randomBytes(32).toString("hex"));
    servers.push(await startXumServer({ root, port, token: tokens[1], logPath: serverLog }));
    expect(await openLocalServer()).toEqual({ status: "shown" });
    expect(serverNavigations).toBeGreaterThan(0);
    await expect.poll(() => serverProjectCount(serverPage), { timeout: 30_000 }).toBe(1);
    expect(app.windows()).toHaveLength(windowCount);

    // The server window's load landed on the server process only: the desktop backend replayed
    // nothing new for the local window's workspace.
    expect(countReplays(logsDir, localWorkspaceId)).toBe(localReplays);

    // Server gone: close its window, and the action reports that nothing is running.
    await servers[1].stop();
    await serverPage.close();
    await expect.poll(async () => (await getState()).status).toBe("disconnected");
    expect(await openLocalServer()).toEqual({ status: "unavailable" });
    expect((await getState()).error).toContain("No running xum server");
    expect(await localWindow.evaluate((window: BrowserWindow) => window.isVisible())).toBe(true);
    await localWindow.dispose();
  } finally {
    for (const server of servers) await server.stop();
  }

  // Tokens never reach desktop output or either process's logs. Compare booleans only so a
  // failure cannot print the token.
  const output = [desktopOutput.join(""), fs.readFileSync(serverLog, "utf-8"), readLogs(logsDir)];
  for (const token of tokens) {
    expect(output.some((text) => text.includes(token))).toBe(false);
  }
});
