import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";
import { DisposableTempDir } from "@/node/services/tempDir";
import { parseWorkflowArgs } from "./workflow";

const BUN_EXECUTABLE = process.execPath;
const WORKFLOW_ENTRY = path.join(import.meta.dir, "workflow.ts");
// index.ts imports the generated src/version.ts; direct `bun test` runs in a fresh
// worktree need `./scripts/generate-version.sh` first (`make test` generates it).
const INDEX_ENTRY = path.join(import.meta.dir, "index.ts");

// Exercise the shipped Node CLI: Bun's source runner can crash before workflow assertions.
async function getCompiledCliEntry(): Promise<string> {
  const compiledEntry = path.resolve(import.meta.dir, "../../dist/cli/index.js");
  await fs.access(compiledEntry).catch((cause: unknown) => {
    throw new Error("Build the CLI with make build-main before running this test", { cause });
  });
  return compiledEntry;
}

async function getRejectedMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected promise to reject");
}

async function trustProject(muxRoot: string, repo: string): Promise<void> {
  await Bun.$`${BUN_EXECUTABLE} -e ${`import { Config } from "./src/node/config"; const c = new Config(); await c.editConfig((cfg) => { cfg.projects.set(process.argv[1], { workspaces: [], trusted: true }); return cfg; });`} ${repo}`
    .env({ ...process.env, MUX_ROOT: muxRoot })
    .quiet();
}

async function seedEvaluationDefault(muxRoot: string, model: string): Promise<void> {
  await Bun.$`${BUN_EXECUTABLE} -e ${`import { Config } from "./src/node/config"; const c = new Config(); await c.editConfig((cfg) => ({ ...cfg, evaluationDefaults: { model: process.argv[1] } }));`} ${model}`
    .env({ ...process.env, MUX_ROOT: muxRoot })
    .quiet();
}

