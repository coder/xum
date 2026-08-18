import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import {
  appendEvents,
  CHAT_FILE_NAME,
  clearWorkspaceAnalyticsState,
  deleteCorruptAnalyticsRows,
  getCurrentPricingFingerprint,
  ingestWorkspace,
  parseWorkspaceFromDisk,
  readPersistedWorkspaceHeadSignature,
  readStoredPricingFingerprint,
  rebuildAll,
  statSessionChatHistory,
  storePricingFingerprint,
} from "./etl";
import {
  CREATE_DELEGATION_ROLLUPS_TABLE_SQL,
  CREATE_EVENTS_TABLE_SQL,
  CREATE_INGEST_META_TABLE_SQL,
  CREATE_WATERMARK_TABLE_SQL,
} from "./schemaSql";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";

const SUBAGENT_TRANSCRIPTS_DIR_NAME = "subagent-transcripts";

const CREATE_EVENTS_TABLE_WITHOUT_TOOL_NAME_SQL = CREATE_EVENTS_TABLE_SQL.replace(
  "\n  tool_name TEXT,",
  ""
)
  .replace("\n  tool_name TEXT", "")
  .replace(",\n)", "\n)");

const tempDirsToClean: string[] = [];
const duckDbHandlesToClose: Array<{ instance: DuckDBInstance; conn: DuckDBConnection }> = [];

function createMissingSessionsDir(): string {
  return path.join(os.tmpdir(), `mux-analytics-etl-${process.pid}-${randomUUID()}`);
}

function createMockConn(runImplementation: (sql: string, params?: unknown[]) => Promise<unknown>): {
  conn: DuckDBConnection;
  runMock: ReturnType<typeof mock>;
} {
  const runMock = mock(runImplementation);

  return {
    conn: { run: runMock } as unknown as DuckDBConnection,
    runMock,
  };
}

function getSqlStatements(runMock: ReturnType<typeof mock>): string[] {
  const calls = runMock.mock.calls as unknown[][];

  return calls.map((call) => {
    const sql = call[0];
    if (typeof sql !== "string") {
      throw new TypeError("Expected SQL statement as the first run() argument");
    }

    return sql;
  });
}

function makeAssistantLine(
  opts: {
    model?: string;
    metadataModel?: string;
    sequence?: number;
    timestamp?: number;
    inputTokens?: number;
    outputTokens?: number;
    durationMs?: number;
    ttftMs?: number;
    providerMetadata?: Record<string, unknown>;
    toolModelUsages?: unknown[];
  } = {}
): string {
  return JSON.stringify({
    role: "assistant",
    content: "response",
    metadata: {
      model: opts.model ?? "anthropic:claude-sonnet-4-20250514",
      ...(opts.metadataModel ? { metadataModel: opts.metadataModel } : {}),
      usage: {
        inputTokens: opts.inputTokens ?? 100,
        outputTokens: opts.outputTokens ?? 50,
      },
      historySequence: opts.sequence ?? 1,
      timestamp: opts.timestamp ?? 1700000000000,
      ...(opts.durationMs != null ? { duration: opts.durationMs } : {}),
      ...(opts.ttftMs != null ? { ttftMs: opts.ttftMs } : {}),
      ...(opts.providerMetadata != null ? { providerMetadata: opts.providerMetadata } : {}),
      ...(opts.toolModelUsages != null ? { toolModelUsages: opts.toolModelUsages } : {}),
    },
  });
}

function makeUserLine(): string {
  return JSON.stringify({
    role: "user",
    content: "test",
    createdAt: "2024-01-01T00:00:00.000Z",
  });
}

function parseInteger(value: unknown, fieldName: string): number {
  if (typeof value === "number") {
    assert(Number.isInteger(value), `${fieldName} should be an integer number`);
    return value;
  }

  if (typeof value === "bigint") {
    const coerced = Number(value);
    assert(Number.isSafeInteger(coerced), `${fieldName} should coerce to a safe integer`);
    return coerced;
  }

  throw new TypeError(`${fieldName} should be an integer-compatible value`);
}

function parseBooleanFromInteger(value: unknown, fieldName: string): boolean {
  const parsed = parseInteger(value, fieldName);
  assert(parsed === 0 || parsed === 1, `${fieldName} should be 0 or 1`);
  return parsed === 1;
}

function serializeHeadSignatureValue(value: string | number | null): string {
  if (value === null) {
    return "null";
  }

  return `${typeof value}:${String(value)}`;
}

function parseNullableFiniteNumber(value: unknown, fieldName: string): number | null {
  if (value === null) {
    return null;
  }

  if (typeof value === "number") {
    assert(Number.isFinite(value), `${fieldName} should be a finite number`);
    return value;
  }

  if (typeof value === "bigint") {
    const coerced = Number(value);
    assert(Number.isFinite(coerced), `${fieldName} should coerce to a finite number`);
    return coerced;
  }

  throw new TypeError(`${fieldName} should be numeric or null`);
}

function createHeadSignatureFromRow(row: {
  timestamp: unknown;
  model: unknown;
  total_cost_usd: unknown;
}): string {
  const model = row.model;
  assert(model === null || typeof model === "string", "model should be a string or null");

  return [
    serializeHeadSignatureValue(parseNullableFiniteNumber(row.timestamp, "timestamp")),
    serializeHeadSignatureValue(model),
    serializeHeadSignatureValue(parseNullableFiniteNumber(row.total_cost_usd, "total_cost_usd")),
  ].join("|");
}

async function createTempSessionDir(): Promise<string> {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-etl-test-"));
  tempDirsToClean.push(sessionDir);
  return sessionDir;
}

async function createTestConn(
  params: {
    createEventsTableSql?: string;
    postCreateEventsSql?: string[];
  } = {}
): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  duckDbHandlesToClose.push({ instance, conn });

  await conn.run(params.createEventsTableSql ?? CREATE_EVENTS_TABLE_SQL);
  for (const sql of params.postCreateEventsSql ?? []) {
    await conn.run(sql);
  }
  await conn.run(CREATE_WATERMARK_TABLE_SQL);
  await conn.run(CREATE_DELEGATION_ROLLUPS_TABLE_SQL);
  await conn.run(CREATE_INGEST_META_TABLE_SQL);

  return conn;
}

async function writeChatJsonl(sessionDir: string, lines: string[]): Promise<void> {
  await fs.writeFile(path.join(sessionDir, CHAT_FILE_NAME), `${lines.join("\n")}\n`);
}

async function writeMetadataJson(sessionDir: string, meta: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(sessionDir, "metadata.json"), JSON.stringify(meta));
}

async function writeSessionUsageJson(
  sessionDir: string,
  usage: Record<string, unknown>
): Promise<void> {
  await fs.writeFile(path.join(sessionDir, "session-usage.json"), JSON.stringify(usage));
}

async function writeBasicChatJsonl(sessionDir: string): Promise<void> {
  await writeChatJsonl(sessionDir, [makeUserLine(), makeAssistantLine({ sequence: 1 })]);
}

async function createArchivedSubagentTranscript(
  parentSessionDir: string,
  childWorkspaceId: string,
  metadata?: Record<string, unknown>
): Promise<string> {
  const childSessionDir = path.join(
    parentSessionDir,
    SUBAGENT_TRANSCRIPTS_DIR_NAME,
    childWorkspaceId
  );
  await fs.mkdir(childSessionDir, { recursive: true });
  await writeBasicChatJsonl(childSessionDir);
  if (metadata != null) {
    await writeMetadataJson(childSessionDir, metadata);
  }
  return childSessionDir;
}

async function queryRows(
  conn: DuckDBConnection,
  sql: string,
  params: string[] = []
): Promise<Array<Record<string, unknown>>> {
  const result = await conn.run(sql, params);
  return await result.getRowObjectsJS();
}

async function queryEventCount(conn: DuckDBConnection, workspaceId?: string): Promise<number> {
  const rows =
    workspaceId == null
      ? await queryRows(conn, "SELECT COUNT(*) AS cnt FROM events")
      : await queryRows(conn, "SELECT COUNT(*) AS cnt FROM events WHERE workspace_id = ?", [
          workspaceId,
        ]);

  assert(rows.length === 1, "queryEventCount expected exactly one row");
  return parseInteger(rows[0].cnt, "cnt");
}

async function bumpChatMtime(sessionDir: string): Promise<void> {
  const chatPath = path.join(sessionDir, CHAT_FILE_NAME);
  const currentStat = await fs.stat(chatPath);
  const bumpedTime = new Date(currentStat.mtimeMs + 5_000);
  await fs.utimes(chatPath, bumpedTime, bumpedTime);
}

