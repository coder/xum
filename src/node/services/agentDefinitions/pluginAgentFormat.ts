import { KNOWN_MODELS, MODEL_ABBREVIATIONS } from "@/common/constants/knownModels";
import { ThinkingLevelSchema } from "@/common/types/thinking";
import assert from "@/common/utils/assert";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

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
type ForeignToolListKey = (typeof FOREIGN_TOOL_LIST_KEYS)[number];

/**
 * Claude Code tool names (code.claude.com/docs/en/tools-reference) mapped to
 * Xum tool patterns, separately for each list:
 * - `allow` (in `tools`) grants Xum tools only for the core tools, where the
 *   Xum tools do the same job and no more. Every other name grants nothing:
 *   its Xum tools do more than the Claude tool (todo_write replaces the whole
 *   checklist, task_send_message reaches workspaces outside the agent tree).
 * - `deny` (in `disallowedTools`) removes every Xum tool that can do the job,
 *   so several names share one family: denying Write also removes Edit.
 */
interface ClaudeToolMapping {
  allow: readonly string[];
  deny: readonly string[];
}
const same = (patterns: readonly string[]): ClaudeToolMapping => ({
  allow: patterns,
  deny: patterns,
});
/** For names Xum cannot grant precisely, or that Claude Code never gives a sub-agent. */
const denyOnly = (patterns: readonly string[]): ClaudeToolMapping => ({
  allow: [],
  deny: patterns,
});
/** Claude Code tools with no Xum tool: they grant nothing and remove nothing. */
const NONE = same([]);

const BASH_TOOLS = ["bash", "bash_output", "bash_background_.*"];
// Every tool that changes workspace files, as Explore's read-only list removes them.
const FILE_CHANGE_TOOLS = ["file_edit_.*", "image_.*", "task_apply_git_patch"];
// Edit changes existing files only: file_edit_insert also creates files, as Write does.
const EDIT: ClaudeToolMapping = { allow: ["file_edit_replace_.*"], deny: FILE_CHANGE_TOOLS };
const WORKFLOW_TOOLS = ["workflow_run", "workflow_resume"];
const AGENT: ClaudeToolMapping = {
  // Spawning a sub-agent and waiting for its report; the other task tools
  // have their own Claude Code names.
  allow: ["task", "task_await"],
  // Workflows spawn sub-agents too, so denying Agent removes them as well.
  deny: ["task", "task_.*", ...WORKFLOW_TOOLS],
};
const CHECKLIST_WRITE = denyOnly(["todo_write"]);
const CHECKLIST_READ = denyOnly(["todo_read"]);
const SCHEDULE = denyOnly(["heartbeat"]);

const CLAUDE_TOOLS: Readonly<Record<string, ClaudeToolMapping>> = {
  // attach_file also reads files (images, PDFs), as Claude Code's Read does.
  Read: same(["file_read", "attach_file"]),
  Edit: EDIT,
  MultiEdit: EDIT,
  Write: { allow: ["file_edit_.*"], deny: FILE_CHANGE_TOOLS },
  // NotebookEdit edits only notebook cells; Xum's edit tools change any file.
  NotebookEdit: denyOnly(FILE_CHANGE_TOOLS),
  Bash: same(BASH_TOOLS),
  // web_search and x_search are provider-native tools. Xum does not send Gemini's
  // url_context and google_search, but MCP naming reserves only Xum's own tool names, so
  // an MCP tool can carry any of these names: they are removed but never granted.
  WebFetch: { allow: ["web_fetch"], deny: ["web_fetch", "url_context"] },
  WebSearch: denyOnly(["web_search", "google_search", "x_search"]),
  // TaskCreate/TaskGet/TaskList/TaskUpdate replace TodoWrite as Claude Code's checklist.
  TodoWrite: same(["todo_write", "todo_read"]),
  TaskCreate: CHECKLIST_WRITE,
  TaskUpdate: CHECKLIST_WRITE,
  TaskGet: CHECKLIST_READ,
  TaskList: CHECKLIST_READ,
  // Claude Code renamed Task to Agent and keeps Task as an alias.
  Agent: AGENT,
  Task: AGENT,
  // The Xum tools for these do more than the Claude tool, so they are denylist-only.
  // task_stop and task_send_message/task_list reach outside the agent tree.
  TaskStop: denyOnly(["task_stop", "bash_background_terminate"]),
  SendMessage: denyOnly(["task_send_message", "task_message_parent", "task_message_sibling"]),
  ListAgents: denyOnly(["task_list"]),
  // TaskOutput read background task output, as task_await and bash_output do.
  TaskOutput: denyOnly(["task_await", "bash_output"]),
  Skill: denyOnly(["agent_skill_read", "agent_skill_read_file", "agent_skill_list"]),
  ToolSearch: denyOnly(["tool_catalog_search"]),
  Artifact: denyOnly(["artifact", "artifact_list", "artifact_read"]),
  PushNotification: denyOnly(["notify"]),
  // Claude Code removes these from every sub-agent.
  AskUserQuestion: denyOnly(["ask_user_question"]),
  EnterPlanMode: denyOnly(["propose_plan"]),
  ExitPlanMode: denyOnly(["propose_plan"]),
  ScheduleWakeup: SCHEDULE,
  Workflow: denyOnly(WORKFLOW_TOOLS),
  // Xum's one heartbeat tool also sets and removes schedules.
  CronCreate: SCHEDULE,
  CronDelete: SCHEDULE,
  CronList: SCHEDULE,
  Grep: NONE,
  Glob: NONE,
  LSP: NONE,
  PowerShell: NONE,
  Monitor: NONE,
  EnterWorktree: NONE,
  ExitWorktree: NONE,
  EndConversation: NONE,
  ListMcpResourcesTool: NONE,
  ReadMcpResourceTool: NONE,
  RemoteTrigger: NONE,
  ReportFindings: NONE,
  SendFeedback: NONE,
  SendUserFile: NONE,
  ShareOnboardingGuide: NONE,
  SubagentHandback: NONE,
  WaitForMcpServers: NONE,
};

