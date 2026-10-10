#!/usr/bin/env bun
/**
 * Starts one disposable, pre-seeded `xum server` for an `e2e explore` bug-bash run.
 *
 * e2e.config.ts runs this as the target's `app.command` with `--port {port}`, so every
 * explorer gets its own app on its own free port, and explorers never see each other's edits.
 *
 * Usage: bun tests/bugbash/startApp.ts --port <port> [--mcp-apps]   (needs `make build`: dist/ +
 *        renderer). --mcp-apps adds an MCP Apps server and a chat with its tool calls
 *        (mcpapps/seed.ts); e2e.mcpapps.config.ts passes it.
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
 * XUM_DISABLE_AGENT_TOOLS=1: no agent turn sends a tool to the model, whatever agent, project
 * file or plugin defines it, so chat replies cannot read files or run commands. Callers with
 * their own tools (refinement, memory harvest and intuition, continuous compaction) do not check
 * the flag, and none of them runs shell commands here (src/node/utils/agentToolsDisabled.ts). Agent
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
import { proxySocketMounted, sandboxShaped } from "./sandbox/inContainer";
import { startFakeProvider } from "./fakeProvider";
import { seedMcpChat, writeMcpConfig } from "./mcpapps/seed";

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

const SWITCHES = [
  "XUM_DISABLE_AGENT_TOOLS",
  "XUM_DISABLE_TERMINALS",
  "XUM_DISABLE_PROJECT_AUTOMATION",
] as const;

/**
 * Why the app server must not start, or null: a guard behind the `command.env` pass-through
 * (B1 lost BUGBASH_MODEL_DRIVEN there once). A sandbox container with a mounted proxy socket is a
 * model-driven job, so it needs the marker, and a model-driven job needs all three switches.
 * The container check reads only the filesystem, not the env that could have been dropped.
 */
export function modelDrivenGuard(
  serverEnv: NodeJS.ProcessEnv,
  env: NodeJS.ProcessEnv = process.env,
  root = "/"
): string | null {
  const modelDriven = env.BUGBASH_MODEL_DRIVEN === "1";
  if (!modelDriven && sandboxShaped(root) && proxySocketMounted(root))
    return "a sandbox job with a provider proxy, but BUGBASH_MODEL_DRIVEN did not reach the app";
  const off = SWITCHES.filter((name) => serverEnv[name] !== "1");
  if (modelDriven && off.length > 0) return `a model-driven job without ${off.join(", ")}`;
  return null;
}

/** The mode and kill-switch env of the app server. */
export function appSwitches(
  mode: "mock" | "real",
  fakeProvider: boolean,
  modelDriven: boolean
): Record<string, string> {
  // No agent tools and no terminal (AGENTS.md: not until the app runs in a sandbox). Project
  // automation stays on: its kill switch also makes the bash AI proxy refuse every call, the
  // fake's replies are fixed text, and the seeded demo repo has no hooks.
  if (fakeProvider) return { XUM_DISABLE_AGENT_TOOLS: "1", XUM_DISABLE_TERMINALS: "1" };
  const all = {
    XUM_DISABLE_AGENT_TOOLS: "1",
    XUM_DISABLE_TERMINALS: "1",
    XUM_DISABLE_PROJECT_AUTOMATION: "1",
  };
  if (mode === "real") return all;
  return { XUM_MOCK_AI: "1", ...(modelDriven && all) };
}

