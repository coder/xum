/**
 * The host pause (#5714). The user decided to pause model-driven bug-bash runs until they run in
 * the bug-bash sandbox. A run is model-driven when a model picks the UI actions: `e2e explore`
 * charters (`make bug-bash`, run.ts), the MCP Apps suite (`agent.act`, `make mcp-apps-e2e`), the
 * story suite and the agent repros (`make test-stories`) and any other e2e command that loads
 * these configs. Such a run reads untrusted page and AI text,
 * and the app that it drives can run commands on this host.
 *
 * Exact-step repros keep running on the host as before: `e2e run` and `e2e list` with
 * e2e.config.ts. Outside a sandboxed `e2e explore` that config's agents hold no model
 * (sandbox/explorerModel.ts), so an `agent.*` step in a repro fails with MODEL_UNAVAILABLE
 * before any model request (e2e has no default model and no env fallback).
 *
 * The pause has no override: no env var or flag turns it off. Model-driven runs pass only
 * inside the bug-bash sandbox with a provider proxy for the job (sandbox/inContainer.ts):
 * `e2e explore` there (`make bug-bash`, run.ts), the MCP Apps suite (mcpapps/hostPause.ts), the
 * story suite (tests/stories/hostPause.ts) and `e2e run --tag agent` (sandbox/explorerModel.ts).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { modelDrivenSandbox } from "./sandbox/inContainer";

/** Why `what` must not run, or null when it may run. During the pause it never may. */
export function modelDrivenRefusal(what: string): string | null {
  return (
    `${what}: a model picks the actions here, and model-driven bug-bash runs are paused on ` +
    "this host until they run in the bug-bash sandbox (#5714). Exact-step repros still run: " +
    "make test-bugbash-repros."
  );
}

const E2E_DIR = fileURLToPath(new URL("../../node_modules/e2e/dist/", import.meta.url));
/** The e2e CLI, and the worker that a CLI run forks (it loads the config again, with no args). */
const E2E_CLI = path.join(E2E_DIR, "cli/bin.js");
const E2E_WORKER = path.join(E2E_DIR, "run/worker/entry.js");
// The e2e commands that only run or list exact-step tests. `explore` and `mcp` hand the actions
// to a model, and the rest have no use for this config: refuse them all.
const EXACT_STEP_COMMANDS = ["run", "list"];

const real = (file: string | undefined) => {
  if (file == null) return null;
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
};

/** Whether this process is an e2e run's worker: it gets no args, and loads the config again. */
export function isE2eWorker(argv: readonly string[] = process.argv): boolean {
  const main = real(argv[1]);
  return main != null && main === real(E2E_WORKER);
}

/** The `--tag` values of e2e args, and whether they hold a `--tag-mode`. */
function tagSelection(args: readonly string[]) {
  const tags: string[] = [];
  let mode = false;
  for (let i = 0; i < args.length; i++) {
    const [name, inline] = args[i].split(/=(.*)/s, 2);
    if (name === "--tag-mode") mode = true;
    if (name === "--tag") tags.push(inline ?? args[++i] ?? "");
  }
  return { tags, mode };
}

/**
 * Whether e2e args select by the `agent` tag alone: one `--tag agent` and no `--tag-mode`. An
 * `agent`-tagged repro (reproRules.test.ts) needs a model, so only such a run gets one, in a
 * model-driven sandbox job (sandbox/explorerModel.ts, sandbox/launch.ts). e2e also reads
 * comma-separated tags, so `--tag agent,x` is not this selection.
 */
export function onlyAgentTag(args: readonly string[]): boolean {
  const { tags, mode } = tagSelection(args);
  return !mode && tags.length === 1 && tags[0] === "agent";
}

/** Whether any `--tag` value of e2e args names the `agent` tag, alone or in a comma list. */
export function namesAgentTag(args: readonly string[]): boolean {
  return tagSelection(args).tags.some((value) => value.split(",").includes("agent"));
}

/** The e2e command (`run`, `explore`, ...) of an e2e CLI process, or undefined. */
export function e2eCommand(argv: readonly string[] = process.argv): string | undefined {
  const main = real(argv[1]);
  if (main == null || main !== real(E2E_CLI)) return undefined;
  return argv.slice(2).find((arg) => !arg.startsWith("-"));
}

/**
 * Why the e2e process that loads a bug-bash config must stop, or null. Every e2e command loads
 * the config in its own process before it starts an app, a browser or a model, so this check
 * runs first. Fail closed: a config loaded by anything other than the e2e CLI or its worker
 * (another script, `import()` from a tool) is refused too. `env` and `root` are for tests.
 */
export function e2eCommandRefusal(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  root = "/"
): string | null {
  // A worker gets no args. Only a CLI run that passed this check forks one.
  if (isE2eWorker(argv)) return null;
  const main = real(argv[1]);
  if (main == null || main !== real(E2E_CLI))
    return modelDrivenRefusal(`a bug-bash e2e config loaded by ${argv[1] ?? "an unknown script"}`);
  const command = e2eCommand(argv);
  if (command != null && EXACT_STEP_COMMANDS.includes(command)) return null;
  if (command === "explore" && modelDrivenSandbox(env, root)) return null;
  return modelDrivenRefusal(`e2e ${command ?? "(no command)"}`);
}
