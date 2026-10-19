import type { CompletedMessagePart } from "@/common/types/stream";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";
import type { SendMessageOptions } from "@/common/orpc/types";
import { TURN_STOP_PROMPT_MAX_CHARS } from "@/node/services/agentPlugins/promptHooks";
import { isSuccessfulToolResult } from "@/node/services/aiServiceEventGuards";
import { readTodosForSessionDir } from "@/node/services/todos/todoStorage";
import { TODO_TURN_END_NUDGE } from "@/common/utils/machineTurnPrompts";

// The prompt text lives in common code so the transcript can render it as a compact row.
export { TODO_TURN_END_NUDGE };

/**
 * The tool policy of a nudge-only continuation: todo_write and nothing else, so the extra turn
 * cannot run commands or edit files. Appended to the agent's policy, it only disables: it never
 * enables a tool, so an agent that denies todo_write keeps that deny. The request builder
 * enforces it at execution, not by hiding tools (see splitTodoTurnEndNudgePolicy).
 */
export const TODO_TURN_END_NUDGE_TOOL_POLICY: ToolPolicy = [
  { regex_match: "(?!todo_write$).*", action: "disable" },
];

/**
 * The nudge's rules as an execution gate (see applyToolPolicyAndExperiments): every tool the
 * turn before advertised stays advertised, and each one but todo_write returns this refusal.
 */
export const TODO_TURN_END_NUDGE_EXECUTION_GATE = {
  policy: TODO_TURN_END_NUDGE_TOOL_POLICY,
  refusal: (toolName: string) =>
    `Tool '${toolName}' is not allowed in the turn-end todo nudge. Only todo_write runs in this turn.`,
};

/** A caller tool policy split for the request builder (see splitTodoTurnEndNudgePolicy). */
export interface TodoTurnEndNudgeSplit {
  /** The caller policy the turn's tools are advertised under. */
  callerToolPolicy: ToolPolicy | undefined;
  /** Set on a nudge turn: tool assembly refuses, at execution, what the gate denies. */
  executionGate: typeof TODO_TURN_END_NUDGE_EXECUTION_GATE | undefined;
}

/**
 * Splits the nudge's trailing rules off a caller tool policy. Advertising only todo_write
 * changed the tools block, which sits first in the Anthropic prompt cache, so each nudge
 * rewrote the whole cached history twice (once for the nudge, once for the next turn). The
 * request builder now advertises the tools under the rest of the policy and enforces the nudge
 * rules at execution. The rules stay in the persisted policy, so a retried, restarted or
 * compacted nudge (and an older Xum) still narrows.
 */
export function splitTodoTurnEndNudgePolicy(policy: ToolPolicy | undefined): TodoTurnEndNudgeSplit {
  const ruleCount = TODO_TURN_END_NUDGE_TOOL_POLICY.length;
  const isNudgeTail =
    policy != null &&
    policy.length >= ruleCount &&
    policy
      .slice(-ruleCount)
      .every(
        (rule, index) =>
          rule.regex_match === TODO_TURN_END_NUDGE_TOOL_POLICY[index].regex_match &&
          rule.action === TODO_TURN_END_NUDGE_TOOL_POLICY[index].action
      );
  if (!isNudgeTail) return { callerToolPolicy: policy, executionGate: undefined };
  const rest = policy.slice(0, -ruleCount);
  return {
    // mergeTurnStopContinuation appends to `callerToolPolicy ?? []`: an empty rest was no policy.
    callerToolPolicy: rest.length > 0 ? rest : undefined,
    executionGate: TODO_TURN_END_NUDGE_EXECUTION_GATE,
  };
}

/**
 * Send options a later turn inherits from one that ended, without the nudge's rules: they
 * govern the nudge turn alone, like a compaction request's disable-all policy. Inherited, they
 * left a plugin or goal continuation after a nudge with todo_write only (#6720).
 */
export function withoutTodoTurnEndNudge<T extends { toolPolicy?: ToolPolicy }>(
  options: T | undefined
): T | undefined {
  const split = splitTodoTurnEndNudgePolicy(options?.toolPolicy);
  if (options == null || split.executionGate == null) return options;
  const inherited = { ...options };
  // Omitted, not undefined: a spread over persisted options must not clobber their policy.
  if (split.callerToolPolicy == null) delete inherited.toolPolicy;
  else inherited.toolPolicy = split.callerToolPolicy;
  return inherited;
}

/** The policy that decides what may run: the advertised policy plus the gate's rules. */
export function withExecutionGate(
  policy: ToolPolicy | undefined,
  gate: TodoTurnEndNudgeSplit["executionGate"]
): ToolPolicy | undefined {
  return gate == null ? policy : [...(policy ?? []), ...gate.policy];
}

/** A todo_write call that ran and succeeded; a refused or failed call is not a list write. */
function isSuccessfulTodoWrite(call: { toolName: string; state: string; output?: unknown }) {
  return (
    call.toolName === "todo_write" &&
    call.state === "output-available" &&
    isSuccessfulToolResult(call.output)
  );
}

/**
 * Whether the ending stream earns the nudge: a todo_write call succeeded and the list still has a pending
 * or in-progress item. False (no extra model step) for turns that never called todo_write, so
 * they cost no todo read either.
 */
export async function needsTodoTurnEndNudge(input: {
  sessionDir: string;
  parts: readonly CompletedMessagePart[];
}): Promise<boolean> {
  const wroteTodos = input.parts.some(
    (part) =>
      part.type === "dynamic-tool" &&
      (isSuccessfulTodoWrite(part) ||
        // Programmatic tool calling runs todo_write inside code_execution.
        part.nestedCalls?.some(isSuccessfulTodoWrite) === true)
  );
  if (!wroteTodos) return false;

  const todos = await readTodosForSessionDir(input.sessionDir);
  return todos.some((todo) => todo.status !== "completed");
}

export interface TurnStopContinuation {
  prompt: string;
  optionOverrides?: Pick<SendMessageOptions, "toolPolicy">;
}

/** The turn.stop continuation from the plugin hooks' prompt and the nudge, or null for none. */
export function mergeTurnStopContinuation(input: {
  hookPrompt: string | null;
  todoNudge: boolean;
  callerToolPolicy: ToolPolicy | undefined;
}): TurnStopContinuation | null {
  if (!input.todoNudge) return input.hookPrompt == null ? null : { prompt: input.hookPrompt };
  // A nudge alone narrows the turn's own policy to todo_write.
  if (input.hookPrompt == null) {
    return {
      prompt: TODO_TURN_END_NUDGE,
      optionOverrides: {
        toolPolicy: [...(input.callerToolPolicy ?? []), ...TODO_TURN_END_NUDGE_TOOL_POLICY],
      },
    };
  }
  // A plugin continuation keeps the turn's tools. The joined prompt keeps the cap: the plugin's
  // part is cut, so the nudge always arrives whole.
  const separator = "\n\n";
  const hookRoom = TURN_STOP_PROMPT_MAX_CHARS - separator.length - TODO_TURN_END_NUDGE.length;
  return {
    prompt: `${input.hookPrompt.slice(0, hookRoom)}${separator}${TODO_TURN_END_NUDGE}`,
  };
}
