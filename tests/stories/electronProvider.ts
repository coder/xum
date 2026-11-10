/**
 * The Electron story target's browser provider (e2e.electron.config.ts): one Xum Electron per
 * attempt, on the XUM_ROOT that `startApp.ts --electron` seeded, with the renderer from that
 * process's loopback server. e2e attaches over CDP; the attempt's first page is the main window.
 *
 * Electron runs the whole backend in its main process, so its env decides what an agent can
 * reach. It gets an allowlist, never the worker's env (electronEnv):
 * - PATH, TMPDIR, HOME and DISPLAY (Xvfb, sandbox/entry.ts) from the run's env;
 * - the root and port from the control file, and the switches that startApp.ts gave its seed
 *   server (appSwitches): the mock AI and all three kill switches, or the provider refuses;
 * - XUM_E2E with the dev-server host and port: Electron loads the renderer over http.
 * - XUM_NO_API_SERVER: no HTTP/WS API server next to the IPC transport (src/desktop/main.ts).
 * Never XUM_ALLOW_MULTIPLE_INSTANCES: it skips the single-instance lock that a deep link of a
 * second launch needs (deepLink.e2e.ts).
 *
 * `--no-sandbox`: Chromium's sandbox needs capabilities that the bug-bash container drops. The
 * renderer loads only the built bundle from loopback, in a container with no network.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BrowserProvider } from "@e2e-dev/web";
import { type ElectronAppControl, readElectronControl } from "../bugbash/appControl";

const REPO = path.resolve(import.meta.dirname, "../..");
export const ELECTRON = path.join(REPO, "node_modules/electron/dist/electron");
type Env = Readonly<Record<string, string | undefined>>;
export type Spawn = typeof nodeSpawn;

/** The switches the Electron app must get, each "1". */
const REQUIRED = [
  "XUM_MOCK_AI",
  "XUM_DISABLE_AGENT_TOOLS",
  "XUM_DISABLE_TERMINALS",
  "XUM_DISABLE_PROJECT_AUTOMATION",
] as const;
const FROM_RUN = ["PATH", "TMPDIR", "HOME", "DISPLAY"] as const;
const WINDOW_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 5_000;

/** The renderer's origin: the target's app URL and the main window's URL. */
export const appUrl = (app: ElectronAppControl) => `http://127.0.0.1:${app.port}`;

/** The env of Xum Electron (header): an allowlist. */
export function electronEnv(env: Env, app: ElectronAppControl): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FROM_RUN) if (env[name] != null) out[name] = env[name];
  for (const name of REQUIRED) if (app.switches[name] != null) out[name] = app.switches[name];
  return {
    ...out,
    XUM_ROOT: app.root,
    XUM_E2E: "1",
    XUM_DEVSERVER_HOST: "127.0.0.1",
    XUM_DEVSERVER_PORT: String(app.port),
    XUM_DISABLE_TELEMETRY: "1",
    XUM_NO_API_SERVER: "1",
  };
}

/** Why Electron must not start with `env`, or null. Checked on the env that spawn gets. */
export function electronEnvRefusal(env: Record<string, string>): string | null {
  const off = REQUIRED.filter((name) => env[name] !== "1");
  if (off.length > 0) return `Xum Electron without ${off.join(", ")}`;
  if ("XUM_ALLOW_MULTIPLE_INSTANCES" in env)
    return "Xum Electron with XUM_ALLOW_MULTIPLE_INSTANCES (it skips the single-instance lock)";
  if (env.DISPLAY == null) return "Xum Electron without DISPLAY (Xvfb, sandbox/entry.ts)";
  return null;
}

/** The control file that `startApp.ts --electron` wrote, from the run's TMPDIR. */
export function electronApp(env: Env): ElectronAppControl {
  const app = readElectronControl(env.TMPDIR ?? "/tmp");
  if (app == null) throw new Error("no Electron control file: the target's app did not seed");
  return app;
}

