import React from "react";
import type { ToolStatus } from "./toolUtils";
import { isSuppressedKernelResult } from "./codeExecutionTypes";
import { getToolComponent } from "./getToolComponent";
import { HookOutputDisplay, extractHookDuration, extractHookOutput } from "./HookOutputDisplay";
import { ToolNameProvider } from "../../Messages/ToolNameContext";

interface NestedToolRendererProps {
  toolName: string;
  input: unknown;
  output?: unknown;
  status: ToolStatus;
}

/**
 * Routes nested tool calls to their specialized components.
 * Uses the shared registry for component lookup.
 */
export const NestedToolRenderer: React.FC<NestedToolRendererProps> = ({
  toolName,
  input,
  output,
  status,
}) => {
  const ToolComponent = getToolComponent(toolName, input);
  const hookOutput = extractHookOutput(output);
  const hookDuration = extractHookDuration(output);
  // Kernel-mode reload summaries ({suppressed, ok, bytes}) are not tool-shaped
  // results; feeding them into specialized cards renders placeholder garbage
  // (e.g. bash's exit-code pill with no exit code). Status already reflects
  // ok/failure, so render the card without a result instead.
  const componentResult = isSuppressedKernelResult(output) ? undefined : output;

  return (
    <>
      {/* ToolNameProvider lets useStickyExpand key the auto-expand preference by tool name. */}
      <ToolNameProvider toolName={toolName}>
        <ToolComponent args={input} result={componentResult} status={status} toolName={toolName} />
      </ToolNameProvider>
      {hookOutput && <HookOutputDisplay output={hookOutput} durationMs={hookDuration} />}
    </>
  );
};
