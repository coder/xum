/**
 * tool_catalog_search tool (tool search, Phase 1).
 *
 * Lets the model discover deferred MCP tools by keyword. Matches are added to
 * the per-stream activation set, so StreamManager's prepareStep advertises
 * them (via `activeTools`) starting on the next step. In native mode the
 * result instead reaches the model as `tool_reference` blocks (#5262).
 */

import { tool } from "ai";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolSearchToolResult } from "@/common/types/tools";
import { buildToolSearchModelOutput, searchToolCatalog } from "@/common/utils/tools/toolCatalog";

export const createToolSearchTool: ToolFactory = (config) => {
  // Captured at creation; `state` is assigned later, after the post-policy
  // gate builds the catalog — read it lazily at execute time.
  const runtime = config.toolSearchRuntime;
  return tool({
    description: TOOL_DEFINITIONS.tool_catalog_search.description,
    inputSchema: TOOL_DEFINITIONS.tool_catalog_search.schema,
    execute: ({ query, limit }): ToolSearchToolResult => {
      const state = runtime?.state;
      // Defensive: when the post-policy gate deactivated deferral this tool is
      // removed from the toolset, so state should always exist here. Return an
      // empty result rather than crashing the stream if it somehow doesn't.
      if (state == null) {
        return { query, matches: [], totalDeferred: 0 };
      }
      const matches = searchToolCatalog(state.catalog, query, limit);
      for (const match of matches) {
        state.activatedToolNames.add(match.name);
      }
      return { query, matches, totalDeferred: state.catalog.length };
    },
    // Read at call time: a model fallback can switch the stream between native
    // and scoped mode. The persisted output (and the UI) stays the raw result.
    toModelOutput: ({ output }) => {
      const state = runtime?.state;
      return state?.native === true
        ? buildToolSearchModelOutput(output, state.deferredToolNames)
        : // Spread: an interface type lacks the implicit index signature JSONValue needs.
          { type: "json", value: { ...output } };
    },
  });
};
