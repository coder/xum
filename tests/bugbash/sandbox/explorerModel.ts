/**
 * The explorer model of a model-driven sandbox job (#5714): BUGBASH_MODEL through the job's
 * provider proxy. The proxy holds the provider key and allows only this job's models
 * (proxy.ts), so the key here is a placeholder that the proxy drops.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { e2eCommand } from "../hostPause";
import { modelDrivenSandbox, PROXY_BASE_URL } from "./inContainer";

/** BUGBASH_MODEL (`anthropic:<id>`, set by the launcher) through the proxy. */
export function proxyModel(env: NodeJS.ProcessEnv = process.env) {
  const spec = env.BUGBASH_MODEL ?? "";
  const [provider, id] = spec.split(/:(.*)/s, 2);
  if (provider !== "anthropic" || !id)
    throw new Error(`BUGBASH_MODEL must be anthropic:<model> in the sandbox, got "${spec}"`);
  return createAnthropic({ baseURL: PROXY_BASE_URL, apiKey: "bugbash-sandbox-placeholder" })(id);
}

/**
 * The model for e2e.config.ts's agents: only for `e2e explore` in a model-driven sandbox job.
 * Everywhere else, also for `e2e run` with BUGBASH_MODEL set, the agents get no model, so an
 * `agent.*` step in a repro fails with MODEL_UNAVAILABLE before any model request.
 */
export function explorerModel(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  root = "/"
) {
  return e2eCommand(argv) === "explore" && modelDrivenSandbox(env, root)
    ? proxyModel(env)
    : undefined;
}
