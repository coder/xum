import type { Tool } from "ai";
import type { z } from "zod";
import type { ToolPolicySchema } from "@/common/orpc/schemas/stream";
import type { MuxMessage } from "@/common/types/message";
import { CONTEXT_BOUNDARY_KINDS } from "@/common/constants/contextBoundary";
import { classifyTodoTurnEndNudgePrompt } from "@/common/utils/machineTurnPrompts";

/**
 * Tool policy - array of filters applied in order
 * Default behavior is "allow" (all tools enabled) for backwards compatibility
 * Inferred from ToolPolicySchema (single source of truth)
 */
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

/**
 * Apply tool policy to filter available tool names.
 *
 * Algorithm:
 * - Filters are applied in order, with default behavior "allow all".
 * - "require" acts like "enable" for filtering purposes.
 * - The last matching filter wins for each tool.
 */
export function applyToolPolicyToNames(toolNames: string[], policy?: ToolPolicy): string[] {
  if (!policy || policy.length === 0) {
    return toolNames;
  }

  // Build a map of tool name -> enabled status.
  // "require" acts as "enable" for filtering purposes — enforcement
  // happens at the stream level (stop-when + post-stream recovery).
  const toolStatus = new Map<string, boolean>();
  for (const toolName of toolNames) {
    toolStatus.set(toolName, true);
  }

  for (const filter of policy) {
    const regex = new RegExp(`^${filter.regex_match}$`);
    const shouldEnable = filter.action !== "disable";

    for (const toolName of toolNames) {
      if (regex.test(toolName)) {
        toolStatus.set(toolName, shouldEnable);
      }
    }
  }

  return toolNames.filter((toolName) => toolStatus.get(toolName) === true);
}

/**
 * Build anchored regexes for the policy's `require` rules.
 *
 * Strips existing anchors to avoid double-anchoring recovery policies
 * (e.g. "^agent_report$" would otherwise become "^^agent_report$$").
 * Shared by StreamManager's stop-when condition and the tool-search catalog
 * classifier (required tools must never be deferred).
 */
export function buildRequiredToolPatterns(policy?: ToolPolicy): RegExp[] {
  return (policy ?? [])
    .filter((filter) => filter.action === "require")
    .map((filter) => {
      const rawPattern = filter.regex_match.replace(/^\^/, "").replace(/\$$/, "");
      return new RegExp(`^${rawPattern}$`);
    });
}

/**
 * Apply tool policy to filter available tools
 * @param tools All available tools
 * @param policy Optional policy to apply (default: allow all)
 * @returns Filtered tools based on policy
 */
export function applyToolPolicy(
  tools: Record<string, Tool>,
  policy?: ToolPolicy
): Record<string, Tool> {
  const enabledToolNames = new Set(applyToolPolicyToNames(Object.keys(tools), policy));
  // new_context only makes sense when the agent can save its checkpoint (memory) and read the
  // sealed window back (session_history): without either, a fresh window could not recover.
  if (!enabledToolNames.has("session_history") || !enabledToolNames.has("memory")) {
    enabledToolNames.delete("new_context");
  }

  return Object.fromEntries(
    Object.entries(tools).filter(([toolName]) => enabledToolNames.has(toolName))
  );
}

/** Rollover must honor the same last-match regex policy as tool assembly. */
export function isSessionHistoryDisabled(policy?: ToolPolicy): boolean {
  return applyToolPolicyToNames(["session_history"], policy).length === 0;
}

/**
 * The turn-end TODO nudge's rule from #6720: it limited the nudged turn to todo_write. #7027
 * stopped adding it, but rows saved before that still carry it (sometimes twice, because each
 * nudge appended it to the turn's own policy), and later wakes, retries and continuations copied it
 * forward. A copied rule also disables session_history and task_await, so every later turn hit
 * context_budget_blocked until a manual send replaced the policy.
 */
const LEGACY_TODO_NUDGE_RULE = { regex_match: "(?!todo_write$).*", action: "disable" } as const;