describe("xum workflow CLI helpers", () => {
  test("rejects ambiguous structured args modes", async () => {
    expect(
      await getRejectedMessage(parseWorkflowArgs({ argsJson: "{}", argsFile: "args.json" }))
    ).toContain("Only one structured args mode");
  });

  test("parses JSON args modes and --arg scalars", async () => {
    using tmp = new DisposableTempDir("workflow-cli-args");
    const argsFile = path.join(tmp.path, "args.json");
    await fs.writeFile(argsFile, '{"fromFile":true}', "utf-8");

    expect(await parseWorkflowArgs({ argsJson: '{"base":"main"}' })).toEqual({
      base: "main",
    });
    expect(await parseWorkflowArgs({ argsFile })).toEqual({ fromFile: true });
    expect(await parseWorkflowArgs({ argsStdin: true, stdinText: '{"fromStdin":true}' })).toEqual({
      fromStdin: true,
    });
    expect(await parseWorkflowArgs({ arg: ["strict=true", "count=2", "label=review"] })).toEqual({
      strict: true,
      count: 2,
      label: "review",
    });
  });

  // Invoking the subcommand implies the dynamic-workflows experiment; no persisted
  // override is needed. Routed through index.ts to cover the `wf` alias.
  test("CLI run works without the dynamic-workflows experiment", async () => {
    using tmp = new DisposableTempDir("workflow-cli-experiment");
    const repo = path.join(tmp.path, "repo");
    const muxRoot = path.join(tmp.path, "mux-root");
    await fs.mkdir(path.join(repo, "workflows"), { recursive: true });
    await fs.mkdir(muxRoot, { recursive: true });
    await fs.writeFile(
      path.join(repo, "workflows", "echo-review.js"),
      `export default function workflow() { return { reportMarkdown: "ok" }; }
`,
      "utf-8"
    );
    await trustProject(muxRoot, repo);

    const result =
      await Bun.$`${BUN_EXECUTABLE} ${INDEX_ENTRY} wf run ./workflows/echo-review.js --dir ${repo}`
        .env({ ...process.env, MUX_ROOT: muxRoot })
        .nothrow()
        .quiet();

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });

  // The CLI root owns an Effect runtime (createCoreServices). Its cleanup must
  // close the supervised fiber scope before the session-level disposers and
  // release the runtime after the background processes are terminated, mirroring
  // ServiceContainer.dispose(); the debug shutdown lines pin that order.
  test("CLI run closes the AppFiberScope first and disposes the AppRuntime last", async () => {
    using tmp = new DisposableTempDir("workflow-cli-runtime");
    const repo = path.join(tmp.path, "repo");
    const muxRoot = path.join(tmp.path, "mux-root");
    await fs.mkdir(path.join(repo, "workflows"), { recursive: true });
    await fs.mkdir(muxRoot, { recursive: true });
    await fs.writeFile(
      path.join(repo, "workflows", "echo.js"),
      `export default function workflow() { return { reportMarkdown: "ok" }; }
`,
      "utf-8"
    );
    await trustProject(muxRoot, repo);

    const compiledEntry = await getCompiledCliEntry();
    const result = await Bun.$`node ${compiledEntry} wf run ./workflows/echo.js --dir ${repo}`
      .env({ ...process.env, MUX_ROOT: muxRoot, XUM_LOG_LEVEL: "debug", NO_COLOR: "1" })
      .nothrow()
      .quiet();

    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString() + result.stderr.toString();
    const scopeClosedAt = output.indexOf("[shutdown] AppFiberScope closed");
    const terminateAllAt = output.indexOf("BackgroundProcessManager.terminateAll() called");
    const runtimeDisposedAt = output.indexOf("[shutdown] AppRuntime disposed");
    expect(scopeClosedAt).toBeGreaterThan(output.indexOf("[startup] AppRuntime built"));
    expect(terminateAllAt).toBeGreaterThan(scopeClosedAt);
    expect(runtimeDisposedAt).toBeGreaterThan(terminateAllAt);
  });

  // Regression: headless `xum workflow` must initialize PolicyService and thread
  // it through the core service graph like the desktop wiring. Without it, a
  // stored credential for a provider that MUX_POLICY_FILE / Xum Governor now
  // denies would remain usable from workflow-owned agents. The agent task must
  // fail closed before any provider network call (the configured API key is fake).
  test("CLI run enforces MUX_POLICY_FILE provider denials", async () => {
    using tmp = new DisposableTempDir("workflow-cli-policy");
    const repo = path.join(tmp.path, "repo");
    const muxRoot = path.join(tmp.path, "mux-root");
    await fs.mkdir(path.join(repo, "workflows"), { recursive: true });
    await fs.mkdir(muxRoot, { recursive: true });
    await fs.writeFile(
      path.join(muxRoot, "providers.jsonc"),
      JSON.stringify({ anthropic: { apiKey: "fake-key-policy-test" } }),
      "utf-8"
    );
    const policyPath = path.join(muxRoot, "policy.json");
    await fs.writeFile(
      policyPath,
      JSON.stringify({ policy_format_version: "0.1", provider_access: [{ id: "openai" }] }),
      "utf-8"
    );
    await fs.writeFile(
      path.join(repo, "workflows", "policy-denied.js"),
      `export default async function workflow({ agent }) { return await agent("say hi", { id: "hello" }); }
`,
      "utf-8"
    );
    await trustProject(muxRoot, repo);

    const result =
      await Bun.$`${BUN_EXECUTABLE} ${INDEX_ENTRY} wf run ./workflows/policy-denied.js --model anthropic:claude-opus-5 --dir ${repo}`
        .env({ ...process.env, MUX_ROOT: muxRoot, MUX_POLICY_FILE: policyPath })
        .nothrow()
        .quiet();

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString() + result.stderr.toString()).toContain(
      "Provider anthropic is not allowed by policy"
    );
  });

  test("CLI run reports an actionable trust error for untrusted project workflows", async () => {
    using tmp = new DisposableTempDir("workflow-cli-untrusted");
    const repo = path.join(tmp.path, "repo");
    const muxRoot = path.join(tmp.path, "mux-root");
    await fs.mkdir(path.join(repo, "workflows"), { recursive: true });
    await fs.mkdir(muxRoot, { recursive: true });
    await fs.writeFile(
      path.join(repo, "workflows", "echo-review.js"),
      `export default function workflow() { return { reportMarkdown: "untrusted" }; }
`,
      "utf-8"
    );

    const result =
      await Bun.$`${BUN_EXECUTABLE} ${WORKFLOW_ENTRY} run ./workflows/echo-review.js --dir ${repo}`
        .env({ ...process.env, MUX_ROOT: muxRoot })
        .nothrow()
        .quiet();

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "Project trust is required to run workspace workflow scripts"
    );
  });

  test("CLI rejects non-local runtimes before running workflows", async () => {
    using tmp = new DisposableTempDir("workflow-cli-runtime");
    const repo = path.join(tmp.path, "repo");
    const muxRoot = path.join(tmp.path, "mux-root");
    await fs.mkdir(path.join(repo, "workflows"), { recursive: true });
    await fs.mkdir(muxRoot, { recursive: true });
    await fs.writeFile(
      path.join(repo, "workflows", "echo-review.js"),
      `export default function workflow() { return { reportMarkdown: "should not run" }; }
`,
      "utf-8"
    );

    const result =
      await Bun.$`${BUN_EXECUTABLE} ${WORKFLOW_ENTRY} run ./workflows/echo-review.js --dir ${repo} --runtime worktree`
        .env({ ...process.env, MUX_ROOT: muxRoot })
        .nothrow()
        .quiet();

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "xum workflow currently supports only local runtime"
    );
  });

  // Each model source resolves to a distinct, key-independent failure code, so the
  // reported code identifies which source won: nothing → no-model; an unknown
  // provider → unsupported-provider; an explicit gateway prefix → unsupported-route.
  test("CLI --evaluation-model sits between the per-call model and the Settings default", async () => {
    using tmp = new DisposableTempDir("workflow-cli-evaluation-model");
    const repo = path.join(tmp.path, "repo");
    const muxRoot = path.join(tmp.path, "mux-root");
    await fs.mkdir(path.join(repo, "workflows"), { recursive: true });
    await fs.mkdir(muxRoot, { recursive: true });
    await fs.writeFile(
      path.join(repo, "workflows", "probe.js"),
      `export default function workflow({ args, evaluate }) {
  try {
    evaluate("probe", {
      id: "probe",
      questions: { ok: { type: "boolean", instructions: "Is it ok?" } },
      ...(args.model ? { model: args.model } : {}),
    });
    return { reportMarkdown: "unexpected success" };
  } catch (error) {
    return { reportMarkdown: error.message };
  }
}
`,
      "utf-8"
    );
    await trustProject(muxRoot, repo);
    const probe = async (...extra: string[]) => {
      const result =
        await Bun.$`${BUN_EXECUTABLE} ${INDEX_ENTRY} wf run ./workflows/probe.js --dir ${repo} --quiet ${extra}`
          .env({ ...process.env, MUX_ROOT: muxRoot })
          .nothrow()
          .quiet();
      return { exitCode: result.exitCode, stdout: result.stdout.toString().trim() };
    };

    const unconfigured = await probe();
    expect(unconfigured.exitCode).toBe(0);
    expect(unconfigured.stdout).toContain("evaluation failed: invalid-input/no-model");

    // The Settings default must come from the real config, not the ephemeral run copy.
    await seedEvaluationDefault(muxRoot, "nope:settings-model");
    expect((await probe()).stdout).toContain("evaluation failed: unsupported/unsupported-provider");

    expect((await probe("--evaluation-model", "mux-gateway:openai:gpt-5")).stdout).toContain(
      "evaluation failed: unsupported/unsupported-route"
    );

    expect(
      (
        await probe(
          "--evaluation-model",
          "mux-gateway:openai:gpt-5",
          "--args-json",
          '{"model":"nope:per-call"}'
        )
      ).stdout
    ).toContain("evaluation failed: unsupported/unsupported-provider");

    const blank =
      await Bun.$`${BUN_EXECUTABLE} ${INDEX_ENTRY} wf run ./workflows/probe.js --dir ${repo} --evaluation-model ${" "}`
        .env({ ...process.env, MUX_ROOT: muxRoot })
        .nothrow()
        .quiet();
    expect(blank.exitCode).not.toBe(0);
    expect(blank.stderr.toString()).toContain("Invalid --evaluation-model");
  }, 60_000);

  test("CLI runs a trusted explicit workflow script with structured args", async () => {
    using tmp = new DisposableTempDir("workflow-cli-e2e");
    const repo = path.join(tmp.path, "repo");
    const muxRoot = path.join(tmp.path, "mux-root");
    await fs.mkdir(path.join(repo, "workflows"), { recursive: true });
    await fs.mkdir(muxRoot, { recursive: true });
    await Bun.$`git init`.cwd(repo).quiet();
    await Bun.$`git config user.email dogfood@example.com`.cwd(repo).quiet();
    await Bun.$`git config user.name Dogfood`.cwd(repo).quiet();
    await fs.writeFile(path.join(repo, "README.md"), "hello\n", "utf-8");
    await Bun.$`git add README.md`.cwd(repo).quiet();
    await Bun.$`git commit -m init`.cwd(repo).quiet();
    await fs.writeFile(
      path.join(repo, "workflows", "echo-review.js"),
      `export default function workflow({ args }) {
  return { reportMarkdown: "Echo: " + JSON.stringify(args), structuredOutput: { ok: true, args } };
}
`,
      "utf-8"
    );
    await fs.writeFile(
      path.join(repo, "workflows", "explode.js"),
      `export default function workflow() { throw new Error("boom"); }
`,
      "utf-8"
    );

    await trustProject(muxRoot, repo);

    const compiledEntry = await getCompiledCliEntry();
    const runOutput =
      await Bun.$`node ${compiledEntry} wf run ./workflows/echo-review.js --dir ${repo} --args-json ${'{"base":"main"}'} --json`
        .env({ ...process.env, MUX_ROOT: muxRoot })
        .text();
    const lines = runOutput.trim().split("\n");
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0] ?? "null") as unknown;
    expect(event).toMatchObject({
      type: "result",
      status: "completed",
      result: { reportMarkdown: 'Echo: {"base":"main"}' },
    });

    const quietOutput =
      await Bun.$`node ${compiledEntry} wf run ./workflows/echo-review.js --dir ${repo} --args-json ${'{"input":"hello"}'} --quiet`
        .env({ ...process.env, MUX_ROOT: muxRoot })
        .text();
    expect(quietOutput).toBe('Echo: {"input":"hello"}\n');

    const stdinProc = Bun.spawn(
      [
        "node",
        compiledEntry,
        "wf",
        "run",
        "./workflows/echo-review.js",
        "--dir",
        repo,
        "--args-stdin",
        "--json",
      ],
      {
        env: { ...process.env, MUX_ROOT: muxRoot },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    stdinProc.stdin.write('{"fromStdin":true}');
    await stdinProc.stdin.end();
    const [stdinStdout, stdinStderr, stdinExitCode] = await Promise.all([
      new Response(stdinProc.stdout).text(),
      new Response(stdinProc.stderr).text(),
      stdinProc.exited,
    ]);
    expect(stdinExitCode).toBe(0);
    expect(stdinStderr).toBe("");
    const stdinEvent = JSON.parse(stdinStdout.trim()) as unknown;
    expect(stdinEvent).toMatchObject({
      type: "result",
      status: "completed",
      result: { reportMarkdown: 'Echo: {"fromStdin":true}' },
    });

    const failedRun = await Bun.$`node ${compiledEntry} wf run ./workflows/explode.js --dir ${repo}`
      .env({ ...process.env, MUX_ROOT: muxRoot })
      .nothrow()
      .quiet();
    expect(failedRun.exitCode).toBe(1);
  }, 30_000);
});
