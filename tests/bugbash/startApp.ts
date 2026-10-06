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
 * AI mode (aiMode.ts, BUGBASH_AI, default auto): real mode configures the app's provider with the
 * real key and base URL, makes the app model the default, and starts the server with
 * XUM_DISABLE_AGENT_TOOLS=1: no tool reaches the model, whatever agent, project file or plugin
 * defines it, so the app talks to a real model but cannot read files or run commands. Agent
 * overrides also tell the built-in agents they have no tools, so replies say so. Real mode also
 * sets XUM_DISABLE_TERMINALS and XUM_DISABLE_PROJECT_AUTOMATION: AI replies are untrusted input
 * for the explorer, so the terminal and project init hooks are closed.
 * Mock mode sets XUM_MOCK_AI=1 and points the provider at a dead loopback port.
 *
 * Safety: the server process gets only PATH, HOME (the temp one), the temp-dir variables and the
 * XUM_* values set here. In real mode the provider key reaches the app only through the temp
 * root's provider config, which is deleted on exit. The temp HOME protects real config, NOT the
 * host filesystem. In mock mode the Terminal tab still runs real shell commands as this user, and
 * in both modes Settings can still add a stdio MCP server or a custom editor command, which run
 * host commands. Charters must keep explorers out of those until the app runs in a container
 * (#5714).
 */

import { spawn, spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { type AiMode, AiModeError, resolveAiMode } from "./aiMode";

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

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) fail(`git ${args.join(" ")} failed: ${result.stderr}`);
}

// `env` is the sanitized server env: the seed commit must not read the user's global git config
// (commit signing, template dirs, hooks), just like git inside the app.
function createDemoRepo(dir: string, env: NodeJS.ProcessEnv): void {
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "README.md"),
    "# Demo app\n\nA small throwaway project for the Xum bug bash.\n"
  );
  fs.writeFileSync(
    path.join(dir, "src/math.ts"),
    "export function add(a: number, b: number): number {\n  return a + b;\n}\n"
  );
  git(dir, env, "init", "-q", "-b", "main");
  git(dir, env, "add", ".");
  git(
    dir,
    env,
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

// A signal (Ctrl-C, or e2e stopping the app) ends the seed server with exitCode null and
// signalCode set: check both, so an interrupted bug bash stops at once instead of polling on.
function failIfExited(child: ChildProcess): void {
  if (child.exitCode != null || child.signalCode != null) {
    fail(`seed server exited early (${child.exitCode ?? child.signalCode})`);
  }
}

async function waitForHealth(base: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    failIfExited(child);
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

async function waitForInit(statusFile: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    failIfExited(child);
    if (fs.existsSync(statusFile)) {
      const { status } = JSON.parse(fs.readFileSync(statusFile, "utf8")) as { status?: string };
      if (status === "success") return;
      if (status === "error") fail(`workspace setup failed, see ${statusFile}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail("workspace setup did not finish within 60 s");
}

// Real mode: built-in agents a user can run, each extended (`base: <id>`) with every tool removed
// and no required tool (Plan's base requires propose_plan). This only shapes replies: the safety
// boundary is XUM_DISABLE_AGENT_TOOLS, which a project agent file cannot override. Xum expands
// `~/.xum` to XUM_ROOT, not HOME, so the folder is <XUM_ROOT>/agents.
// id -> display name; an agent file without `name` is skipped as invalid.
const NO_TOOL_AGENTS: Record<string, string> = {
  exec: "Exec",
  plan: "Plan",
  explore: "Explore",
  desktop: "Desktop",
};

function writeNoToolAgents(xumRoot: string): void {
  const dir = path.join(xumRoot, "agents");
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, name] of Object.entries(NO_TOOL_AGENTS)) {
    fs.writeFileSync(
      path.join(dir, `${id}.md`),
      [
        "---",
        `name: ${name}`,
        `base: ${id}`,
        "tools:",
        "  remove:",
        '    - ".*"',
        "  require: []",
        "---",
        "",
        "Bug-bash session: you have no tools. Answer in chat only, in at most three sentences.",
        "",
      ].join("\n")
    );
  }
}

async function seed(
  base: string,
  projectPath: string,
  xumRoot: string,
  child: ChildProcess,
  ai: AiMode
): Promise<void> {
  await api(base, "splashScreens/markSplashScreenViewed", { splashId: "onboarding-wizard-v1" });
  await api(base, "experiments/setOverride", { experimentId: "artifacts", enabled: true });
  if (ai.mode === "real") {
    await api(base, "providers/setProviderConfig", {
      provider: ai.provider,
      keyPath: ["apiKey"],
      value: ai.apiKey,
    });
    await api(base, "providers/setProviderConfig", {
      provider: ai.provider,
      keyPath: ["baseUrl"],
      value: ai.baseUrl,
    });
    // Before the workspace exists, so the seeded workspace starts on the app model.
    await api(base, "config/updateModelPreferences", { defaultModel: ai.model });
  } else {
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
  }
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
  await waitForInit(path.join(xumRoot, "sessions", workspaceId, "init-status.json"), child);

  if (ai.mode === "real") {
    // An agent file Xum cannot parse is skipped silently: confirm each override resolves, so the
    // built-in agents keep telling the model it has no tools.
    for (const id of Object.keys(NO_TOOL_AGENTS)) {
      const agent = await api<{ scope?: string; frontmatter?: { tools?: { remove?: string[] } } }>(
        base,
        "agents/get",
        { workspaceId, agentId: id }
      );
      if (agent?.scope !== "global" || agent.frontmatter?.tools?.remove?.[0] !== ".*") {
        fail(`real mode: agent ${id} override did not resolve (scope ${String(agent?.scope)})`);
      }
    }
  }

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

  let ai: AiMode;
  try {
    ai = await resolveAiMode();
  } catch (error) {
    if (error instanceof AiModeError) fail(error.message);
    throw error;
  }
  // e2e writes this line to the target's command log.
  console.log(`[bugbash startApp] app AI: ${ai.mode} (${ai.reason})`);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xum-bugbash-"));
  const xumRoot = path.join(tempRoot, "xum");
  const home = path.join(tempRoot, "home");
  const projectPath = path.join(tempRoot, PROJECT_NAME);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: process.env.TMPDIR,
    XUM_ROOT: xumRoot,
    // Real mode: a real model answers in the app on this host. It gets no tools, and the explorer
    // gets no terminal or project init hooks, so injected text in a reply that the explorer
    // follows cannot run host commands through them (see the header).
    ...(ai.mode === "mock"
      ? { XUM_MOCK_AI: "1" }
      : {
          XUM_DISABLE_AGENT_TOOLS: "1",
          XUM_DISABLE_TERMINALS: "1",
          XUM_DISABLE_PROJECT_AUTOMATION: "1",
        }),
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
    if (ai.mode === "real") writeNoToolAgents(xumRoot);
    createDemoRepo(projectPath, env);

    const seedPort = await getFreePort();
    current = startServer(seedPort, env);
    try {
      await waitForHealth(`http://127.0.0.1:${seedPort}`, current);
      await seed(`http://127.0.0.1:${seedPort}`, projectPath, xumRoot, current, ai);
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
