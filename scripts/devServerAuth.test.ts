import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

// make claims the default socket folder at parse time, in `$XDG_RUNTIME_DIR` or /tmp. A dry run must
// not leave one on the test host, so every make call here gets a runtime dir of its own.
//
// The base is under /tmp, not os.tmpdir(): macOS's os.tmpdir() is a long /var/folders/... path, and
// `<base>/xum-dev-<uid>/b3111-192.168.1.5.sock` must fit the 103 bytes of a macOS socket path.
const SHORT_TMP = process.platform === "win32" ? os.tmpdir() : "/tmp";
const RUNTIME_BASE = fsSync.mkdtempSync(path.join(SHORT_TMP, "xum-make-base-"));
afterAll(() => fsSync.rmSync(RUNTIME_BASE, { recursive: true, force: true }));

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
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      XDG_RUNTIME_DIR: RUNTIME_BASE,
      ...env,
    },
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

function exportedSocket(run: DryRun): string {
  if (run.socket === undefined) throw new Error("make did not export XUM_BACKEND_SOCKET");
  return run.socket;
}

async function shell(script: string, env: Record<string, string>): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", script], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  return stdout.replace(/\n$/, "");
}

function backendCommand(run: DryRun): string {
  const lines = run.commands
    .split("\n")
    .filter((line) => line.includes("dist/cli/index.js server"));
  expect(lines, "the dev-server recipe must start the backend").toHaveLength(1);
  return lines[0];
}

/**
 * The `--unix-socket` value that `node` receives when the recipe's backend line runs with the
 * socket that make exports. It runs the real shell layers with a `node` that prints its argv.
 */