function sameToolPolicy(raw: unknown, policy: ToolPolicy): boolean {
  return (
    Array.isArray(raw) &&
    raw.length === policy.length &&
    raw.every((rule: unknown, index) => {
      if (rule == null || typeof rule !== "object") return false;
      const candidate = rule as Record<string, unknown>;
      return (
        candidate.regex_match === policy[index].regex_match &&
        candidate.action === policy[index].action
      );
    })
  );
}

function rowText(row: MuxMessage): string {
  return row.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function endsWithLegacyTodoNudgeRule(policy: ToolPolicy): boolean {
  const last = policy.at(-1);
  return (
    last?.regex_match === LEGACY_TODO_NUDGE_RULE.regex_match &&
    last.action === LEGACY_TODO_NUDGE_RULE.action
  );
}

// A compaction request's disable-all policy is for its own summary turn only, so the trace skips it.
// Reset markers are assistant rows, so they count before the user-row filter.
function isTraceableRow(row: MuxMessage): boolean {
  return (
    row.metadata?.contextBoundaryKind === CONTEXT_BOUNDARY_KINDS.RESET ||
    (row.role === "user" && row.metadata?.muxMetadata?.type !== "compaction-request")
  );
}

function breaksTrace(row: MuxMessage, pending: ToolPolicy): boolean {
  return (
    row.metadata?.contextBoundaryKind === CONTEXT_BOUNDARY_KINDS.RESET ||
    row.metadata?.synthetic !== true ||
    !sameToolPolicy(row.metadata.toolPolicy, pending)
  );
}

/**
 * Self-heal saved history without widening a caller's policy. Start it with the policy a reuse
 * path (startup retry, terminal wake) is about to restore from a row, then visit that row and the
 * older rows, newest first, until visit returns true. A legacy rule is dropped only when Xum
 * provably added it: the row that introduced it is a synthetic row whose text is exactly the #6720
 * nudge prompt (Xum wrote that constant, and #6720 set the rule only for a nudge without a hook
 * prompt), and that row's policy ends with the rule (the nudge appended it to the policy of the
 * turn it followed). Synthetic rows that carry the same policy copied it forward, so the trace
 * walks past them. Anything else ends the trace and keeps what is left: a manual row (the caller
 * set it), a row with another policy or none, a reset, or the end of the rows. So a caller who set
 * the same rule keeps it.
 */
export class LegacyTodoNudgePolicyTrace {
  private pending: ToolPolicy;
  private done: boolean;

  /** Without a policy, there is nothing to prove. */
  constructor(policy: ToolPolicy | undefined) {
    this.pending = policy ?? [];
    this.done = !endsWithLegacyTodoNudgeRule(this.pending);
  }

  /** True once visit has nothing left to prove. */
  get finished(): boolean {
    return this.done;
  }

  /** Undefined when nothing is left. */
  get policy(): ToolPolicy | undefined {
    return this.pending.length > 0 ? this.pending : undefined;
  }

  visit(row: MuxMessage): boolean {
    if (this.done || !isTraceableRow(row)) return this.done;
    if (breaksTrace(row, this.pending)) {
      this.done = true;
      return true;
    }
    if (classifyTodoTurnEndNudgePrompt(rowText(row)) === "legacy") {
      this.pending = this.pending.slice(0, -1);
      this.done = !endsWithLegacyTodoNudgeRule(this.pending);
    }
    return this.done;
  }
}

/** LegacyTodoNudgePolicyTrace over rows already in memory, newest first. */
export function resolveLegacyTodoNudgeToolPolicy(
  policy: ToolPolicy | undefined,
  rowsNewestFirst: Iterable<MuxMessage>
): ToolPolicy | undefined {
  // Persisted metadata is unchecked JSON: a value that is not an array goes through unchanged.
  if (!Array.isArray(policy)) return policy;
  const trace = new LegacyTodoNudgePolicyTrace(policy);
  for (const row of rowsNewestFirst) {
    if (trace.visit(row)) break;
  }
  return trace.policy;
}
