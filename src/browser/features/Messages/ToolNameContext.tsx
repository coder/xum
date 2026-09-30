import React, { createContext, useContext } from "react";

/**
 * Provides the tool name of the nearest enclosing tool-call row.
 *
 * useStickyExpand reads this so the per-workspace auto-expand preference for
 * tool blocks is keyed by tool name — each tool (bash, file_read, task, …)
 * remembers its own expand/collapse intent instead of sharing one global
 * "tools" bucket. Undefined outside a tool row (e.g. thinking blocks, isolated
 * stories/tests), in which case tool persistence degrades to local-only state.
 */
const ToolNameContext = createContext<string | undefined>(undefined);

interface ToolNameProviderProps {
  toolName: string;
  children: React.ReactNode;
}

export const ToolNameProvider: React.FC<ToolNameProviderProps> = (props) => {
  return (
    <ToolNameContext.Provider value={props.toolName}>{props.children}</ToolNameContext.Provider>
  );
};

export function useToolName(): string | undefined {
  return useContext(ToolNameContext);
}
