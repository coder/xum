import { afterEach, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { electronControlPath, type ElectronAppControl } from "../bugbash/appControl";
import { type Spawn, xumElectron } from "./electronProvider";

const ALL: Record<string, string> = {
  XUM_MOCK_AI: "1",
  XUM_DISABLE_AGENT_TOOLS: "1",
  XUM_DISABLE_TERMINALS: "1",
  XUM_DISABLE_PROJECT_AUTOMATION: "1",
};

let tmp = "";
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xum-electron-provider-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** The control file that `startApp.ts --electron` writes, with these app switches. */
function control(switches: Record<string, string>): void {
  const app: ElectronAppControl = { pid: 1, port: 4321, root: "/tmp/root", switches, ready: true };
  fs.writeFileSync(electronControlPath(tmp), JSON.stringify(app));
}

/** A spawn that records its env and starts nothing: the child exits at once. */
function recordingSpawn() {
  const calls: Record<string, string>[] = [];
  const spawn = ((_cmd: string, _args: string[], options: { env: Record<string, string> }) => {
    calls.push(options.env);
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    return child as unknown as ChildProcess;
  }) as unknown as Spawn;
  return { spawn, calls };
}

const request = (env: Record<string, string>) => ({
  runId: "run",
  targetName: "electron",
  slot: 0,
  slots: 1,
  env,
  signal: new AbortController().signal,
  log: () => undefined,
});
const runEnv = (extra: Record<string, string> = {}) => ({
  PATH: "/usr/bin",
  TMPDIR: tmp,
  HOME: "/home/bugbash",
  DISPLAY: ":99",
  ...extra,
});

test.each(Object.keys(ALL))("refuses to spawn Electron without %s", async (name) => {
  const { [name]: _dropped, ...rest } = ALL;
  control(rest);
  const { spawn, calls } = recordingSpawn();
  // The run env cannot add it back: Electron's switches come only from the app's control file.
  const provider = xumElectron(spawn);
  const error = await provider.acquire(request(runEnv({ [name]: "1" }))).catch((e: unknown) => e);
  expect(String(error)).toContain(`Xum Electron without ${name}`);
  expect(calls).toEqual([]);
});

test("spawns Electron with the allowlisted env only", async () => {
  control(ALL);
  const { spawn, calls } = recordingSpawn();
  const provider = xumElectron(spawn);
  const secret = { ANTHROPIC_API_KEY: "sk-x", XUM_ALLOW_MULTIPLE_INSTANCES: "1" };
  // The fake child has no pid, so acquire stops right after the spawn.
  const error = await provider.acquire(request(runEnv(secret))).catch((e: unknown) => e);
  expect(String(error)).toContain("did not start");
  expect(calls).toEqual([
    {
      PATH: "/usr/bin",
      TMPDIR: tmp,
      HOME: "/home/bugbash",
      DISPLAY: ":99",
      ...ALL,
      XUM_ROOT: "/tmp/root",
      XUM_E2E: "1",
      XUM_DEVSERVER_HOST: "127.0.0.1",
      XUM_DEVSERVER_PORT: "4321",
      XUM_DISABLE_TELEMETRY: "1",
      XUM_NO_API_SERVER: "1",
    },
  ]);
});
