import { KNOWN_MODELS, MODEL_ABBREVIATIONS } from "@/common/constants/knownModels";
import { ThinkingLevelSchema } from "@/common/types/thinking";
import assert from "@/common/utils/assert";

/**
 * Plugin agents written for Claude Code or Cursor carry only `name`,
 * `description` and their own optional keys (`model`, `effort`, `readonly`,
 * `is_background`, `background`). Those ecosystems treat such a file as a
 * sub-agent that inherits every tool. Xum's defaults (not runnable, no base, no
 * tools) would make it unspawnable and toolless, which breaks plugins such as
 * pstack whose router spawns its own agents. So a plugin agent with no Xum-only
 * key gets the ecosystem's meaning, mapped to Xum fields. A plugin agent that
 * sets any Xum-only key keeps Xum semantics unchanged.
 *
 * Plugin-contributed agents only: project, global and built-in agents keep
 * Xum's defaults.
 */

/** Keys that exist only in Xum's agent format. `tools` counts only as an object. */
const XUM_ONLY_KEYS = ["base", "subagent", "ui", "ai", "prompt", "disabled"] as const;

/** Claude Code tool allowlist/denylist keys. Both take Claude tool names. */
const FOREIGN_TOOL_LIST_KEYS = ["tools", "disallowedTools"] as const;

export class ForeignPluginAgentToolsError extends Error {
  constructor(key: string) {
    // Claude Code refuses to launch an agent whose list resolves to no tool.
    // Xum does not translate Claude tool names yet, and dropping the list would
    // grant every tool to an author who asked for fewer, so skip the agent.
    super(
      `Claude Code '${key}' lists are not supported yet: Xum skips this agent instead of granting every tool. Use Xum 'base' and 'tools.add'/'tools.remove' instead.`
    );
    this.name = "ForeignPluginAgentToolsError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isXumFormat(raw: Record<string, unknown>): boolean {
  return XUM_ONLY_KEYS.some((key) => key in raw) || isPlainObject(raw.tools);
}

const KNOWN_MODEL_IDS = new Set<string>(Object.values(KNOWN_MODELS).map((model) => model.id));

/**
 * Claude `model`: alias, bare Claude ID or `inherit`; Cursor `model`: `inherit`
 * or a Cursor ID. Map only what names a known Xum model: anything else
 * (inherit, Cursor IDs, a stale or mistyped Claude ID) uses the inherited
 * model, as Cursor does for unavailable models, instead of failing the spawn.
 */
function mapModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const model = value.trim();
  if (Object.hasOwn(MODEL_ABBREVIATIONS, model)) return model;
  const anthropicId = `anthropic:${model}`;
  return KNOWN_MODEL_IDS.has(anthropicId) ? anthropicId : undefined;
}

/**
 * Map a plugin agent's raw YAML frontmatter to Xum frontmatter (before schema
 * validation, so the foreign keys the schema strips are still visible).
 * Returns `raw` unchanged when it already uses Xum's format.
 */
export function mapForeignPluginAgentFrontmatter(
  raw: Record<string, unknown>,
  /** The file's agent ID: both ecosystems load a plugin agent without `name` under its filename. */
  agentId: string
): Record<string, unknown> {
  if (isXumFormat(raw)) return raw;

  for (const key of FOREIGN_TOOL_LIST_KEYS) {
    if (key in raw) throw new ForeignPluginAgentToolsError(key);
  }

  const model = mapModel(raw.model);
  const effort = ThinkingLevelSchema.safeParse(raw.effort);
  const ai = {
    ...(model !== undefined ? { model } : {}),
    ...(effort.success ? { thinkingLevel: effort.data } : {}),
  };

  const mapped: Record<string, unknown> = {
    ...raw,
    name: raw.name ?? agentId,
    // Omitted tools inherit every tool in both ecosystems: Exec is Xum's
    // all-tools agent. Cursor `readonly: true` narrows to Explore (no file
    // edits or task spawning). Explore keeps bash, so it is not fully read-only.
    base: raw.readonly === true ? "explore" : "exec",
    // Both ecosystems spawn these as sub-agents, never as main-chat modes, and
    // their bodies are written for delegates, so keep them out of the picker.
    ui: { hidden: true },
    subagent: { runnable: true },
    // The body is the whole system prompt in both ecosystems, so it replaces
    // the base body instead of Xum's default append.
    prompt: { append: false },
    ...(Object.keys(ai).length > 0 ? { ai } : {}),
  };
  // `is_background` / `background` stay ignored: Xum's task caller already
  // chooses `run_in_background` per spawn.
  assert(isXumFormat(mapped), "mapped plugin agent frontmatter must use Xum format");
  return mapped;
}
