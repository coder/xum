import type { ToolExecutionOptions, ToolSet } from "ai";
import assert from "@/common/utils/assert";
import { cloneToolPreservingDescriptors } from "@/common/utils/tools/cloneToolPreservingDescriptors";
import type { ExecutionScope } from "@/node/services/toolCallDisplayRegistry";

/**
 * Execute options as seen by tools assembled through `withExecutionScope`:
 * the AI SDK options plus the host-owned scope of the stream that assembled
 * the tool set. Read it with `getExecutionScope` rather than trusting the
 * field directly when the options came from an unknown caller.
 */
export type ScopedToolExecutionOptions = ToolExecutionOptions<unknown> & {
  readonly muxExecutionScope?: ExecutionScope;
};

/** The scope bound into `options`, or undefined when absent or malformed. */
export function getExecutionScope(options: unknown): ExecutionScope | undefined {
  if (typeof options !== "object" || options === null) {
    return undefined;
  }
  const scope: unknown = (options as ScopedToolExecutionOptions).muxExecutionScope;
  if (typeof scope !== "object" || scope === null) {
    return undefined;
  }
  const { workspaceId, messageId, token } = scope as Record<keyof ExecutionScope, unknown>;
  return typeof workspaceId === "string" &&
    typeof messageId === "string" &&
    typeof token === "string"
    ? (scope as ExecutionScope)
    : undefined;
}

/**
 * Bind the assembling stream's execution scope into every tool's execute
 * options. The scope travels with the tool object, not with "the current
 * stream": a call queued by run A that only starts after run B began still
 * carries A's scope, and nested (PTC) invocations that reuse these tool
 * objects inherit it as well. The host value always wins over anything a
 * caller placed in options. All other options are forwarded untouched; tools
 * without `execute` are returned by reference.
 */
export function withExecutionScope(tools: ToolSet, scope: ExecutionScope): ToolSet {
  const wrapped: ToolSet = { ...tools };
  for (const [toolName, baseTool] of Object.entries(tools)) {
    assert(toolName.length > 0, "tool names must be non-empty");

    const originalExecute = (baseTool as Record<string, unknown>).execute;
    if (typeof originalExecute !== "function") {
      continue;
    }
    const executeFn = originalExecute as (
      this: unknown,
      args: unknown,
      options: unknown
    ) => unknown;
    const wrappedTool = cloneToolPreservingDescriptors(baseTool);
    (wrappedTool as Record<string, unknown>).execute = (args: unknown, options: unknown) => {
      const scoped: ScopedToolExecutionOptions = {
        ...(options as ToolExecutionOptions<unknown>),
        muxExecutionScope: scope,
      };
      return executeFn.call(baseTool, args, scoped);
    };
    wrapped[toolName] = wrappedTool;
  }
  return wrapped;
}