/** Where Electron's output goes: beside the app log, so it comes back with the job's output. */
function electronLog(env: Env): fs.WriteStream | undefined {
  const appLog = env.BUGBASH_APP_LOG;
  if (appLog == null) return undefined;
  return fs.createWriteStream(path.join(path.resolve(path.dirname(appLog)), "electron.log"), {
    flags: "a",
  });
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGTERM to Electron's process group (zygote, GPU, renderers), 5 s, then SIGKILL. Never
 * rejects: the abort handler cannot await it.
 */
export async function killGroup(pid: number): Promise<void> {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return; // the group is gone
  }
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // gone between the check and the kill
  }
}

/**
 * Starts `electron . <args>` with electronEnv in its own process group, after the refusal check.
 * The caller owns the group: killGroup(child.pid).
 */
export function spawnElectron(env: Env, args: string[], spawn: Spawn = nodeSpawn): ChildProcess {
  const app = electronApp(env);
  const childEnv = electronEnv(env, app);
  const refused = electronEnvRefusal(childEnv);
  if (refused != null) throw new Error(`${refused}: it does not start`);
  const child = spawn(ELECTRON, ["--no-sandbox", ".", ...args], {
    cwd: REPO,
    env: childEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = electronLog(env);
  if (log != null) {
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    child.once("close", () => log.end());
  }
  return child;
}

/** The DevTools endpoint that Chromium prints to stderr once its port listens. */
function devtoolsEndpoint(child: ChildProcess, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = "";
    const onData = (chunk: Buffer) => {
      seen = (seen + chunk.toString()).slice(-8192);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
      if (match != null) {
        child.stderr?.off("data", onData);
        resolve(match[1]);
      }
    };
    child.stderr?.on("data", onData);
    child.once("exit", (code, sig) =>
      reject(
        new Error(
          `Xum Electron exited (${code ?? sig}) before DevTools listened: ${seen.slice(-2000)}`
        )
      )
    );
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

/** Waits until the main window's page target loads the app URL. */
async function mainWindow(ws: string, url: string, signal: AbortSignal): Promise<void> {
  const http = ws.replace(/^ws:/, "http:").replace(/\/devtools\/.*$/, "");
  const deadline = Date.now() + WINDOW_TIMEOUT_MS;
  let last: unknown;
  while (!signal.aborted) {
    try {
      const response = await fetch(`${http}/json/list`, { signal: AbortSignal.timeout(2000) });
      last = await response.json();
      if (
        Array.isArray(last) &&
        last.some(
          (t: { type?: unknown; url?: unknown }) =>
            t.type === "page" && typeof t.url === "string" && t.url.startsWith(url)
        )
      )
        return;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline)
      throw new Error(`no main window at ${url} within 60 s: ${JSON.stringify(last)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("aborted");
}

/** One Xum Electron per attempt (header). `spawn`: a unit test injects one. */
export function xumElectron(spawn: Spawn = nodeSpawn): BrowserProvider {
  return {
    name: "xum-electron",
    // A fresh app per attempt, on the persistent default context: no app.clearState, extra
    // headers, locale or state capture (e2e refuses those for this scope).
    scope: "attempt",
    async acquire(request) {
      const child = spawnElectron(request.env, ["--remote-debugging-port=0"], spawn);
      const pid = child.pid;
      if (pid == null) throw new Error("Xum Electron did not start");
      // Else a cancelled attempt leaves Electron running, and it keeps the single-instance lock.
      // For the lease's whole life: the signal also aborts when the attempt exceeds its budget.
      request.signal.addEventListener("abort", () => void killGroup(pid), { once: true });
      try {
        const ws = await devtoolsEndpoint(child, request.signal);
        await mainWindow(ws, appUrl(electronApp(request.env)), request.signal);
        request.log(`Xum Electron pid ${pid}, ${ws}`);
        return { id: String(pid), cdpEndpoint: ws };
      } catch (error) {
        await killGroup(pid);
        throw error;
      }
    },
    async release(lease) {
      await killGroup(Number(lease.id));
    },
  };
}