afterEach(async () => {
  for (const { conn, instance } of duckDbHandlesToClose.splice(0).reverse()) {
    try {
      conn.closeSync();
    } catch {
      // Ignore close failures in test cleanup.
    }

    try {
      instance.closeSync();
    } catch {
      // Ignore close failures in test cleanup.
    }
  }

  await Promise.all(
    tempDirsToClean.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe("rebuildAll", () => {
  test("deletes events and watermarks inside a single transaction", async () => {
    const { conn, runMock } = createMockConn(() => Promise.resolve(undefined));

    const result = await rebuildAll(conn, createMissingSessionsDir());

    expect(result).toEqual({ workspacesIngested: 0 });
    expect(getSqlStatements(runMock)).toEqual([
      "BEGIN TRANSACTION",
      "DELETE FROM events",
      "DELETE FROM ingest_watermarks",
      "DELETE FROM delegation_rollups",
      "COMMIT",
    ]);
  });

  test("rolls back when the reset cannot delete both tables", async () => {
    const deleteWatermarksError = new Error("delete ingest_watermarks failed");
    const { conn, runMock } = createMockConn((sql) => {
      if (sql === "DELETE FROM ingest_watermarks") {
        return Promise.reject(deleteWatermarksError);
      }

      return Promise.resolve(undefined);
    });

    await rebuildAll(conn, createMissingSessionsDir()).then(
      () => {
        throw new Error("Expected rebuildAll to reject when deleting ingest_watermarks fails");
      },
      (error: unknown) => {
        expect(error).toBe(deleteWatermarksError);
      }
    );

    expect(getSqlStatements(runMock)).toEqual([
      "BEGIN TRANSACTION",
      "DELETE FROM events",
      "DELETE FROM ingest_watermarks",
      "ROLLBACK",
    ]);
  });

  test("continues rebuild when parsing one workspace fails", async () => {
    const conn = await createTestConn();
    const sessionsDir = await createTempSessionDir();

    const goodWorkspaceDir = path.join(sessionsDir, "ws-good");
    await fs.mkdir(goodWorkspaceDir, { recursive: true });
    await writeChatJsonl(goodWorkspaceDir, [makeUserLine(), makeAssistantLine()]);

    const badWorkspaceDir = path.join(sessionsDir, "ws-bad");
    await fs.mkdir(path.join(badWorkspaceDir, CHAT_FILE_NAME), { recursive: true });

    const result = await rebuildAll(conn, sessionsDir, {});

    expect(result).toEqual({ workspacesIngested: 1 });
    expect(await queryEventCount(conn)).toBe(1);
  });
});

describe("appendEvents", () => {
  test("inserts parsed events with expected fields", async () => {
    const conn = await createTestConn();
    const sessionDir = await createTempSessionDir();

    await writeMetadataJson(sessionDir, {
      projectPath: "/proj",
      projectName: "my-proj",
    });
    await writeChatJsonl(sessionDir, [
      makeUserLine(),
      makeAssistantLine({ model: "openai:gpt-4", inputTokens: 200, outputTokens: 75 }),
    ]);

    const parsed = await parseWorkspaceFromDisk("ws-append", sessionDir, {});
    expect(parsed).not.toBeNull();
    assert(parsed, "appendEvents test expected parseWorkspaceFromDisk to parse workspace");

    await appendEvents(conn, parsed.events);

    expect(await queryEventCount(conn, "ws-append")).toBe(1);
    const rows = await queryRows(
      conn,
      "SELECT model, input_tokens, output_tokens, project_path FROM events WHERE workspace_id = ?",
      ["ws-append"]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe("openai:gpt-4");
    expect(parseInteger(rows[0].input_tokens, "input_tokens")).toBe(200);
    expect(parseInteger(rows[0].output_tokens, "output_tokens")).toBe(75);
    expect(rows[0].project_path).toBe("/proj");
  });

  test("uses metadataModel for pricing while keeping the raw model in analytics rows", async () => {
    const conn = await createTestConn();
    const sessionDir = await createTempSessionDir();

    await writeChatJsonl(sessionDir, [
      makeUserLine(),
      makeAssistantLine({
        model: "openai:my-gpt4",
        metadataModel: "openai:gpt-4",
        inputTokens: 200,
        outputTokens: 75,
      }),
    ]);

    const parsed = await parseWorkspaceFromDisk("ws-priced-model", sessionDir, {});
    expect(parsed).not.toBeNull();
    assert(parsed, "priced model test expected parseWorkspaceFromDisk to parse workspace");

    await appendEvents(conn, parsed.events);

    const rows = await queryRows(
      conn,
      "SELECT model, input_cost_usd, output_cost_usd, total_cost_usd FROM events WHERE workspace_id = ?",
      ["ws-priced-model"]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe("openai:my-gpt4");
    expect(Number(rows[0].input_cost_usd)).toBeGreaterThan(0);
    expect(Number(rows[0].output_cost_usd)).toBeGreaterThan(0);
    expect(Number(rows[0].total_cost_usd)).toBeGreaterThan(0);
  });

  test("keeps tool_name aligned across fresh and migrated events tables", async () => {
    const freshConn = await createTestConn();
    const migratedConn = await createTestConn({
      createEventsTableSql: CREATE_EVENTS_TABLE_WITHOUT_TOOL_NAME_SQL,
      postCreateEventsSql: ["ALTER TABLE events ADD COLUMN IF NOT EXISTS tool_name TEXT"],
    });
    const sessionDir = await createTempSessionDir();
    const workspaceId = "ws-tool-column-order";

    await writeChatJsonl(sessionDir, [
      makeUserLine(),
      makeAssistantLine({
        model: "openai:gpt-4",
        inputTokens: 180,
        outputTokens: 72,
        timestamp: 1_700_000_000_000,
        toolModelUsages: [
          {
            toolName: "bash",
            toolCallId: "tool-call-1",
            timestamp: 1_700_000_000_025,
            model: "openai:gpt-4",
            usage: { inputTokens: 36, outputTokens: 12, totalTokens: 48 },
            providerMetadata: { openai: { reasoningTokens: 3 } },
          },
        ],
      }),
    ]);

    const parsed = await parseWorkspaceFromDisk(workspaceId, sessionDir, {});
    expect(parsed).not.toBeNull();
    assert(parsed, "column-order test expected parseWorkspaceFromDisk to parse workspace");

    const toolEvents = parsed.events.filter((event) => event.row.tool_name != null);
    expect(toolEvents).toHaveLength(1);

    await appendEvents(freshConn, toolEvents);
    await appendEvents(migratedConn, toolEvents);

    const normalizeSelectedRow = (row: Record<string, unknown>) => ({
      workspaceId: typeof row.workspace_id === "string" ? row.workspace_id : null,
      toolName: typeof row.tool_name === "string" ? row.tool_name : null,
      thinkingLevel: typeof row.thinking_level === "string" ? row.thinking_level : null,
      inputTokens:
        row.input_tokens == null ? null : parseInteger(row.input_tokens, "selected input_tokens"),
    });

    const selectedSql =
      "SELECT workspace_id, tool_name, thinking_level, input_tokens FROM events WHERE workspace_id = ?";
    const freshRows = (await queryRows(freshConn, selectedSql, [workspaceId])).map(
      normalizeSelectedRow
    );
    const migratedRows = (await queryRows(migratedConn, selectedSql, [workspaceId])).map(
      normalizeSelectedRow
    );

    expect(freshRows).toEqual([
      {
        workspaceId,
        toolName: "bash",
        thinkingLevel: null,
        inputTokens: 36,
      },
    ]);
    expect(migratedRows).toEqual(freshRows);
  });

  test("emits one assistant row plus one row per tool model usage with inherited context", async () => {
    const sessionDir = await createTempSessionDir();
    const parentTimestamp = 1_700_000_000_000;
    const parentUsage = { inputTokens: 180, outputTokens: 72, totalTokens: 252 };
    const sameModelToolUsage = {
      toolName: "bash",
      toolCallId: "tool-call-1",
      timestamp: parentTimestamp + 25,
      model: "openai:gpt-4",
      usage: { inputTokens: 36, outputTokens: 12, totalTokens: 48 },
      providerMetadata: { openai: { reasoningTokens: 3 } },
    };
    const otherModelToolUsage = {
      toolName: "advisor",
      toolCallId: "tool-call-2",
      model: "anthropic:claude-sonnet-4-20250514",
      usage: {
        inputTokens: 96,
        cachedInputTokens: 10,
        outputTokens: 18,
        totalTokens: 114,
      },
      providerMetadata: { anthropic: {} },
    };

    await writeMetadataJson(sessionDir, {
      projectPath: "/proj",
      projectName: "my-proj",
      name: "workspace-name",
      parentWorkspaceId: "parent-workspace",
    });
    await writeChatJsonl(sessionDir, [
      makeUserLine(),
      makeAssistantLine({
        model: "openai:gpt-4",
        inputTokens: parentUsage.inputTokens,
        outputTokens: parentUsage.outputTokens,
        timestamp: parentTimestamp,
        durationMs: 400,
        ttftMs: 40,
        toolModelUsages: [sameModelToolUsage, otherModelToolUsage],
      }),
    ]);

    const parsed = await parseWorkspaceFromDisk("ws-tool-rows", sessionDir, {});
    expect(parsed).not.toBeNull();
    assert(parsed, "tool row test expected parseWorkspaceFromDisk to parse workspace");
    expect(parsed.events).toHaveLength(3);

    const rows = parsed.events
      .map((event) => event.row as Record<string, unknown>)
      .sort((left, right) => {
        const leftToolName = typeof left.tool_name === "string" ? left.tool_name : "";
        const rightToolName = typeof right.tool_name === "string" ? right.tool_name : "";
        return (
          leftToolName.localeCompare(rightToolName) ||
          Number(left.timestamp) - Number(right.timestamp)
        );
      });

    const expectedAssistantUsage = createDisplayUsage(parentUsage, "openai:gpt-4");
    const expectedSameModelToolUsage = createDisplayUsage(
      sameModelToolUsage.usage,
      sameModelToolUsage.model,
      sameModelToolUsage.providerMetadata
    );
    const expectedOtherModelToolUsage = createDisplayUsage(
      otherModelToolUsage.usage,
      otherModelToolUsage.model,
      otherModelToolUsage.providerMetadata
    );
    expect(expectedAssistantUsage).toBeDefined();
    expect(expectedSameModelToolUsage).toBeDefined();
    expect(expectedOtherModelToolUsage).toBeDefined();
    if (!expectedAssistantUsage || !expectedSameModelToolUsage || !expectedOtherModelToolUsage) {
      throw new Error("Expected tool row ETL test to compute display usage");
    }

    const assistantRow = rows.find((row) => row.tool_name == null);
    const bashRow = rows.find((row) => row.tool_name === "bash");
    const advisorRow = rows.find((row) => row.tool_name === "advisor");
    expect(assistantRow).toBeDefined();
    expect(bashRow).toBeDefined();
    expect(advisorRow).toBeDefined();
    if (!assistantRow || !bashRow || !advisorRow) {
      throw new Error("Expected assistant, bash, and advisor analytics rows");
    }

    for (const row of [assistantRow, bashRow, advisorRow]) {
      expect(row.project_path).toBe("/proj");
      expect(row.project_name).toBe("my-proj");
      expect(row.workspace_name).toBe("workspace-name");
      expect(row.parent_workspace_id).toBe("parent-workspace");
      expect(row.is_sub_agent).toBe(true);
    }

    expect(parseInteger(assistantRow.timestamp, "assistant timestamp")).toBe(parentTimestamp);
    expect(assistantRow.model).toBe("openai:gpt-4");
    expect(parseInteger(assistantRow.input_tokens, "assistant input_tokens")).toBe(
      expectedAssistantUsage.input.tokens
    );
    expect(parseInteger(assistantRow.output_tokens, "assistant output_tokens")).toBe(
      expectedAssistantUsage.output.tokens
    );
    expect(Number(assistantRow.total_cost_usd)).toBeCloseTo(
      (expectedAssistantUsage.input.cost_usd ?? 0) +
        (expectedAssistantUsage.output.cost_usd ?? 0) +
        (expectedAssistantUsage.reasoning.cost_usd ?? 0) +
        (expectedAssistantUsage.cached.cost_usd ?? 0) +
        (expectedAssistantUsage.cacheCreate.cost_usd ?? 0),
      12
    );
    expect(Number(assistantRow.duration_ms)).toBe(400);
    expect(Number(assistantRow.ttft_ms)).toBe(40);
    expect(Number(assistantRow.output_tps)).toBeCloseTo(180, 12);

    expect(parseInteger(bashRow.timestamp, "bash timestamp")).toBe(parentTimestamp + 25);
    expect(bashRow.model).toBe("openai:gpt-4");
    expect(parseInteger(bashRow.input_tokens, "bash input_tokens")).toBe(
      expectedSameModelToolUsage.input.tokens
    );
    expect(parseInteger(bashRow.output_tokens, "bash output_tokens")).toBe(
      expectedSameModelToolUsage.output.tokens
    );
    expect(parseInteger(bashRow.reasoning_tokens, "bash reasoning_tokens")).toBe(
      expectedSameModelToolUsage.reasoning.tokens
    );
    expect(Number(bashRow.total_cost_usd)).toBeCloseTo(
      (expectedSameModelToolUsage.input.cost_usd ?? 0) +
        (expectedSameModelToolUsage.output.cost_usd ?? 0) +
        (expectedSameModelToolUsage.reasoning.cost_usd ?? 0) +
        (expectedSameModelToolUsage.cached.cost_usd ?? 0) +
        (expectedSameModelToolUsage.cacheCreate.cost_usd ?? 0),
      12
    );
    expect(bashRow.duration_ms).toBeNull();
    expect(bashRow.ttft_ms).toBeNull();
    expect(bashRow.output_tps).toBeNull();

    expect(parseInteger(advisorRow.timestamp, "advisor timestamp")).toBe(parentTimestamp);
    expect(advisorRow.model).toBe("anthropic:claude-sonnet-4-20250514");
    expect(parseInteger(advisorRow.input_tokens, "advisor input_tokens")).toBe(
      expectedOtherModelToolUsage.input.tokens
    );
    expect(parseInteger(advisorRow.cached_tokens, "advisor cached_tokens")).toBe(
      expectedOtherModelToolUsage.cached.tokens
    );
    expect(parseInteger(advisorRow.cache_create_tokens, "advisor cache_create_tokens")).toBe(
      expectedOtherModelToolUsage.cacheCreate.tokens
    );
    expect(Number(advisorRow.total_cost_usd)).toBeCloseTo(
      (expectedOtherModelToolUsage.input.cost_usd ?? 0) +
        (expectedOtherModelToolUsage.output.cost_usd ?? 0) +
        (expectedOtherModelToolUsage.reasoning.cost_usd ?? 0) +
        (expectedOtherModelToolUsage.cached.cost_usd ?? 0) +
        (expectedOtherModelToolUsage.cacheCreate.cost_usd ?? 0),
      12
    );
    expect(advisorRow.duration_ms).toBeNull();
    expect(advisorRow.ttft_ms).toBeNull();
    expect(advisorRow.output_tps).toBeNull();
  });

  test("emits tool rows when assistant usage is missing", async () => {
    const sessionDir = await createTempSessionDir();
    const assistantTimestamp = 1_700_000_000_000;
    const bashToolUsage = {
      toolName: "bash",
      toolCallId: "tool-call-1",
      timestamp: assistantTimestamp + 25,
      model: "openai:gpt-4",
      usage: { inputTokens: 36, outputTokens: 12, totalTokens: 48 },
      providerMetadata: { openai: { reasoningTokens: 3 } },
    };
    const advisorToolUsage = {
      toolName: "advisor",
      toolCallId: "tool-call-2",
      model: "anthropic:claude-sonnet-4-20250514",
      usage: {
        inputTokens: 96,
        cachedInputTokens: 10,
        outputTokens: 18,
        totalTokens: 114,
      },
      providerMetadata: { anthropic: { cacheCreationInputTokens: 4 } },
    };

    await writeMetadataJson(sessionDir, {
      projectPath: "/proj",
      projectName: "my-proj",
      name: "workspace-name",
      parentWorkspaceId: "parent-workspace",
    });
    await writeChatJsonl(sessionDir, [
      makeUserLine(),
      JSON.stringify({
        role: "assistant",
        content: "response",
        metadata: {
          model: "openai:gpt-4",
          historySequence: 1,
          timestamp: assistantTimestamp,
          agentId: "exec",
          toolModelUsages: [bashToolUsage, advisorToolUsage],
        },
      }),
    ]);

    const parsed = await parseWorkspaceFromDisk("ws-tool-only-rows", sessionDir, {});
    expect(parsed).not.toBeNull();
    assert(parsed, "tool-only row test expected parseWorkspaceFromDisk to parse workspace");
    expect(parsed.events).toHaveLength(2);

    const rows = parsed.events
      .map((event) => event.row as Record<string, unknown>)
      .sort((left, right) => {
        const leftToolName = typeof left.tool_name === "string" ? left.tool_name : "";
        const rightToolName = typeof right.tool_name === "string" ? right.tool_name : "";
        return (
          leftToolName.localeCompare(rightToolName) ||
          Number(left.timestamp) - Number(right.timestamp)
        );
      });

    expect(rows.filter((row) => row.tool_name == null)).toHaveLength(0);

    const expectedBashToolUsage = createDisplayUsage(
      bashToolUsage.usage,
      bashToolUsage.model,
      bashToolUsage.providerMetadata
    );
    const expectedAdvisorToolUsage = createDisplayUsage(
      advisorToolUsage.usage,
      advisorToolUsage.model,
      advisorToolUsage.providerMetadata
    );
    expect(expectedBashToolUsage).toBeDefined();
    expect(expectedAdvisorToolUsage).toBeDefined();
    if (!expectedBashToolUsage || !expectedAdvisorToolUsage) {
      throw new Error("Expected tool-only ETL test to compute display usage");
    }

    const bashRow = rows.find((row) => row.tool_name === "bash");
    const advisorRow = rows.find((row) => row.tool_name === "advisor");
    expect(bashRow).toBeDefined();
    expect(advisorRow).toBeDefined();
    if (!bashRow || !advisorRow) {
      throw new Error("Expected bash and advisor analytics rows when assistant usage is missing");
    }

    for (const row of [bashRow, advisorRow]) {
      expect(row.workspace_id).toBe("ws-tool-only-rows");
      expect(row.project_path).toBe("/proj");
      expect(row.project_name).toBe("my-proj");
      expect(row.workspace_name).toBe("workspace-name");
      expect(row.parent_workspace_id).toBe("parent-workspace");
      expect(row.agent_id).toBe("exec");
      expect(row.is_sub_agent).toBe(true);
    }

    expect(parseInteger(bashRow.timestamp, "bash timestamp")).toBe(assistantTimestamp + 25);
    expect(bashRow.model).toBe("openai:gpt-4");
    expect(parseInteger(bashRow.input_tokens, "bash input_tokens")).toBe(
      expectedBashToolUsage.input.tokens
    );
    expect(parseInteger(bashRow.output_tokens, "bash output_tokens")).toBe(
      expectedBashToolUsage.output.tokens
    );
    expect(parseInteger(bashRow.reasoning_tokens, "bash reasoning_tokens")).toBe(
      expectedBashToolUsage.reasoning.tokens
    );
    expect(Number(bashRow.total_cost_usd)).toBeCloseTo(
      (expectedBashToolUsage.input.cost_usd ?? 0) +
        (expectedBashToolUsage.output.cost_usd ?? 0) +
        (expectedBashToolUsage.reasoning.cost_usd ?? 0) +
        (expectedBashToolUsage.cached.cost_usd ?? 0) +
        (expectedBashToolUsage.cacheCreate.cost_usd ?? 0),
      12
    );

    expect(parseInteger(advisorRow.timestamp, "advisor timestamp")).toBe(assistantTimestamp);
    expect(advisorRow.model).toBe("anthropic:claude-sonnet-4-20250514");
    expect(parseInteger(advisorRow.input_tokens, "advisor input_tokens")).toBe(
      expectedAdvisorToolUsage.input.tokens
    );
    expect(parseInteger(advisorRow.cached_tokens, "advisor cached_tokens")).toBe(
      expectedAdvisorToolUsage.cached.tokens
    );
    expect(parseInteger(advisorRow.cache_create_tokens, "advisor cache_create_tokens")).toBe(
      expectedAdvisorToolUsage.cacheCreate.tokens
    );
    expect(Number(advisorRow.total_cost_usd)).toBeCloseTo(
      (expectedAdvisorToolUsage.input.cost_usd ?? 0) +
        (expectedAdvisorToolUsage.output.cost_usd ?? 0) +
        (expectedAdvisorToolUsage.reasoning.cost_usd ?? 0) +
        (expectedAdvisorToolUsage.cached.cost_usd ?? 0) +
        (expectedAdvisorToolUsage.cacheCreate.cost_usd ?? 0),
      12
    );
  });

  test("is a no-op when events is empty", async () => {
    const conn = await createTestConn();

    await appendEvents(conn, []);

    expect(await queryEventCount(conn)).toBe(0);
  });
});

describe("ingestWorkspace", () => {
  test("repairs stale tool-only head rows when head signature drift forces a rebuild", async () => {
    const conn = await createTestConn();
    const sessionDir = await createTempSessionDir();
    const workspaceId = "ws-tool-only-head-signature";
    const headTimestamp = 1_700_000_000_000;
    const headToolUsage = {
      toolName: "bash",
      toolCallId: "tool-call-1",
      timestamp: headTimestamp + 25,
      model: "openai:gpt-4",
      usage: { inputTokens: 36, outputTokens: 12, totalTokens: 48 },
      providerMetadata: { openai: { reasoningTokens: 3 } },
    };
    const secondToolUsage = {
      toolName: "advisor",
      toolCallId: "tool-call-2",
      timestamp: headTimestamp + 1_025,
      model: "anthropic:claude-sonnet-4-20250514",
      usage: {
        inputTokens: 96,
        cachedInputTokens: 10,
        outputTokens: 18,
        totalTokens: 114,
      },
      providerMetadata: { anthropic: { cacheCreationInputTokens: 4 } },
    };

    await writeChatJsonl(sessionDir, [
      makeUserLine(),
      JSON.stringify({
        role: "assistant",
        content: "tool-only response",
        metadata: {
          model: "openai:gpt-4",
          historySequence: 1,
          timestamp: headTimestamp,
          toolModelUsages: [headToolUsage],
        },
      }),
      makeUserLine(),
      JSON.stringify({
        role: "assistant",
        content: "second tool-only response",
        metadata: {
          model: "anthropic:claude-sonnet-4-20250514",
          historySequence: 2,
          timestamp: headTimestamp + 1_000,
          toolModelUsages: [secondToolUsage],
        },
      }),
    ]);

    await ingestWorkspace(conn, workspaceId, sessionDir, { projectPath: "/proj" });

    expect(await queryEventCount(conn, workspaceId)).toBe(2);
    const headRows = await queryRows(
      conn,
      "SELECT tool_name, total_cost_usd FROM events WHERE workspace_id = ? AND response_index = 0",
      [workspaceId]
    );
    expect(headRows).toHaveLength(1);
    expect(headRows[0].tool_name).toBe("bash");

    const originalHeadTotalCostUsd = Number(headRows[0].total_cost_usd);
    expect(Number.isFinite(originalHeadTotalCostUsd)).toBe(true);
    const mutatedHeadTotalCostUsd = originalHeadTotalCostUsd + 123;

    await conn.run(
      "UPDATE events SET total_cost_usd = ? WHERE workspace_id = ? AND response_index = 0 AND tool_name = ?",
      [mutatedHeadTotalCostUsd, workspaceId, "bash"]
    );

    await bumpChatMtime(sessionDir);
    await ingestWorkspace(conn, workspaceId, sessionDir, { projectPath: "/proj" });

    expect(await queryEventCount(conn, workspaceId)).toBe(2);
    const refreshedHeadRows = await queryRows(
      conn,
      "SELECT tool_name, total_cost_usd FROM events WHERE workspace_id = ? AND response_index = 0",
      [workspaceId]
    );
    expect(refreshedHeadRows).toHaveLength(1);
    expect(refreshedHeadRows[0].tool_name).toBe("bash");
    expect(Number(refreshedHeadRows[0].total_cost_usd)).toBeCloseTo(originalHeadTotalCostUsd, 12);
  });

  test("ingests sealed pre-boundary rows from chat-archive.jsonl", async () => {
    const conn = await createTestConn();
    const sessionDir = await createTempSessionDir();
    const workspaceId = "ws-with-archive";

    // HistoryService rotation moves pre-boundary rows into chat-archive.jsonl;
    // analytics must read both files or pre-compaction usage disappears.
    await fs.writeFile(
      path.join(sessionDir, "chat-archive.jsonl"),
      [makeUserLine(), makeAssistantLine({ sequence: 1, inputTokens: 11 })].join("\n") + "\n"
    );
    await writeChatJsonl(sessionDir, [
      makeUserLine(),
      makeAssistantLine({ sequence: 3, inputTokens: 33 }),
    ]);

    await ingestWorkspace(conn, workspaceId, sessionDir, { projectPath: "/proj" });

    expect(await queryEventCount(conn, workspaceId)).toBe(2);
    const rows = await queryRows(
      conn,
      "SELECT input_tokens FROM events WHERE workspace_id = ? ORDER BY input_tokens",
      [workspaceId]
    );
    expect(rows.map((row) => Number(row.input_tokens))).toEqual([11, 33]);
  });

  test("reingests when the active file disappears leaving an older archive", async () => {
    const conn = await createTestConn();
    const sessionDir = await createTempSessionDir();
    const workspaceId = "ws-mtime-regression";

    const archivePath = path.join(sessionDir, "chat-archive.jsonl");
    await fs.writeFile(
      archivePath,
      [makeUserLine(), makeAssistantLine({ sequence: 1, inputTokens: 11 })].join("\n") + "\n"
    );
    // Make the archive strictly older than chat.jsonl so the watermark is based
    // on the active file's mtime.
    const olderTime = new Date(Date.now() - 60_000);
    await fs.utimes(archivePath, olderTime, olderTime);
    await writeChatJsonl(sessionDir, [
      makeUserLine(),
      makeAssistantLine({ sequence: 3, inputTokens: 33 }),
    ]);

    await ingestWorkspace(conn, workspaceId, sessionDir, { projectPath: "/proj" });
    expect(await queryEventCount(conn, workspaceId)).toBe(2);

    // Deleting chat.jsonl regresses the combined mtime to the older archive's.
    // Ingestion must still re-run and drop the removed active epoch's rows.
    await fs.rm(path.join(sessionDir, CHAT_FILE_NAME));
    await ingestWorkspace(conn, workspaceId, sessionDir, { projectPath: "/proj" });

    const rows = await queryRows(
      conn,
      "SELECT input_tokens FROM events WHERE workspace_id = ? ORDER BY input_tokens",
      [workspaceId]
    );
    expect(rows.map((row) => Number(row.input_tokens))).toEqual([11]);
  });

  test("reingests when chat.jsonl disappears even if the archive mtime matches the stored max", async () => {
    const conn = await createTestConn();
    const sessionDir = await createTempSessionDir();
    const workspaceId = "ws-same-tick-deletion";

    const archivePath = path.join(sessionDir, "chat-archive.jsonl");
    const chatPath = path.join(sessionDir, CHAT_FILE_NAME);
    await fs.writeFile(
      archivePath,
      [makeUserLine(), makeAssistantLine({ sequence: 1, inputTokens: 11 })].join("\n") + "\n"
    );
    await writeChatJsonl(sessionDir, [
      makeUserLine(),
      makeAssistantLine({ sequence: 3, inputTokens: 33 }),
    ]);
    // Same-tick rotation: both files share an identical mtime, so the max mtime
    // alone cannot detect the active file's later disappearance.
    const sharedTime = new Date(Date.now() - 60_000);
    await fs.utimes(archivePath, sharedTime, sharedTime);
    await fs.utimes(chatPath, sharedTime, sharedTime);

    await ingestWorkspace(conn, workspaceId, sessionDir, { projectPath: "/proj" });
    expect(await queryEventCount(conn, workspaceId)).toBe(2);

    await fs.rm(chatPath);
    await ingestWorkspace(conn, workspaceId, sessionDir, { projectPath: "/proj" });

    const rows = await queryRows(
      conn,
      "SELECT input_tokens FROM events WHERE workspace_id = ? ORDER BY input_tokens",
      [workspaceId]
    );
    expect(rows.map((row) => Number(row.input_tokens))).toEqual([11]);
  });

  test("keeps analytics for archive-only sessions (missing chat.jsonl)", async () => {
    const conn = await createTestConn();
    const sessionDir = await createTempSessionDir();
    const workspaceId = "ws-archive-only";

    // An archive-only session (active file deleted/truncated) still has history;
    // it must be ingested rather than treated as a removed workspace.
    await fs.writeFile(
      path.join(sessionDir, "chat-archive.jsonl"),
      [makeUserLine(), makeAssistantLine({ sequence: 1, inputTokens: 11 })].join("\n") + "\n"
    );

    await ingestWorkspace(conn, workspaceId, sessionDir, { projectPath: "/proj" });

    expect(await queryEventCount(conn, workspaceId)).toBe(1);
  });
});

describe("readPersistedWorkspaceHeadSignature", () => {
  test("prefers the assistant row before tool rows at the same response index", async () => {
    const conn = await createTestConn();
    const sessionDir = await createTempSessionDir();
    const workspaceId = "ws-head-signature-order";
    const toolUsage = {
      toolName: "bash",
      toolCallId: "tool-call-1",
      timestamp: 1_700_000_000_025,
      model: "openai:gpt-4",
      usage: { inputTokens: 36, outputTokens: 12, totalTokens: 48 },
      providerMetadata: { openai: { reasoningTokens: 3 } },
    };

    await writeChatJsonl(sessionDir, [
      makeUserLine(),
      makeAssistantLine({
        model: "openai:gpt-4",
        sequence: 1,
        timestamp: 1_700_000_000_000,
        inputTokens: 180,
        outputTokens: 72,
        toolModelUsages: [toolUsage],
      }),
    ]);

    const parsed = await parseWorkspaceFromDisk(workspaceId, sessionDir, {});
    expect(parsed).not.toBeNull();
    assert(parsed, "head signature order test expected parseWorkspaceFromDisk to parse workspace");
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events.map((event) => event.row.tool_name)).toEqual([null, "bash"]);
    expect(parsed.events.map((event) => event.row.response_index)).toEqual([0, 0]);

    await appendEvents(conn, parsed.events);

    const persistedHeadSignature = await readPersistedWorkspaceHeadSignature(conn, workspaceId);
    expect(persistedHeadSignature).toBe(createHeadSignatureFromRow(parsed.events[0].row));
    expect(persistedHeadSignature).not.toBe(createHeadSignatureFromRow(parsed.events[1].row));
  });
});

describe("parseWorkspaceFromDisk", () => {
  test("reads chat.jsonl and metadata.json", async () => {
    const sessionDir = await createTempSessionDir();
    await writeMetadataJson(sessionDir, {
      projectPath: "/test",
      projectName: "test-proj",
    });
    await writeChatJsonl(sessionDir, [makeUserLine(), makeAssistantLine({ model: "gpt-4" })]);

    const parsed = await parseWorkspaceFromDisk("ws-test", sessionDir, {});

    expect(parsed).not.toBeNull();
    assert(parsed, "parseWorkspaceFromDisk test expected non-null parsed workspace");
    expect(parsed.workspaceId).toBe("ws-test");
    expect(parsed.workspaceMeta.projectPath).toBe("/test");
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].row.model).toBe("gpt-4");
    expect(parsed.stat.mtimeMs).toBeGreaterThan(0);
  });

  test("returns null when chat.jsonl is missing", async () => {
    const sessionDir = await createTempSessionDir();

    const parsed = await parseWorkspaceFromDisk("ws-missing", sessionDir, {});

    expect(parsed).toBeNull();
  });
});

describe("ingestArchivedSubagentTranscripts", () => {
  test("ingests archived sub-agent transcripts from parent session dir", async () => {
    const conn = await createTestConn();
    const parentWorkspaceId = "parent-id";
    const childWorkspaceId = "child-1";

    const parentSessionDir = await createTempSessionDir();
    await writeBasicChatJsonl(parentSessionDir);

    await createArchivedSubagentTranscript(parentSessionDir, childWorkspaceId, {
      parentWorkspaceId,
      projectPath: "/home/user/myproject",
      projectName: "myproject",
      name: "child-workspace",
    });

    await ingestWorkspace(conn, parentWorkspaceId, parentSessionDir, { projectPath: "/test" });

    expect(await queryEventCount(conn)).toBe(2);

    const parentRows = await queryRows(
      conn,
      "SELECT CAST(is_sub_agent AS INTEGER) AS is_sub_agent_int FROM events WHERE workspace_id = ?",
      [parentWorkspaceId]
    );
    expect(parentRows).toHaveLength(1);
    expect(parseBooleanFromInteger(parentRows[0].is_sub_agent_int, "is_sub_agent_int")).toBe(false);

    const childRows = await queryRows(
      conn,
      "SELECT workspace_name, parent_workspace_id, CAST(is_sub_agent AS INTEGER) AS is_sub_agent_int FROM events WHERE workspace_id = ?",
      [childWorkspaceId]
    );
    expect(childRows).toHaveLength(1);
    expect(childRows[0].workspace_name).toBe("child-workspace");
    expect(childRows[0].parent_workspace_id).toBe(parentWorkspaceId);
    expect(parseBooleanFromInteger(childRows[0].is_sub_agent_int, "is_sub_agent_int")).toBe(true);
  });

  test("handles flat rollup — ingests both child and grandchild at parent level", async () => {
    const conn = await createTestConn();
    const parentWorkspaceId = "parent-id";
    const childWorkspaceId = "child-b";
    const grandchildWorkspaceId = "child-c";

    const parentSessionDir = await createTempSessionDir();
    await writeBasicChatJsonl(parentSessionDir);

    await createArchivedSubagentTranscript(parentSessionDir, childWorkspaceId, {
      parentWorkspaceId,
      name: "child-workspace",
    });
    await createArchivedSubagentTranscript(parentSessionDir, grandchildWorkspaceId, {
      parentWorkspaceId: childWorkspaceId,
      name: "grandchild-workspace",
    });

    await ingestWorkspace(conn, parentWorkspaceId, parentSessionDir, { projectPath: "/test" });

    expect(await queryEventCount(conn)).toBe(3);

    const childRows = await queryRows(
      conn,
      "SELECT CAST(is_sub_agent AS INTEGER) AS is_sub_agent_int FROM events WHERE workspace_id = ?",
      [childWorkspaceId]
    );
    expect(childRows).toHaveLength(1);
    expect(parseBooleanFromInteger(childRows[0].is_sub_agent_int, "is_sub_agent_int")).toBe(true);

    const grandchildRows = await queryRows(
      conn,
      "SELECT parent_workspace_id, CAST(is_sub_agent AS INTEGER) AS is_sub_agent_int FROM events WHERE workspace_id = ?",
      [grandchildWorkspaceId]
    );
    expect(grandchildRows).toHaveLength(1);
    expect(grandchildRows[0].parent_workspace_id).toBe(childWorkspaceId);
    expect(parseBooleanFromInteger(grandchildRows[0].is_sub_agent_int, "is_sub_agent_int")).toBe(
      true
    );
  });

  test("watermark prevents double-counting on re-ingestion", async () => {
    const conn = await createTestConn();
    const parentWorkspaceId = "parent-id";
    const childWorkspaceId = "child-id";

    const parentSessionDir = await createTempSessionDir();
    await writeBasicChatJsonl(parentSessionDir);

    await createArchivedSubagentTranscript(parentSessionDir, childWorkspaceId, {
      parentWorkspaceId,
      name: "child-workspace",
    });

    await ingestWorkspace(conn, parentWorkspaceId, parentSessionDir, { projectPath: "/test" });
    const firstChildCount = await queryEventCount(conn, childWorkspaceId);

    await bumpChatMtime(parentSessionDir);
    await ingestWorkspace(conn, parentWorkspaceId, parentSessionDir, { projectPath: "/test" });

    const secondChildCount = await queryEventCount(conn, childWorkspaceId);
    expect(secondChildCount).toBe(firstChildCount);
    expect(await queryEventCount(conn)).toBe(2);
  });

  test("recovers sub-agent data after clearWorkspaceAnalyticsState", async () => {
    const conn = await createTestConn();
    const parentWorkspaceId = "parent-id";
    const childWorkspaceId = "child-id";

    const parentSessionDir = await createTempSessionDir();
    await writeBasicChatJsonl(parentSessionDir);

    await createArchivedSubagentTranscript(parentSessionDir, childWorkspaceId, {
      parentWorkspaceId,
      name: "child-workspace",
    });

    await ingestWorkspace(conn, parentWorkspaceId, parentSessionDir, { projectPath: "/test" });
    expect(await queryEventCount(conn, childWorkspaceId)).toBe(1);

    await clearWorkspaceAnalyticsState(conn, childWorkspaceId);
    expect(await queryEventCount(conn, childWorkspaceId)).toBe(0);

    // Recovery must NOT require the parent's own chat files to change: child
    // deletion archives the transcript without touching the parent's chat, so
    // any subsequent ingest pass of the parent restores the child's rows.
    await ingestWorkspace(conn, parentWorkspaceId, parentSessionDir, { projectPath: "/test" });

    expect(await queryEventCount(conn, childWorkspaceId)).toBe(1);

    const childRows = await queryRows(
      conn,
      "SELECT CAST(is_sub_agent AS INTEGER) AS is_sub_agent_int FROM events WHERE workspace_id = ?",
      [childWorkspaceId]
    );
    expect(childRows).toHaveLength(1);
    expect(parseBooleanFromInteger(childRows[0].is_sub_agent_int, "is_sub_agent_int")).toBe(true);
  });

  test("rebuildAll ingests archived sub-agent transcripts", async () => {
    const conn = await createTestConn();
    const sessionsDir = await createTempSessionDir();
    const parentWorkspaceId = "parent-id";
    const childWorkspaceId = "child-id";

    const parentSessionDir = path.join(sessionsDir, parentWorkspaceId);
    await fs.mkdir(parentSessionDir, { recursive: true });
    await writeBasicChatJsonl(parentSessionDir);

    await createArchivedSubagentTranscript(parentSessionDir, childWorkspaceId, {
      parentWorkspaceId,
      name: "child-workspace",
    });

    const result = await rebuildAll(conn, sessionsDir);

    expect(result).toEqual({ workspacesIngested: 1 });
    expect(await queryEventCount(conn)).toBe(2);
    expect(await queryEventCount(conn, parentWorkspaceId)).toBe(1);
    expect(await queryEventCount(conn, childWorkspaceId)).toBe(1);
  });

  test("no-op when subagent-transcripts directory does not exist", async () => {
    const conn = await createTestConn();
    const parentWorkspaceId = "parent-id";

    const parentSessionDir = await createTempSessionDir();
    await writeBasicChatJsonl(parentSessionDir);

    await ingestWorkspace(conn, parentWorkspaceId, parentSessionDir, { projectPath: "/test" });

    expect(await queryEventCount(conn)).toBe(1);
    expect(await queryEventCount(conn, parentWorkspaceId)).toBe(1);
  });

  test("falls back to parent workspace ID when archived metadata.json is missing", async () => {
    const conn = await createTestConn();
    const parentWorkspaceId = "parent-id";
    const childWorkspaceId = "legacy-child";

    const parentSessionDir = await createTempSessionDir();
    await writeBasicChatJsonl(parentSessionDir);

    await createArchivedSubagentTranscript(parentSessionDir, childWorkspaceId);

    await ingestWorkspace(conn, parentWorkspaceId, parentSessionDir, { projectPath: "/test" });

    expect(await queryEventCount(conn, childWorkspaceId)).toBe(1);

    const childRows = await queryRows(
      conn,
      "SELECT parent_workspace_id, CAST(is_sub_agent AS INTEGER) AS is_sub_agent_int FROM events WHERE workspace_id = ?",
      [childWorkspaceId]
    );
    expect(childRows).toHaveLength(1);
    // Even without metadata.json, the fallback sets parentWorkspaceId and is_sub_agent
    expect(childRows[0].parent_workspace_id).toBe(parentWorkspaceId);
    expect(parseBooleanFromInteger(childRows[0].is_sub_agent_int, "is_sub_agent_int")).toBe(true);
  });
});

describe("ingestDelegationRollups", () => {
  test("should ingest per-category token fields into delegation_rollups", async () => {
    const conn = await createTestConn();
    const parentWorkspaceId = "parent-id";
    const childWorkspaceId = "child-id";

    const parentSessionDir = await createTempSessionDir();
    await writeBasicChatJsonl(parentSessionDir);
    await writeSessionUsageJson(parentSessionDir, {
      byModel: {},
      version: 1,
      rolledUpFrom: {
        [childWorkspaceId]: {
          totalTokens: 1_000,
          contextTokens: 400,
          inputTokens: 150,
          outputTokens: 220,
          reasoningTokens: 80,
          cachedTokens: 90,
          cacheCreateTokens: 30,
          totalCostUsd: 1.5,
          agentType: "delegate",
          model: "openai:gpt-5",
          rolledUpAtMs: 1_700_000_001_000,
        },
      },
    });

    await ingestWorkspace(conn, parentWorkspaceId, parentSessionDir, {
      projectPath: "/test",
      projectName: "test-project",
    });

    const rows = await queryRows(
      conn,
      `SELECT
        input_tokens,
        output_tokens,
        reasoning_tokens,
        cached_tokens,
        cache_create_tokens
       FROM delegation_rollups
       WHERE parent_workspace_id = ? AND child_workspace_id = ?`,
      [parentWorkspaceId, childWorkspaceId]
    );

    expect(rows).toHaveLength(1);
    expect(parseInteger(rows[0].input_tokens, "input_tokens")).toBe(150);
    expect(parseInteger(rows[0].output_tokens, "output_tokens")).toBe(220);
    expect(parseInteger(rows[0].reasoning_tokens, "reasoning_tokens")).toBe(80);
    expect(parseInteger(rows[0].cached_tokens, "cached_tokens")).toBe(90);
    expect(parseInteger(rows[0].cache_create_tokens, "cache_create_tokens")).toBe(30);
  });

  test("should default per-category tokens to 0 for legacy rollup entries", async () => {
    const conn = await createTestConn();
    const parentWorkspaceId = "parent-id";
    const childWorkspaceId = "legacy-child";

    const parentSessionDir = await createTempSessionDir();
    await writeBasicChatJsonl(parentSessionDir);
    await writeSessionUsageJson(parentSessionDir, {
      byModel: {},
      version: 1,
      rolledUpFrom: {
        [childWorkspaceId]: {
          totalTokens: 650,
          contextTokens: 275,
          totalCostUsd: 0.8,
          rolledUpAtMs: 1_700_000_002_000,
        },
      },
    });

    await ingestWorkspace(conn, parentWorkspaceId, parentSessionDir, {
      projectPath: "/test",
      projectName: "test-project",
    });

    const rows = await queryRows(
      conn,
      `SELECT
        input_tokens,
        output_tokens,
        reasoning_tokens,
        cached_tokens,
        cache_create_tokens
       FROM delegation_rollups
       WHERE parent_workspace_id = ? AND child_workspace_id = ?`,
      [parentWorkspaceId, childWorkspaceId]
    );

    expect(rows).toHaveLength(1);
    expect(parseInteger(rows[0].input_tokens, "input_tokens")).toBe(0);
    expect(parseInteger(rows[0].output_tokens, "output_tokens")).toBe(0);
    expect(parseInteger(rows[0].reasoning_tokens, "reasoning_tokens")).toBe(0);
    expect(parseInteger(rows[0].cached_tokens, "cached_tokens")).toBe(0);
    expect(parseInteger(rows[0].cache_create_tokens, "cache_create_tokens")).toBe(0);
  });
});

describe("headless usage ingestion", () => {
  async function writeHeadlessUsageJsonl(sessionDir: string, lines: string[]): Promise<void> {
    await fs.writeFile(path.join(sessionDir, "headless-usage.jsonl"), `${lines.join("\n")}\n`);
  }

  function makeHeadlessLine(
    opts: { source?: string; inputTokens?: number; outputTokens?: number } = {}
  ): string {
    return JSON.stringify({
      timestamp: 1700000000000,
      source: opts.source ?? "workspace_status",
      model: "anthropic:claude-sonnet-4-20250514",
      usage: {
        inputTokens: opts.inputTokens ?? 500,
        outputTokens: opts.outputTokens ?? 20,
      },
    });
  }

  test("ingests sidecar rows tagged headless:* alongside chat rows, idempotently", async () => {
    const conn = await createTestConn();
    const workspaceId = "headless-ws";
    const sessionDir = await createTempSessionDir();
    await writeBasicChatJsonl(sessionDir);
    await writeHeadlessUsageJsonl(sessionDir, [makeHeadlessLine(), makeHeadlessLine()]);

    await ingestWorkspace(conn, workspaceId, sessionDir, { projectPath: "/test" });
    expect(await queryEventCount(conn, workspaceId)).toBe(3); // 1 chat + 2 headless

    const headlessRows = await queryRows(
      conn,
      "SELECT tool_name, input_tokens, total_cost_usd FROM events WHERE workspace_id = ? AND tool_name LIKE 'headless:%'",
      [workspaceId]
    );
    expect(headlessRows).toHaveLength(2);
    expect(headlessRows[0].tool_name).toBe("headless:workspace_status");
    expect(parseInteger(headlessRows[0].input_tokens, "input_tokens")).toBe(500);
    expect(headlessRows[0].total_cost_usd as number).toBeGreaterThan(0);

    // Second pass with unchanged files: delete+reinsert keeps counts stable
    // and does not disturb chat-derived rows.
    await ingestWorkspace(conn, workspaceId, sessionDir, { projectPath: "/test" });
    expect(await queryEventCount(conn, workspaceId)).toBe(3);
  });

  test("clears stale headless rows when the sidecar disappears", async () => {
    const conn = await createTestConn();
    const workspaceId = "headless-ws-removed";
    const sessionDir = await createTempSessionDir();
    await writeBasicChatJsonl(sessionDir);
    await writeHeadlessUsageJsonl(sessionDir, [makeHeadlessLine()]);

    await ingestWorkspace(conn, workspaceId, sessionDir, { projectPath: "/test" });
    expect(await queryEventCount(conn, workspaceId)).toBe(2); // 1 chat + 1 headless

    // Sidecar deleted while chat.jsonl remains: the changed signal re-ingests
    // and must drop the stale headless rows instead of reporting deleted
    // spend forever (the watermark advances to the no-sidecar signal).
    await fs.rm(path.join(sessionDir, "headless-usage.jsonl"));
    await ingestWorkspace(conn, workspaceId, sessionDir, { projectPath: "/test" });
    expect(await queryEventCount(conn, workspaceId)).toBe(1); // chat row only

    const headlessRows = await queryRows(
      conn,
      "SELECT 1 FROM events WHERE workspace_id = ? AND tool_name LIKE 'headless:%'",
      [workspaceId]
    );
    expect(headlessRows).toHaveLength(0);
  });

  test("unix-ms timestamps survive the incremental insert path un-truncated", async () => {
    // Regression: @duckdb/node-api infers integral JS numbers as INT32 for
    // untyped parameters, silently wrapping unix-ms timestamps (e.g.
    // 1700000000000 → -807049216). Truncated persisted timestamps then break
    // the head-signature comparison, forcing a full rebuild on every ingest.
    const conn = await createTestConn();
    const workspaceId = "bind-safe-ws";
    const sessionDir = await createTempSessionDir();
    await writeBasicChatJsonl(sessionDir); // timestamp 1700000000000

    // First-pass ingest inserts via replaceEventsByResponseIndex (conn.run
    // binding), not the rebuild appender.
    await ingestWorkspace(conn, workspaceId, sessionDir, { projectPath: "/test" });

    const rows = await queryRows(
      conn,
      "SELECT CAST(timestamp AS VARCHAR) AS ts FROM events WHERE workspace_id = ?",
      [workspaceId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ts).toBe("1700000000000");
  });

  test("headless rows do not fake chat truncation (incremental path preserved)", async () => {
    const conn = await createTestConn();
    const workspaceId = "headless-ws-truncation";
    const sessionDir = await createTempSessionDir();
    await writeChatJsonl(sessionDir, [
      makeAssistantLine({ sequence: 1 }),
      makeAssistantLine({ sequence: 2 }),
      makeAssistantLine({ sequence: 3 }),
    ]);
    await ingestWorkspace(conn, workspaceId, sessionDir, { projectPath: "/test" });

    // Sidecar rows land (NULL response_index) — total rows now exceed chat rows.
    await writeHeadlessUsageJsonl(sessionDir, [makeHeadlessLine(), makeHeadlessLine()]);
    await ingestWorkspace(conn, workspaceId, sessionDir, { projectPath: "/test" });
    expect(await queryEventCount(conn, workspaceId)).toBe(5);

    // Sentinel on a MIDDLE chat row (not the head, whose cost feeds the
    // head-signature check; sequence < watermark so the incremental path
    // skips it). A (spurious) truncation rebuild deletes + reprices
    // everything: if headless rows leaked into the truncation count,
    // 4 parsed chat rows < 5 persisted rows would force that rebuild and
    // reset the sentinel.
    await conn.run(
      "UPDATE events SET total_cost_usd = 999 WHERE workspace_id = ? AND response_index = 1",
      [workspaceId]
    );

    await writeChatJsonl(sessionDir, [
      makeAssistantLine({ sequence: 1 }),
      makeAssistantLine({ sequence: 2 }),
      makeAssistantLine({ sequence: 3 }),
      makeAssistantLine({ sequence: 4 }),
    ]);
    await ingestWorkspace(conn, workspaceId, sessionDir, { projectPath: "/test" });

    expect(await queryEventCount(conn, workspaceId)).toBe(6); // 4 chat + 2 headless
    const sentinelRows = await queryRows(
      conn,
      "SELECT total_cost_usd FROM events WHERE workspace_id = ? AND response_index = 1",
      [workspaceId]
    );
    expect(sentinelRows).toHaveLength(1);
    expect(sentinelRows[0].total_cost_usd as number).toBe(999);
  });

  test("failed headless ingestion stays retryable (watermark not advanced past it)", async () => {
    const conn = await createTestConn();
    const workspaceId = "headless-ws-retry";
    const sessionDir = await createTempSessionDir();
    await writeBasicChatJsonl(sessionDir);

    // Unreadable sidecar (a directory → EISDIR, non-ENOENT): ingestion must
    // throw BEFORE the watermark advances, or the next pass would see the
    // change signal as current and permanently strand the sidecar spend.
    await fs.mkdir(path.join(sessionDir, "headless-usage.jsonl"));
    let threw = false;
    try {
      await ingestWorkspace(conn, workspaceId, sessionDir, { projectPath: "/test" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Repair the sidecar; the retry must ingest chat + headless rows.
    await fs.rmdir(path.join(sessionDir, "headless-usage.jsonl"));
    await writeHeadlessUsageJsonl(sessionDir, [makeHeadlessLine()]);
    await ingestWorkspace(conn, workspaceId, sessionDir, { projectPath: "/test" });
    expect(await queryEventCount(conn, workspaceId)).toBe(2); // 1 chat + 1 headless
  });

  test("sidecar appends shift the change signal so startup syncCheck detects them", async () => {
    const sessionDir = await createTempSessionDir();
    await writeBasicChatJsonl(sessionDir);

    const before = await statSessionChatHistory(sessionDir);
    expect(before).not.toBeNull();

    // Crash scenario: recordHeadlessUsage appends a sidecar line but the app
    // exits before the fire-and-forget ingest completes. The startup sync
    // compares stored watermark signals against disk, so a sidecar-only write
    // must shift the signal or the spend strands until an unrelated ingest.
    await writeHeadlessUsageJsonl(sessionDir, [makeHeadlessLine()]);
    const after = await statSessionChatHistory(sessionDir);
    expect(after).not.toBeNull();
    expect(after?.changeSignal).not.toBe(before?.changeSignal);
    // mtimeMs stays chat-only (rebuild dedup recency).
    expect(after?.mtimeMs).toBe(before!.mtimeMs);
  });

  test("prices mapped custom models via metadataModel while keeping raw attribution", async () => {
    const conn = await createTestConn();
    const workspaceId = "headless-ws-mapped";
    const sessionDir = await createTempSessionDir();
    await writeBasicChatJsonl(sessionDir);
    await writeHeadlessUsageJsonl(sessionDir, [
      JSON.stringify({
        timestamp: 1700000000000,
        source: "workspace_status",
        model: "mycustom:my-alias",
        metadataModel: "anthropic:claude-sonnet-4-20250514",
        usage: { inputTokens: 500, outputTokens: 20 },
      }),
    ]);

    await ingestWorkspace(conn, workspaceId, sessionDir, { projectPath: "/test" });

    const rows = await queryRows(
      conn,
      "SELECT model, total_cost_usd FROM events WHERE workspace_id = ? AND tool_name LIKE 'headless:%'",
      [workspaceId]
    );
    expect(rows).toHaveLength(1);
    // Attribution keeps the custom ID; pricing resolves via metadataModel
    // (raw "mycustom:my-alias" has no pricing entry and would cost $0).
    expect(rows[0].model).toBe("mycustom:my-alias");
    expect(rows[0].total_cost_usd as number).toBeGreaterThan(0);
  });

  test("restores archived sub-agent headless usage as sub-agent rows", async () => {
    const conn = await createTestConn();
    const parentWorkspaceId = "parent-headless";
    const childWorkspaceId = "child-headless";

    const parentSessionDir = await createTempSessionDir();
    await writeBasicChatJsonl(parentSessionDir);
    const childSessionDir = await createArchivedSubagentTranscript(
      parentSessionDir,
      childWorkspaceId,
      { parentWorkspaceId, projectPath: "/test", projectName: "test" }
    );
    // Workspace removal archives the child's headless sidecar alongside its
    // chat transcript; the ETL must restore that spend after clearWorkspace.
    await writeHeadlessUsageJsonl(childSessionDir, [makeHeadlessLine()]);

    await ingestWorkspace(conn, parentWorkspaceId, parentSessionDir, { projectPath: "/test" });

    const childHeadlessRows = await queryRows(
      conn,
      "SELECT CAST(is_sub_agent AS INTEGER) AS is_sub_agent_int, total_cost_usd FROM events WHERE workspace_id = ? AND tool_name LIKE 'headless:%'",
      [childWorkspaceId]
    );
    expect(childHeadlessRows).toHaveLength(1);
    // Headless rows match the chat-row is_sub_agent derivation.
    expect(parseBooleanFromInteger(childHeadlessRows[0].is_sub_agent_int, "is_sub_agent_int")).toBe(
      true
    );
    expect(childHeadlessRows[0].total_cost_usd as number).toBeGreaterThan(0);
  });

  test("ingests sidecar growth even when chat files are unchanged", async () => {
    const conn = await createTestConn();
    const workspaceId = "headless-ws-growth";
    const sessionDir = await createTempSessionDir();
    await writeBasicChatJsonl(sessionDir);

    await ingestWorkspace(conn, workspaceId, sessionDir, { projectPath: "/test" });
    expect(await queryEventCount(conn, workspaceId)).toBe(1);

    // Headless usage lands without any chat.jsonl change (status generation).
    await writeHeadlessUsageJsonl(sessionDir, [makeHeadlessLine()]);
    await ingestWorkspace(conn, workspaceId, sessionDir, { projectPath: "/test" });
    expect(await queryEventCount(conn, workspaceId)).toBe(2);
  });
});

describe("pricing fingerprint", () => {
  test("round-trips through ingest_meta and starts unset", async () => {
    const conn = await createTestConn();

    expect(await readStoredPricingFingerprint(conn)).toBeNull();

    await storePricingFingerprint(conn);
    expect(await readStoredPricingFingerprint(conn)).toBe(getCurrentPricingFingerprint());

    // Idempotent upsert: storing again keeps a single row with the same value.
    await storePricingFingerprint(conn);
    expect(await readStoredPricingFingerprint(conn)).toBe(getCurrentPricingFingerprint());
  });
});

describe("deleteCorruptAnalyticsRows", () => {
  test("deletes rows with impossible string lengths while keeping healthy rows", async () => {
    const conn = await createTestConn();

    await conn.run("INSERT INTO events (workspace_id, model, total_cost_usd) VALUES (?, ?, ?)", [
      "ws-healthy",
      "anthropic:claude-haiku-4-5",
      1.0,
    ]);
    // Migrated legacy IDs are `${projectBasename}-${workspaceBasename}` with
    // no length limit (up to 2x NAME_MAX + 1 = 511 chars) and must survive.
    const legacyId = `${"p".repeat(255)}-${"w".repeat(255)}`;
    await conn.run("INSERT INTO events (workspace_id, model, total_cost_usd) VALUES (?, ?, ?)", [
      legacyId,
      "anthropic:claude-haiku-4-5",
      2.0,
    ]);
    // Phantom corruption row: varchar columns hold cross-row concatenations.
    await conn.run("INSERT INTO events (workspace_id, model, total_cost_usd) VALUES (?, ?, ?)", [
      "x".repeat(2000),
      "anthropic:claude-haiku-4-5".repeat(100),
      0.05,
    ]);
    await conn.run(
      `INSERT INTO delegation_rollups (parent_workspace_id, child_workspace_id, model)
       VALUES (?, ?, ?)`,
      ["parent-healthy", "child-healthy", "openai:gpt-5.6-sol"]
    );
    await conn.run(
      `INSERT INTO delegation_rollups (parent_workspace_id, child_workspace_id, model)
       VALUES (?, ?, ?)`,
      ["p".repeat(2000), "child-corrupt", "openai:gpt-5.6-sol"]
    );

    expect(await deleteCorruptAnalyticsRows(conn)).toBe(2);

    const eventRows = await queryRows(
      conn,
      "SELECT workspace_id FROM events ORDER BY LENGTH(workspace_id)"
    );
    expect(eventRows).toEqual([{ workspace_id: "ws-healthy" }, { workspace_id: legacyId }]);
    const rollupRows = await queryRows(conn, "SELECT parent_workspace_id FROM delegation_rollups");
    expect(rollupRows).toEqual([{ parent_workspace_id: "parent-healthy" }]);

    // Idempotent: nothing left to delete.
    expect(await deleteCorruptAnalyticsRows(conn)).toBe(0);
  });
});