async function backendSocketArgument(run: DryRun): Promise<string> {
  const socket = exportedSocket(run);
  const line = backendCommand(run).trim().replace(/\\$/, "");
  // What the recipe's shell hands to concurrently as one argument.
  const handedOn = await shell(`printf '%s' ${line}`, { XUM_BACKEND_SOCKET: socket });
  const exec = /--exec '(.*)'$/s.exec(handedOn)?.[1];
  if (exec === undefined) throw new Error(`no --exec in ${handedOn}`);
  // nodemon runs the exec string in a shell.
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), "xum-fake-node-"));
  try {
    await fs.writeFile(path.join(bin, "node"), '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n', {
      mode: 0o755,
    });
    const argv = (
      await shell(exec, { XUM_BACKEND_SOCKET: socket, PATH: `${bin}:${process.env.PATH ?? ""}` })
    ).split("\n");
    const flag = argv.indexOf("--unix-socket");
    expect(flag, `no --unix-socket in ${JSON.stringify(argv)}`).toBeGreaterThanOrEqual(0);
    return argv[flag + 1];
  } finally {
    await fs.rm(bin, { recursive: true, force: true });
  }
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
  test("never serves a server.lock (or its temporary file) or the files Vite denies by default, but serves source", async () => {
    // Vite's config cannot be loaded under Bun (its plugins need Node), so ask Node.
    const script = `
      import { isFileLoadingAllowed, resolveConfig } from "vite";
      import * as path from "node:path";
      const config = await resolveConfig({ configFile: "vite.config.ts" }, "serve", "development");
      const allowed = (rel) => isFileLoadingAllowed(config, path.resolve(rel));
      console.log(JSON.stringify({
        rootLock: allowed("server.lock"),
        nestedLock: allowed(".dev-home/nested/server.lock"),
        tempLock: allowed(".dev-home/server.lock.4242.tmp"),
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
      tempLock: false,
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
  let windowsAmbient: DryRun;
  let otherHost: DryRun;
  let ipv6Host: DryRun;
  let otherGoal: DryRun;

  beforeAll(async () => {
    [socketRun, otherPort, chosen, windows, windowsAmbient, otherHost, ipv6Host, otherGoal] =
      await Promise.all([
        dryRun("dev-server", { XUM_BACKEND_PORT: "3111" }),
        dryRun("dev-server", { XUM_BACKEND_PORT: "3222" }),
        dryRun("dev-server", { XUM_BACKEND_SOCKET: "/run/me/custom.sock" }),
        dryRun("dev-server", {}, ["OS=Windows_NT"]),
        dryRun("dev-server", { XUM_BACKEND_SOCKET: "/run/me/ambient.sock" }, ["OS=Windows_NT"]),
        dryRun("dev-server", { XUM_BACKEND_PORT: "3111", XUM_BACKEND_HOST: "192.168.1.5" }),
        dryRun("dev-server", { XUM_BACKEND_PORT: "3111", XUM_BACKEND_HOST: "::1" }),
        dryRun("help"),
      ]);
  }, 60_000);

  test("the backend listens on the exported path, and the path fits sun_path", async () => {
    const socket = exportedSocket(socketRun);
    expect(socket.startsWith(`${RUNTIME_BASE}${path.sep}`)).toBe(true);
    expect(socket).toMatch(/b3111-127\.0\.0\.1\.sock$/);
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(100);
    expect(await backendSocketArgument(socketRun)).toBe(socket);
  });

  test("each backend port gets its own socket", () => {
    expect(otherPort.socket).toMatch(/b3222-/);
    expect(otherPort.socket).not.toBe(socketRun.socket);
  });

  // Two backends on one port with different bind addresses can run together, so the socket name
  // needs the host as well, or the second backend would find the first one's socket in use.
  test("the same port on another host gets its own socket, and a host has no colons", () => {
    expect(otherHost.socket).toMatch(/b3111-192\.168\.1\.5\.sock$/);
    expect(otherHost.socket).not.toBe(socketRun.socket);
    expect(path.basename(exportedSocket(ipv6Host))).toBe("b3111-__1.sock");
  });

  test("XUM_BACKEND_SOCKET picks the path for both sides", async () => {
    expect(chosen.socket).toBe("/run/me/custom.sock");
    expect(await backendSocketArgument(chosen)).toBe("/run/me/custom.sock");
  });

  // The path reaches the backend through three shells: the recipe's, concurrently's and nodemon's
  // `--exec`. A path with spaces or quotes must still be one argument.
  test("a path with spaces and quotes reaches the backend as one argument", async () => {
    const spaced = `/tmp/xum a'b "c"/b.sock`;
    const run = await dryRun("dev-server", { XUM_BACKEND_SOCKET: spaced });
    expect(await backendSocketArgument(run)).toBe(spaced);
  }, 60_000);

  test("Windows keeps TCP: no socket for Vite or the backend", () => {
    expect(windows.socket ?? "").toBe("");
    expect(backendCommand(windows)).not.toContain("--unix-socket");
  });

  // The Windows recipe starts the backend on TCP only. An ambient path would still reach Vite, which
  // would proxy to a socket that nothing listens on.
  // Another account can create the default folder first (a name in /tmp is open to everyone). The
  // backend then refuses to put its socket there, so make picks a fresh private folder next to it.
  describe("the default socket folder", () => {
    const uid = process.getuid!();
    let runtimeDir: string;

    beforeEach(async () => {
      runtimeDir = await fs.mkdtemp(path.join(SHORT_TMP, "xum-make-test-"));
    });

    afterEach(async () => {
      await fs.rm(runtimeDir, { recursive: true, force: true });
    });

    // make builds for a while before the backend starts: it claims the folder (mode 0700) at once, so
    // another account cannot take the name in between.
    test("is $XDG_RUNTIME_DIR/xum-dev-<uid>, created private by make", async () => {
      const run = await dryRun("dev-server", {
        XDG_RUNTIME_DIR: runtimeDir,
        XUM_BACKEND_PORT: "3111",
      });
      expect(run.socket).toBe(path.join(runtimeDir, `xum-dev-${uid}`, "b3111-127.0.0.1.sock"));
      expect((await fs.stat(path.join(runtimeDir, `xum-dev-${uid}`))).mode & 0o777).toBe(0o700);
    });

    test("is kept when it is a private folder of ours", async () => {
      await fs.mkdir(path.join(runtimeDir, `xum-dev-${uid}`), { mode: 0o700 });
      const run = await dryRun("dev-server", {
        XDG_RUNTIME_DIR: runtimeDir,
        XUM_BACKEND_PORT: "3111",
      });
      expect(run.socket).toBe(path.join(runtimeDir, `xum-dev-${uid}`, "b3111-127.0.0.1.sock"));
    });

    test("is replaced by a fresh private folder when it is not safely ours", async () => {
      // A symlink stands in for the other account's folder: only root could make a folder of
      // another uid. The real nobody-owned case is in the PR's live proof.
      const elsewhere = path.join(runtimeDir, "elsewhere");
      await fs.mkdir(elsewhere, { mode: 0o700 });
      await fs.symlink(elsewhere, path.join(runtimeDir, `xum-dev-${uid}`));
      const run = await dryRun("dev-server", {
        XDG_RUNTIME_DIR: runtimeDir,
        XUM_BACKEND_PORT: "3111",
      });
      const socket = exportedSocket(run);
      const folder = path.dirname(socket);
      expect(path.dirname(folder)).toBe(runtimeDir);
      expect(path.basename(folder)).toMatch(new RegExp(`^xum-dev-${uid}\\.`));
      expect(path.basename(socket)).toBe("b3111-127.0.0.1.sock");
      expect((await fs.stat(folder)).mode & 0o777).toBe(0o700);
      expect(await fs.readdir(elsewhere)).toEqual([]);
      // The backend gets the same path as Vite.
      expect(await backendSocketArgument(run)).toBe(socket);
    });

    /** `make -pn dev-server` that is expected to stop: its exit code and stderr. */
    async function makeStops(xdgRuntimeDir: string) {
      const proc = Bun.spawn(["make", "-pn", "dev-server"], {
        cwd: REPO_ROOT,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          XDG_RUNTIME_DIR: xdgRuntimeDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      return { exitCode, stderr };
    }

    test("make stops with a message when the parent cannot be trusted", async () => {
      const shared = path.join(runtimeDir, "shared");
      await fs.mkdir(shared);
      await fs.chmod(shared, 0o777);
      const { exitCode, stderr } = await makeStops(shared);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("XUM_BACKEND_SOCKET");
      expect(stderr).toContain("XDG_RUNTIME_DIR");
      expect(await fs.readdir(shared)).toEqual([]);
    });

    // The backend refuses a path that does not fit sun_path, so a folder made for it would be an
    // empty folder for nothing: make stops first, and creates nothing.
    test("make stops with a message when the default path is too long, and creates nothing", async () => {
      const deep = path.join(runtimeDir, "d".repeat(100));
      await fs.mkdir(deep, { mode: 0o700 });
      const { exitCode, stderr } = await makeStops(deep);
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/too long/);
      expect(stderr).toContain("XUM_BACKEND_SOCKET");
      expect(await fs.readdir(deep)).toEqual([]);
    });
  });

  test("Windows ignores an ambient XUM_BACKEND_SOCKET", () => {
    expect(windowsAmbient.socket ?? "").toBe("");
  });

  test("other goals export no socket", () => {
    expect(otherGoal.socket).toBeUndefined();
  });
});
