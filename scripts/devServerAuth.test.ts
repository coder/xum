import { beforeAll, describe, expect, test } from "bun:test";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

interface DryRun {
  /** XUM_BACKEND_SOCKET as make exports it to the recipe's processes (env, not secret). */
  socket: string | undefined;
  /** What make would run. Nothing starts, and it is argv-visible to every local account. */
  commands: string;
  /** XUM_SERVER_AUTH_TOKEN as make exports it to the recipe's processes (env, not argv). */
  token: string | undefined;
}

// `make -pn` prints the commands a goal would run, then make's variable database. The environment
// is minimal on purpose: the host's own server token (agent shells export one) must not leak in.
async function dryRun(
  goal: string,
  env: Record<string, string> = {},
  makeFlags: string[] = []
): Promise<DryRun> {
  const proc = Bun.spawn(["make", "-pn", ...makeFlags, goal], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  const databaseStart = stdout.indexOf("# Make data base");
  expect(databaseStart, "make -p must print its database").toBeGreaterThan(0);
  const commands = stdout.slice(0, databaseStart);
  // The database prints each `$` of a value as `$$`.
  const token = /^XUM_SERVER_AUTH_TOKEN := (.*)$/m
    .exec(stdout.slice(databaseStart))?.[1]
    ?.replaceAll("$$", "$");
  const socket = /^XUM_BACKEND_SOCKET :?= (.*)$/m.exec(stdout.slice(databaseStart))?.[1];
  return { commands, token, socket };
}

function exportedToken(run: DryRun): string {
  if (run.token === undefined) throw new Error("make did not export XUM_SERVER_AUTH_TOKEN");
  return run.token;
}

function backendCommand(run: DryRun): string {
  const lines = run.commands
    .split("\n")
    .filter((line) => line.includes("dist/cli/index.js server"));
  expect(lines, "the dev-server recipe must start the backend").toHaveLength(1);
  return lines[0];
}

// Any other local account can reach a loopback port, and an open backend runs commands as the
// developer. `make dev-server` therefore starts the backend with a token.
describe("make dev-server auth", () => {
  let first: DryRun;
  let second: DryRun;
  let ambient: DryRun;
  let chosen: DryRun;
  let dollar: DryRun;
  let envOverrides: DryRun;
  let poisonedFlag: DryRun;
  let open: DryRun;
  let otherGoal: DryRun;

  beforeAll(async () => {
    [first, second, ambient, chosen, dollar, envOverrides, poisonedFlag, open, otherGoal] =
      await Promise.all([
        dryRun("dev-server"),
        dryRun("dev-server"),
        dryRun("dev-server", {
          XUM_SERVER_AUTH_TOKEN: "host-server-token",
          MUX_SERVER_AUTH_TOKEN: "legacy-host-server-token",
        }),
        dryRun("dev-server", { XUM_DEV_SERVER_AUTH_TOKEN: "chosen-dev-token" }),
        dryRun("dev-server", { XUM_DEV_SERVER_AUTH_TOKEN: "pa$$word$(x)$" }),
        // `make -e` lets the environment override makefile assignments.
        dryRun("dev-server", { XUM_SERVER_AUTH_TOKEN: "host-server-token" }, ["-e"]),
        dryRun("dev-server", { DEV_SERVER_AUTH_FLAG: "--no-auth" }, ["-e"]),
        dryRun("dev-server", { XUM_DEV_SERVER_NO_AUTH: "1" }),
        dryRun("help"),
      ]);
  }, 60_000);

  test("starts the backend with auth on and a fresh random token per run", () => {
    expect(backendCommand(first)).not.toContain("--no-auth");
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    expect(second.token).toMatch(/^[0-9a-f]{64}$/);
    expect(second.token).not.toBe(first.token);
  });

  test("keeps the token out of every command line", () => {
    expect(first.commands).not.toContain(exportedToken(first));
  });

  test("never reuses the token of the server the shell already talks to", () => {
    expect(ambient.token).toMatch(/^[0-9a-f]{64}$/);
    expect(backendCommand(ambient)).not.toContain("--no-auth");
  });

  test("XUM_DEV_SERVER_AUTH_TOKEN picks the token", () => {
    expect(chosen.token).toBe("chosen-dev-token");
    expect(backendCommand(chosen)).not.toContain("--no-auth");
  });

  test("a chosen token reaches the backend byte for byte, even with dollar signs", () => {
    expect(dollar.token).toBe("pa$$word$(x)$");
  });

  test("make -e does not let the ambient server token override the generated one", () => {
    expect(envOverrides.token).toMatch(/^[0-9a-f]{64}$/);
  });

  test("make -e does not let an inherited flag switch auth off", () => {
    expect(backendCommand(poisonedFlag)).not.toContain("--no-auth");
  });

  test("XUM_DEV_SERVER_NO_AUTH=1 is the only way to an open backend", () => {
    expect(backendCommand(open)).toContain("--no-auth");
    expect(open.token).toBeUndefined();
  });

  test("goals other than dev-server do not generate a token", () => {
    expect(otherGoal.token).toBeUndefined();
  });
});

// Vite serves any file under its root at /@fs/<path> to whoever reaches its port, and its proxy
// passes the token check on to the backend. So the token on disk must not be servable there. Its
// public/ folder is served without file checks, so XUM_ROOT still has to stay outside the checkout.
describe("vite dev server", () => {
  test("never serves a server.lock or the files Vite denies by default, but serves source", async () => {
    // Vite's config cannot be loaded under Bun (its plugins need Node), so ask Node.
    const script = `
      import { isFileLoadingAllowed, resolveConfig } from "vite";
      import * as path from "node:path";
      const config = await resolveConfig({ configFile: "vite.config.ts" }, "serve", "development");
      const allowed = (rel) => isFileLoadingAllowed(config, path.resolve(rel));
      console.log(JSON.stringify({
        rootLock: allowed("server.lock"),
        nestedLock: allowed(".dev-home/nested/server.lock"),
        env: allowed(".env"),
        gitConfig: allowed(".git/config"),
        source: allowed("src/browser/App.tsx"),
      }));`;
    const proc = Bun.spawn(["node", "--input-type=module", "-e", script], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      rootLock: false,
      nestedLock: false,
      env: false,
      gitConfig: false,
      source: true,
    });
  }, 60_000);
});