export class ForeignPluginAgentToolsError extends Error {
  constructor(message: string) {
    super(
      `${message} Xum skips this agent instead of granting it more tools than its author allowed.`
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

/** A Claude list key in a raw frontmatter (`tools` only in its list form). */
function foreignToolListKeys(raw: Record<string, unknown>): ForeignToolListKey[] {
  return FOREIGN_TOOL_LIST_KEYS.filter(
    (key) => key in raw && !(key === "tools" && isPlainObject(raw.tools))
  );
}

/**
 * Split a comma-separated list on commas outside parentheses, so a specifier
 * such as Agent(worker, researcher) stays one entry. One pass: agent files can
 * be 1 MB, and a lookahead regex would be quadratic.
 */
function splitToolList(value: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      entries.push(value.slice(start, i));
      start = i + 1;
    }
  }
  entries.push(value.slice(start));
  return entries;
}

/** Claude accepts a comma-separated string or a YAML list. */
function readToolList(raw: Record<string, unknown>, key: ForeignToolListKey): string[] {
  const value = raw[key];
  const entries =
    typeof value === "string"
      ? splitToolList(value)
      : Array.isArray(value) && value.every((entry) => typeof entry === "string")
        ? value
        : undefined;
  if (entries === undefined) {
    throw new ForeignPluginAgentToolsError(
      `Claude Code '${key}' must be a comma-separated string or a list of tool names.`
    );
  }
  return entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/** Claude tools whose specifier does not narrow them in a sub-agent's `tools` list. */
const SPECIFIER_IGNORED_TOOLS = new Set(["Agent", "Task"]);

/** A tool name with an optional specifier, such as `Bash(git push *)`. */
const TOOL_ENTRY_PATTERN = /^(\w+)(\([\s\S]*\))?$/;

const CLAUDE_TOOLS_BY_LOWERCASE_NAME = new Map(
  Object.entries(CLAUDE_TOOLS).map(([name, mapping]) => [name.toLowerCase(), mapping])
);

/**
 * The tool names an allowlist can grant: Xum's own tools. MCP tools are named
 * `<server>_<tool>`, so a prefix pattern such as `todo_.*` also matches an MCP
 * server named `todo`. MCP naming reserves exactly these names, so matching
 * patterns against them can never grant an MCP tool.
 */
const XUM_BUILT_IN_TOOL_NAMES: readonly string[] = Object.keys(TOOL_DEFINITIONS);

function matchesAnyPattern(toolName: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => new RegExp(`^(?:${pattern})$`).test(toolName));
}

/** Xum tool patterns that one `disallowedTools` entry removes. */
function mapDeniedEntry(entry: string): readonly string[] {
  // Xum names plugin MCP tools differently, so it cannot match `mcp__` entries
  // yet. Ignoring one, or an entry it cannot read, would keep a denied tool.
  const match = entry.startsWith("mcp__") ? null : TOOL_ENTRY_PATTERN.exec(entry);
  if (match == null) {
    throw new ForeignPluginAgentToolsError(
      `Xum cannot read the Claude Code 'disallowedTools' entry '${entry}' (MCP entries are not supported yet).`
    );
  }
  // A specifier still removes the whole tool, as in Claude Code. The name is
  // matched without case, so a denylist never misses a tool over its spelling.
  // An unknown name can be a newer Claude tool that Xum does have.
  const mapping = CLAUDE_TOOLS_BY_LOWERCASE_NAME.get(match[1].toLowerCase());
  if (mapping === undefined) {
    throw new ForeignPluginAgentToolsError(
      `Xum does not know the Claude Code tool '${match[1]}' in 'disallowedTools'.`
    );
  }
  return mapping.deny;
}

/** Xum tool patterns that one `tools` entry grants; `mcp__` entries grant nothing yet. */
function mapAllowedEntry(entry: string): readonly string[] {
  const match = TOOL_ENTRY_PATTERN.exec(entry);
  if (match == null) return [];
  const [, name, specifier] = match;
  // A specifier narrows a tool to some calls (`Bash(npm test)`). Xum cannot do
  // that, so it does not grant the tool, except Agent(...), whose type list
  // Claude Code ignores in sub-agents.
  if (specifier !== undefined && !SPECIFIER_IGNORED_TOOLS.has(name)) return [];
  return Object.hasOwn(CLAUDE_TOOLS, name) ? CLAUDE_TOOLS[name].allow : [];
}

/**
 * Translate Claude `tools` / `disallowedTools` lists to Xum `tools.remove`
 * patterns on top of the Exec (or Explore) base, which enables every tool.
 * Claude Code removes `disallowedTools` first, then keeps only the `tools`
 * entries left in the pool, and refuses to launch an agent with no tool left.
 */
function mapToolLists(raw: Record<string, unknown>): { remove: string[] } | undefined {
  const keys = foreignToolListKeys(raw);
  if (keys.length === 0) return undefined;

  const denied = keys.includes("disallowedTools")
    ? [...new Set(readToolList(raw, "disallowedTools").flatMap(mapDeniedEntry))]
    : [];
  const remove = [...denied];

  if (keys.includes("tools")) {
    const entries = readToolList(raw, "tools");
    const grants = [...new Set(entries.flatMap(mapAllowedEntry))];
    const allowed = XUM_BUILT_IN_TOOL_NAMES.filter(
      (name) => matchesAnyPattern(name, grants) && !matchesAnyPattern(name, denied)
    );
    if (allowed.length === 0) {
      throw new ForeignPluginAgentToolsError(
        `Claude Code 'tools' (${entries.join(", ") || "empty"}) resolves to no Xum tool, so Claude Code would refuse to launch this agent.`
      );
    }
    assert(
      allowed.every((name) => /^[a-z0-9_]+$/.test(name)),
      "built-in tool names must be regex-safe"
    );
    // Within one layer a remove overrides an add, so the allowlist cannot add
    // tools on top of the base. It removes every tool it does not name instead.
    remove.unshift(`(?!(?:${allowed.join("|")})$).*`);
  }
  return remove.length > 0 ? { remove } : undefined;
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

/** Claude `model` / `effort` as Xum `ai` defaults; empty when neither maps. */
function mapAiDefaults(raw: Record<string, unknown>): { model?: string; thinkingLevel?: string } {
  const model = mapModel(raw.model);
  const effort = ThinkingLevelSchema.safeParse(raw.effort);
  return {
    ...(model !== undefined ? { model } : {}),
    ...(effort.success ? { thinkingLevel: effort.data } : {}),
  };
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
  if (isXumFormat(raw)) {
    // A Xum-format file keeps Xum semantics, and the schema would strip a
    // Claude list silently, so the agent would get more tools than its author
    // allowed (#6624). Refuse instead of guessing which format the author meant.
    const [key] = foreignToolListKeys(raw);
    if (key !== undefined) {
      throw new ForeignPluginAgentToolsError(
        `This agent mixes Xum fields with a Claude Code '${key}' list. Use Xum 'tools.add'/'tools.remove', or drop the Xum fields.`
      );
    }
    return raw;
  }

  const ai = mapAiDefaults(raw);
  const tools = mapToolLists(raw);

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
    // `readonly` agents get Explore's prompt before their own body (Cursor plugin RFC, D13).
    // Other agents keep append: false.
    prompt: { append: raw.readonly === true },
    ...(Object.keys(ai).length > 0 ? { ai } : {}),
    // Replaces the Claude list. Kept in the mapped frontmatter, so the install
    // consent fingerprint changes when the effective tool list changes.
    ...(tools !== undefined ? { tools } : {}),
  };
  // The Claude list must never survive into Xum fields: the schema would reject
  // or strip it, and either way the tool restriction would be lost.
  assert(
    !("tools" in mapped) || isPlainObject(mapped.tools),
    "a Claude tools list must be mapped to Xum tools"
  );
  // `is_background` / `background` stay ignored: Xum's task caller already
  // chooses `run_in_background` per spawn.
  assert(isXumFormat(mapped), "mapped plugin agent frontmatter must use Xum format");
  return mapped;
}
