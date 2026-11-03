import { beforeAll, describe, expect, test } from "bun:test";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

interface DryRun {
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
  return { commands, token };
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
  let open: DryRun;
  let otherGoal: DryRun;

  beforeAll(async () => {
    [first, second, ambient, chosen, dollar, envOverrides, open, otherGoal] = await Promise.all([
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