export async function waitForHealth(base: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    failIfExited(child);
    try {
      // Bound each probe: a server that accepts the connection but never answers would
      // otherwise keep fetch pending, and the loop would never recheck its deadline or the exit.
      const response = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now()))),
      });
      if (response.ok) return;
    } catch {
      // Not listening yet, or the probe timed out.
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
  ai: AiMode,
  fakeProviderOrigin: string | undefined
): Promise<string> {
  await api(base, "splashScreens/markSplashScreenViewed", { splashId: "onboarding-wizard-v1" });
  await api(base, "experiments/set", { experimentId: "artifacts", enabled: true });
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
    // Naming and the sidebar status try the configured naming model first, then Xum's built-in
    // small models (NAME_GEN_PREFERRED_MODELS). In the sandbox the proxy allows only the app
    // model, so those built-ins are refused there: pin naming to the app model too.
    await api(base, "config/updateAgentAiDefaults", {
      agentAiDefaults: { name_workspace: { modelString: ai.model } },
    });
  } else {
    // The composer refuses to send without a configured provider. Mock AI never calls it, and
    // the dead loopback port keeps any stray background call from leaving the machine. The
    // bash-ai-proxy scenario points both providers at the loopback fake instead.
    const providerBase = fakeProviderOrigin ?? "http://127.0.0.1:9";
    await api(base, "providers/setProviderConfig", {
      provider: "anthropic",
      keyPath: ["apiKey"],
      value: "sk-ant-bugbash-fake",
    });
    await api(base, "providers/setProviderConfig", {
      provider: "anthropic",
      keyPath: ["baseUrl"],
      value: `${providerBase}/v1`,
    });
    if (fakeProviderOrigin !== undefined) {
      // Chat turns on Sonnet, probes on Opus, so the Cost tab keeps them in separate rows.
      await api(base, "config/updateModelPreferences", {
        defaultModel: "anthropic:claude-sonnet-5-5",
      });
      await api(base, "providers/setProviderConfig", {
        provider: "openai",
        keyPath: ["apiKey"],
        value: "sk-openai-bugbash-fake",
      });
      await api(base, "providers/setProviderConfig", {
        provider: "openai",
        keyPath: ["baseUrl"],
        value: `${providerBase}/v1`,
      });
    }
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
  return workspaceId;
}

async function main(): Promise<void> {
  const port = parsePort(process.argv.slice(2));
  const mcpApps = process.argv.includes("--mcp-apps");
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

  // BUGBASH_SCENARIO=bash-ai-proxy: instead of the mock, a loopback fake provider (fakeProvider.ts)
  // is the chat model and the upstream of Xum's bash AI proxy. On each agent turn the fake calls
  // the proxy itself with that workspace's key, so the proxy, the Cost tab and Analytics see
  // real traffic while agent tools stay off. Nothing leaves the machine. It replaces the mock,
  // so the explorer context (e2e.config.ts) must not describe a real model.
  const scenario = process.env.BUGBASH_SCENARIO ?? "";
  if (scenario !== "" && scenario !== "bash-ai-proxy") {
    fail(`BUGBASH_SCENARIO must be empty or bash-ai-proxy, got "${scenario}"`);
  }
  if (scenario !== "" && ai.mode !== "mock") {
    fail("BUGBASH_SCENARIO=bash-ai-proxy replaces the mock: run it with BUGBASH_AI=mock");
  }
  // A model-driven job (the sandbox launcher sets this): a model reads every reply and page, so
  // the app gets all three switches in both AI modes. bash-ai-proxy needs project automation.
  const modelDriven = process.env.BUGBASH_MODEL_DRIVEN === "1";
  if (modelDriven && scenario !== "") {
    fail("BUGBASH_SCENARIO=bash-ai-proxy needs project automation: not in a model-driven job");
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xum-bugbash-"));
  const xumRoot = path.join(tempRoot, "xum");
  const fakeProvider = scenario === "bash-ai-proxy" ? await startFakeProvider(xumRoot) : undefined;
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
    ...appSwitches(ai.mode, fakeProvider != null, modelDriven),
    // Bug-bash clicks are not product usage.
    XUM_DISABLE_TELEMETRY: "1",
    // Git inside the app must not read or write the user's real ~/.gitconfig.
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
  };
  const unguarded = modelDrivenGuard(env);
  if (unguarded != null) fail(`${unguarded}: the app does not start`);

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
    if (mcpApps) writeMcpConfig(xumRoot);

    const seedPort = await getFreePort();
    current = startServer(seedPort, env);
    let workspaceId: string;
    try {
      await waitForHealth(`http://127.0.0.1:${seedPort}`, current);
      workspaceId = await seed(
        `http://127.0.0.1:${seedPort}`,
        projectPath,
        xumRoot,
        current,
        ai,
        fakeProvider?.origin
      );
    } finally {
      current.kill("SIGTERM");
      await waitForExit(current);
    }
    if (mcpApps) seedMcpChat(xumRoot, workspaceId);

    if (!stopping) {
      current = startServer(port, env);
      code = await waitForExit(current);
    }
  } finally {
    fakeProvider?.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  process.exit(code ?? 0);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  });
}
