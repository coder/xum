import type { Tool } from "ai";

import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { toolOutputCarriesProjectSkillContent } from "@/node/services/agentSkills/loadedSkillSnapshots";
import type { PreDispatchConsentGate } from "@/node/services/streamManager";

/**
 * Whether THIS tool call must leave project skill content out of what it
 * reads or returns: the assembly-time verdict (an untrusted routed turn), or a
 * routed turn's trust re-read at the call. A revocation between assembly and
 * a tool that talks to another provider itself (intuition) or reads history
 * and memories cannot wait for the next step's consent gate. Fails closed
 * when the re-read throws.
 */
export async function toolExcludesProjectSkillContent(
  config: Pick<ToolConfiguration, "excludeProjectSkillContent" | "projectSkillContentStillReadable">
): Promise<boolean> {
  if (config.excludeProjectSkillContent === true) return true;
  if (config.projectSkillContentStillReadable === undefined) return false;
  try {
    return !(await config.projectSkillContentStillReadable());
  } catch {
    return true;
  }
}

/**
 * Whether a tool that hands this turn's context to ANOTHER model (a subagent's
 * prompt, a message to a peer agent, an advisor request) must refuse: the
 * context carries project skill content — request rows kept under trust, or a
 * read earlier in this stream observed live — and the turn excludes it, at the
 * call (assembly verdict or trust re-read, see toolExcludesProjectSkillContent).
 * Such a request is outside the turn's own consent gate.
 */
export async function contextProjectSkillContentWithheld(
  config: Pick<
    ToolConfiguration,
    | "excludeProjectSkillContent"
    | "projectSkillContentStillReadable"
    | "memoryWriteCarriesProjectSkillContent"
    | "projectSkillContentInContext"
  >
): Promise<boolean> {
  const contextCarriesProjectSkillContent =
    config.memoryWriteCarriesProjectSkillContent === true ||
    config.projectSkillContentInContext?.() === true;
  return contextCarriesProjectSkillContent && (await toolExcludesProjectSkillContent(config));
}

/**
 * A routed turn's consent gate told that the request's tool descriptions
 * advertise project-scope skills kept under trust: agent_skill_read lists each
 * skill's repository-controlled description, project content the row scan
 * never sees, so it must arm the gate like a snapshot row would.
 */
export function withToolDescriptionProvenance(
  gate: PreDispatchConsentGate | undefined,
  toolDescriptionsCarryProjectSkillContent: boolean
): PreDispatchConsentGate | undefined {
  if (gate === undefined || !toolDescriptionsCarryProjectSkillContent) return gate;
  return (context) => gate({ ...context, toolDescriptionsCarryProjectSkillContent: true });
}

/**
 * Tools whose outputs are classified the moment they return: a project skill
 * read taints the live per-stream provenance immediately — inside a
 * Programmatic Tool Calling program too, where a later sink of the same
 * evaluation (a memory write, a task spawn, an advisor request) runs before
 * the step settles and onStepMessages could classify the result.
 */
type ToolExecuteOptions = Parameters<NonNullable<Tool["execute"]>>[1];

export function observeProjectSkillContentInToolOutputs<T extends Record<string, Tool>>(
  tools: T,
  onProjectSkillContent: () => void
): T {
  const observed: Record<string, Tool> = {};
  for (const [name, definition] of Object.entries(tools)) {
    const execute = definition.execute;
    if (execute === undefined) {
      observed[name] = definition;
      continue;
    }
    const observedTool: Tool = {
      ...definition,
      execute: async (input: unknown, options: ToolExecuteOptions) => {
        // A streaming execute returns its iterable as-is (not awaited apart).
        const output: unknown = await execute(input, options);
        if (toolOutputCarriesProjectSkillContent(name, output)) onProjectSkillContent();
        return output;
      },
    };
    observed[name] = observedTool;
  }
  return observed as T;
}
