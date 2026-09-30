/**
 * tool_catalog_search tool (tool-search experiment, Phase 1).
 *
 * Lets the model discover deferred MCP tools by keyword. Matches are added to
 * the per-stream activation set, so StreamManager's prepareStep advertises
 * them (via `activeTools`) starting on the next step.
 */

import { tool } from "ai";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolSearchToolResult } from "@/common/types/tools";
import { searchToolCatalog } from "@/common/utils/tools/toolCatalog";

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
  });
};
