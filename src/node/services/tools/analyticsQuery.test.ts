import { describe, expect, mock, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { createAnalyticsQueryTool, TOOL_RESULT_ROW_LIMIT } from "./analyticsQuery";
import { TestTempDir, createTestToolConfig } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

async function expectToolExecutionFailure(
  execution: Promise<unknown>,
  errorPattern: RegExp
): Promise<void> {
  try {
    await execution;
    throw new Error("Expected tool execution to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw error;
    }
    expect(error.message).toMatch(errorPattern);
  }
}

describe("createAnalyticsQueryTool", () => {
  test("returns success payload and visualization hints when query succeeds", async () => {
    using tempDir = new TestTempDir("analytics-query-tool-success");
    const config = createTestToolConfig(tempDir.path);
    const executeRawQuery = mock(() =>
      Promise.resolve({
        columns: [
          { name: "model", type: "VARCHAR" },
          { name: "cost_usd", type: "DOUBLE" },
        ],
        rows: [
          { model: "openai:gpt-4.1", cost_usd: 1.5 },
          { model: "anthropic:claude-opus-4-1", cost_usd: 2.25 },
        ],
        truncated: false,
        rowCount: 2,
        durationMs: 7,
      })
    );

    const tool = createAnalyticsQueryTool({
      ...config,
      analyticsService: { executeRawQuery },
    });

    const result: unknown = await tool.execute!(
      {
        sql: "SELECT model, SUM(total_cost_usd) AS cost_usd FROM events GROUP BY model",
        visualization: "bar",
        title: "Spend by model",
        x_axis: "model",
        y_axis: ["cost_usd"],
      },
      mockToolCallOptions
    );

    expect(executeRawQuery).toHaveBeenCalledWith(
      "SELECT model, SUM(total_cost_usd) AS cost_usd FROM events GROUP BY model"
    );
    expect(result).toEqual({
      success: true,
      columns: [
        { name: "model", type: "VARCHAR" },
        { name: "cost_usd", type: "DOUBLE" },
      ],
      rows: [
        { model: "openai:gpt-4.1", cost_usd: 1.5 },
        { model: "anthropic:claude-opus-4-1", cost_usd: 2.25 },
      ],
      truncated: false,
      rowCount: 2,
      durationMs: 7,
      visualization: "bar",
      title: "Spend by model",
      x_axis: "model",
      y_axis: ["cost_usd"],
    });
  });

  test("returns success:false when query execution fails", async () => {
    using tempDir = new TestTempDir("analytics-query-tool-error");
    const config = createTestToolConfig(tempDir.path);
    const tool = createAnalyticsQueryTool({
      ...config,
      analyticsService: {
        executeRawQuery: () => Promise.reject(new Error("SQL parse error at line 1")),
      },
    });

    const result: unknown = await tool.execute!(
      {
        sql: "SELECT * FRM events",
      },
      mockToolCallOptions
    );

    expect(result).toEqual({
      success: false,
      error: "SQL parse error at line 1",
    });
  });

  test("caps rows at TOOL_RESULT_ROW_LIMIT and sets truncated flag", async () => {
    using tempDir = new TestTempDir("analytics-query-tool-row-cap");
    const config = createTestToolConfig(tempDir.path);

    // Generate rows exceeding the tool result limit
    const oversizedRows = Array.from({ length: TOOL_RESULT_ROW_LIMIT + 50 }, (_, i) => ({
      id: i,
      value: i * 0.01,
    }));

    const backendRowCount = oversizedRows.length + 200;
    const executeRawQuery = mock(() =>
      Promise.resolve({
        columns: [
          { name: "id", type: "INTEGER" },
          { name: "value", type: "DOUBLE" },
        ],
        rows: oversizedRows,
        truncated: false,
        rowCount: backendRowCount,
        durationMs: 3,
      })
    );

    const tool = createAnalyticsQueryTool({
      ...config,
      analyticsService: { executeRawQuery },
    });

    const result = (await tool.execute!({ sql: "SELECT * FROM events" }, mockToolCallOptions)) as {
      success: boolean;
      rows: unknown[];
      rowCount: number;
      truncated: boolean;
    };

    expect(result.success).toBe(true);
    expect(result.rows).toHaveLength(TOOL_RESULT_ROW_LIMIT);
    // rowCount should preserve backend metadata, not be recomputed from capped rows
    expect(result.rowCount).toBe(backendRowCount);
    expect(result.truncated).toBe(true);
  });

  test("throws when analyticsService is missing from configuration", async () => {
    using tempDir = new TestTempDir("analytics-query-tool-missing-service");
    const baseConfig = createTestToolConfig(tempDir.path);
    const configWithoutService: ToolConfiguration = {
      ...baseConfig,
      analyticsService: undefined,
    };

    const tool = createAnalyticsQueryTool(configWithoutService);

    await expectToolExecutionFailure(
      Promise.resolve(
        tool.execute!(
          {
            sql: "SELECT 1",
          },
          mockToolCallOptions
        )
      ),
      /analytics_query tool requires ToolConfiguration\.analyticsService/i
    );
  });
});