// Any local account can bind the backend's TCP port while nodemon restarts the backend, and the
// browser's reconnect URL carries the token. So Vite reaches the backend over a Unix socket in a
// private folder, and make hands both sides the same path.
describe.skipIf(process.platform === "win32")("make dev-server backend socket", () => {
  let socketRun: DryRun;
  let otherPort: DryRun;
  let chosen: DryRun;
  let windows: DryRun;
  let otherGoal: DryRun;

  beforeAll(async () => {
    [socketRun, otherPort, chosen, windows, otherGoal] = await Promise.all([
      dryRun("dev-server", { XUM_BACKEND_PORT: "3111" }),
      dryRun("dev-server", { XUM_BACKEND_PORT: "3222" }),
      dryRun("dev-server", { XUM_BACKEND_SOCKET: "/run/me/custom.sock" }),
      dryRun("dev-server", {}, ["OS=Windows_NT"]),
      dryRun("help"),
    ]);
  }, 60_000);

  const socketArgument = (run: DryRun) => /--unix-socket (\S+)/.exec(backendCommand(run))?.[1];

  test("the backend listens on the exported path, and the path fits sun_path", () => {
    expect(socketRun.socket).toBeDefined();
    const socket = socketRun.socket as string;
    expect(socket.startsWith("/")).toBe(true);
    expect(socket).toMatch(/b3111\.sock$/);
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(100);
    expect(socketArgument(socketRun)).toBe(socket);
  });

  test("each backend port gets its own socket", () => {
    expect(otherPort.socket).toMatch(/b3222\.sock$/);
    expect(otherPort.socket).not.toBe(socketRun.socket);
  });

  test("XUM_BACKEND_SOCKET picks the path for both sides", () => {
    expect(chosen.socket).toBe("/run/me/custom.sock");
    expect(socketArgument(chosen)).toBe("/run/me/custom.sock");
  });

  test("Windows keeps TCP: no socket for Vite or the backend", () => {
    expect(windows.socket).toBeUndefined();
    expect(backendCommand(windows)).not.toContain("--unix-socket");
  });

  test("other goals export no socket", () => {
    expect(otherGoal.socket).toBeUndefined();
  });
});
