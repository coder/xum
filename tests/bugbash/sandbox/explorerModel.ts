/**
 * The explorer model of a model-driven sandbox job (#5714): BUGBASH_MODEL through the job's
 * provider proxy. The proxy holds the provider key and allows only this job's models
 * (proxy.ts), so the key here is a placeholder that the proxy drops.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { e2eCommand, isE2eWorker, onlyAgentTag } from "../hostPause";
import { modelDrivenSandbox, PROXY_BASE_URL } from "./inContainer";

/** BUGBASH_MODEL (`anthropic:<id>`, set by the launcher) through the proxy. */
export function proxyModel(env: NodeJS.ProcessEnv = process.env, variable = "BUGBASH_MODEL") {
  const spec = env[variable] ?? "";
  const [provider, id] = spec.split(/:(.*)/s, 2);
  if (provider !== "anthropic" || !id)
    throw new Error(`${variable} must be anthropic:<model> in the sandbox, got "${spec}"`);
  return createAnthropic({ baseURL: PROXY_BASE_URL, apiKey: "bugbash-sandbox-placeholder" })(id);
}

/**
 * The story agents' judge (`agents.<name>.judge`): BUGBASH_JUDGE_MODEL through the proxy, or
 * undefined (e2e then judges with the agent's own model). The cheap PR lane drives with Haiku 5.5,
 * which misjudged screenshots (#7185: it passed 44px checkboxes and a wrapped meta row), so its
 * asserts go to a stronger model.
 */
export function proxyJudgeModel(env: NodeJS.ProcessEnv = process.env) {
  return (env.BUGBASH_JUDGE_MODEL ?? "") === ""
    ? undefined
    : proxyModel(env, "BUGBASH_JUDGE_MODEL");
}

/**
 * The e2e CLI args of this process. An e2e run's worker gets no args (hostPause.ts), so it reads
 * the args of the CLI run that forked it, its parent: the worker loads the config again, and its
 * agents must match the CLI's (e2e compares the two config digests). A parent it cannot read
 * gives no args, so no model. `root` and `ppid` are for tests.
 */
function cliArgv(argv: readonly string[], root: string, ppid: number): readonly string[] {
  if (!isE2eWorker(argv)) return argv;
  try {
    return fs
      .readFileSync(path.join(root, `proc/${ppid}/cmdline`), "utf8")
      .replace(/\0$/, "")
      .split("\0");
  } catch {
    return [];
  }
}

/**
 * The model for e2e.config.ts's agents, only in a model-driven sandbox job: for `e2e explore`,
 * and for `e2e run` with `--tag agent` alone (the agent repros of `make test-stories`, whose
 * worker reads that from its parent). Everywhere else, also for any other `e2e run` with
 * BUGBASH_MODEL set, the agents get no model, so an `agent.*` step in a repro fails with
 * MODEL_UNAVAILABLE before any model request.
 */
export function explorerModel(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  root = "/",
  ppid = process.ppid
) {
  if (!modelDrivenSandbox(env, root)) return undefined;
  const cli = cliArgv(argv, root, ppid);
  const command = e2eCommand(cli);
  return command === "explore" || (command === "run" && onlyAgentTag(cli))
    ? proxyModel(env)
    : undefined;
}
