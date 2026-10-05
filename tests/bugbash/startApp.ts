#!/usr/bin/env bun
/**
 * Starts one disposable, pre-seeded `xum server` for an `e2e explore` bug-bash run.
 *
 * e2e.config.ts runs this as the target's `app.command` with `--port {port}`, so every
 * explorer gets its own app on its own free port, and explorers never see each other's edits.
 *
 * Usage: bun tests/bugbash/startApp.ts --port <port>   (needs `make build`: dist/ + renderer)
 *
 * Steps:
 * 1. Create a temp root holding XUM_ROOT, HOME and a throwaway git repo.
 * 2. Start the server on a private port and seed it through the HTTP API: the demo project
 *    (trusted), one workspace with a few artifacts, onboarding marked seen, the artifacts
 *    experiment, and a fake Anthropic provider on a dead loopback port.
 * 3. Stop that server, then serve the same root on `--port`. e2e polls `--port` for readiness,
 *    so no explorer can open the app before seeding has finished.
 *
 * Safety: XUM_MOCK_AI=1 plays canned turns and refuses every real model call, and the server
 * gets only PATH, HOME (the temp one), the temp-dir variables and the XUM_* values set here, so
 * no provider credential reaches the app. The temp HOME protects real config, NOT the host
 * filesystem: the Terminal tab still runs real shell commands as this user. Charters must keep
 * explorers out of terminals until the app runs inside a container.
 */

import { spawn, spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const SERVER_ENTRY = path.join(REPO_ROOT, "dist/cli/index.js");
const PROJECT_NAME = "demo-app";
const WORKSPACE_TITLE = "Bug bash playground";

// Throws, so main() can stop the seed server and remove the temp root before exiting.
function fail(message: string): never {
  throw new Error(`[bugbash startApp] ${message}`);
}

function parsePort(argv: string[]): number {
  const index = argv.indexOf("--port");
  const raw = index >= 0 ? argv[index + 1] : undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fail(`expected --port <1-65535>, got ${String(raw)}`);
  }
  return port;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address == null || typeof address === "string") {
        reject(new Error("no TCP address"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) fail(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function createDemoRepo(dir: string): void {
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "README.md"),
    "# Demo app\n\nA small throwaway project for the Xum bug bash.\n"
  );
  fs.writeFileSync(
    path.join(dir, "src/math.ts"),
    "export function add(a: number, b: number): number {\n  return a + b;\n}\n"
  );
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", ".");
  git(
    dir,
    "-c",
    "user.name=Bug Bash",
    "-c",
    "user.email=bugbash@example.test",
    "commit",
    "-qm",
    "init"
  );
}

function startServer(port: number, env: NodeJS.ProcessEnv): ChildProcess {
  // stdio inherits, so e2e's `command.log` captures the server output of both phases.
  return spawn(
    "node",
    [SERVER_ENTRY, "server", "--host", "127.0.0.1", "--port", String(port), "--no-auth"],
    { env, stdio: ["ignore", "inherit", "inherit"] }
  );
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

async function waitForHealth(base: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) fail(`seed server exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail("seed server did not become healthy within 60 s");
}

async function api<T = unknown>(base: string, route: string, body: unknown): Promise<T> {
  const response = await fetch(`${base}/api/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) fail(`POST /api/${route} -> ${response.status}: ${text.slice(0, 500)}`);
  return (text.length > 0 ? JSON.parse(text) : undefined) as T;
}

async function waitForInit(statusFile: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(statusFile)) {
      const { status } = JSON.parse(fs.readFileSync(statusFile, "utf8")) as { status?: string };
      if (status === "success") return;
      if (status === "error") fail(`workspace setup failed, see ${statusFile}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail("workspace setup did not finish within 60 s");
}

async function seed(base: string, projectPath: string, xumRoot: string): Promise<void> {
  await api(base, "splashScreens/markSplashScreenViewed", { splashId: "onboarding-wizard-v1" });
  await api(base, "experiments/setOverride", { experimentId: "artifacts", enabled: true });
  // The composer refuses to send without a configured provider. Mock AI never calls it, and
  // the dead loopback port keeps any stray background call from leaving the machine.
  await api(base, "providers/setProviderConfig", {
    provider: "anthropic",
    keyPath: ["apiKey"],
    value: "sk-ant-bugbash-fake",
  });
  await api(base, "providers/setProviderConfig", {
    provider: "anthropic",
    keyPath: ["baseUrl"],
    value: "http://127.0.0.1:9/v1",
  });
  await api(base, "projects/create", { projectPath });
  await api(base, "projects/setTrust", { projectPath, trusted: true });
  const created = await api<{ success?: boolean; metadata?: { id?: string }; error?: unknown }>(
    base,
    "workspace/create",
    { projectPath, branchName: "bugbash-playground", trunkBranch: "main", title: WORKSPACE_TITLE }
  );
  const workspaceId = created?.metadata?.id;
  if (created?.success !== true || typeof workspaceId !== "string") {
    fail(`workspace/create did not return a workspace: ${JSON.stringify(created).slice(0, 500)}`);
  }

  // workspace/create returns while the checkout is still being set up. Stopping the seed server
  // then marks the workspace "creation was interrupted", so wait for the persisted init record.
  await waitForInit(path.join(xumRoot, "sessions", workspaceId, "init-status.json"));

  // Artifacts the Artifacts tab lists (artifactStore.getArtifactsDir(<session>/scratch)).
  const artifactsDir = path.join(xumRoot, "sessions", workspaceId, "scratch", "artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactsDir, "release-notes.md"),
    "# Release notes\n\n- Fixed the thing.\n"
  );
  fs.writeFileSync(
    path.join(artifactsDir, "metrics.json"),
    JSON.stringify({ users: 1200, churn: 0.031, regions: ["eu", "us"] }, null, 2)
  );
  fs.writeFileSync(path.join(artifactsDir, "notes.txt"), "Plain text artifact.\n");
}

async function main(): Promise<void> {
  const port = parsePort(process.argv.slice(2));
  if (!fs.existsSync(SERVER_ENTRY) || !fs.existsSync(path.join(REPO_ROOT, "dist/index.html"))) {
    fail("dist/ is missing the server or the renderer: run `make build` first");
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xum-bugbash-"));
  const xumRoot = path.join(tempRoot, "xum");
  const home = path.join(tempRoot, "home");
  const projectPath = path.join(tempRoot, PROJECT_NAME);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: process.env.TMPDIR,
    XUM_ROOT: xumRoot,
    XUM_MOCK_AI: "1",
    // Bug-bash clicks are not product usage.
    XUM_DISABLE_TELEMETRY: "1",
    // Git inside the app must not read or write the user's real ~/.gitconfig.
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
  };

  // e2e stops the app with a signal, possibly while seeding: pass it to whichever server runs.
  let current: ChildProcess | null = null;
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stopping = true;
      current?.kill(signal);
    });
  }

  let code: number | null = null;
  try {
    fs.mkdirSync(home, { recursive: true });
    createDemoRepo(projectPath);

    const seedPort = await getFreePort();
    current = startServer(seedPort, env);
    try {
      await waitForHealth(`http://127.0.0.1:${seedPort}`, current);
      await seed(`http://127.0.0.1:${seedPort}`, projectPath, xumRoot);
    } finally {
      current.kill("SIGTERM");
      await waitForExit(current);
    }

    if (!stopping) {
      current = startServer(port, env);
      code = await waitForExit(current);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  process.exit(code ?? 0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
