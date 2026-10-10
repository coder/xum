/**
 * The MCP Apps pause (#5714, ../hostPause.ts). e2e.mcpapps.config.ts imports this module first,
 * so the refusal comes before e2e.config.ts runs: that config can throw first (for example on
 * an unresolved app AI mode), and then no message would name the pause.
 *
 * The suite runs only in the bug-bash sandbox with a provider proxy for the job
 * (`make mcp-apps-e2e`, sandbox/launch.ts). Everywhere else it refuses as before.
 */
import { modelDrivenRefusal } from "../hostPause";
import { modelDrivenSandbox } from "../sandbox/inContainer";

if (!modelDrivenSandbox()) {
  throw new Error(
    modelDrivenRefusal("the MCP Apps suite (agent.act, e2e.mcpapps.config.ts)") ?? "refused"
  );
}
