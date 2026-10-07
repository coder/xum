/**
 * The MCP Apps pause (#5714, ../hostPause.ts). e2e.mcpapps.config.ts imports this module first,
 * so the refusal comes before e2e.config.ts runs: that config can throw first (for example on
 * an unresolved app AI mode), and then no message would name the pause.
 */
import { modelDrivenRefusal } from "../hostPause";

const paused = modelDrivenRefusal("the MCP Apps suite (agent.act, e2e.mcpapps.config.ts)");
if (paused != null) throw new Error(paused);
