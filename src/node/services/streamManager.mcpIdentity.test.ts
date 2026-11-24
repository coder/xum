import { describe, expect, test } from "bun:test";
import type { MCPToolCallDisplay } from "@/common/types/mcp";
import type { TurnExecutionOptions } from "./streamManager";
import { installStreamManagerTestHistory, historyService } from "./streamManager.suite.testHarness";
import {
  createLiveStreamHarness,
  eventsOfType,
  type LiveStream,
  toolCallChunk,
  toolResultChunk,
} from "./streamManager.liveStream.testHarness";
import { ToolCallDisplayRegistry, type ExecutionScope } from "./toolCallDisplayRegistry";

/**
 * Ownership regressions for the host-authored MCP identity snapshot: the
 * stream that assembled a tool set is the only consumer of its snapshots, on
 * both the top-level (tool-result) and nested (emitNestedToolEvent) paths,
 * and persisted snapshots replay to reconnecting renderers.
 */

installStreamManagerTestHistory();

type LiveStreamHarness = ReturnType<typeof createLiveStreamHarness>;

/** Starts `scope`'s stream; the scope object is the ownership identity and its token must match. */
async function startScope(
  harness: LiveStreamHarness,
  scope: ExecutionScope,
  historySequence = 1
): Promise<LiveStream> {
  const live = await harness.start({
    workspaceId: scope.workspaceId,
    messageId: scope.messageId,
    historySequence,
    executionScope: scope,
    providedStreamToken: scope.token as TurnExecutionOptions["providedStreamToken"],
  });
  return {
    push: live.push,
    finish: async () => {
      await live.push({ type: "text-delta", text: "done" });
      await live.finish();
    },
  };
}

function snapshot(name: string): MCPToolCallDisplay {
  return {
    connection: { key: "identity", transport: "stdio" },
    identity: { name, version: "1" },
    source: "response",
  };
}

const PROBE_TOOL = "identity_identity_probe";

describe("StreamManager - MCP identity snapshot ownership", () => {
  const workspaceId = "mcp-identity-workspace";
  const replaced: ExecutionScope = { workspaceId, messageId: "message-a", token: "token-a" };
  const replacement: ExecutionScope = { workspaceId, messageId: "message-b", token: "token-b" };

  test("a top-level completion consumes only its own execution's snapshot, exactly once", async () => {
    const registry = new ToolCallDisplayRegistry();
    const harness = createLiveStreamHarness({ toolCallDisplayRegistry: registry });
    const ends = () => eventsOfType(harness.events, "tool-call-end");

    // The replaced execution still streams while the replacement's wrapper
    // published a snapshot under the same call id.
    const staleStream = await startScope(harness, replaced);
    registry.open(replacement);
    registry.set(replacement, "call-1", snapshot("replacement"));
    await staleStream.push(
      toolCallChunk("call-1", PROBE_TOOL),
      toolResultChunk("call-1", PROBE_TOOL)
    );
    const staleParts = harness.streamManager.getStreamInfo(workspaceId)?.parts ?? [];
    expect(staleParts).toHaveLength(1);
    expect((staleParts[0] as { mcpServer?: unknown }).mcpServer).toBeUndefined();
    expect(ends()).toHaveLength(1);
    expect(ends()[0]?.mcpServer).toBeUndefined();
    expect(registry.take(replacement, "call-1")).toStrictEqual(snapshot("replacement"));
    await staleStream.finish();

    // The owning execution consumes it: persisted with the part, carried by the
    // live event, then gone.
    registry.set(replacement, "call-1", snapshot("replacement"));
    const ownStream = await startScope(harness, replacement, 2);
    await ownStream.push(
      toolCallChunk("call-1", PROBE_TOOL),
      toolResultChunk("call-1", PROBE_TOOL)
    );
    const persisted = await historyService.readPartial(workspaceId);
    const persistedPart = persisted?.parts[0] as Record<string, unknown> | undefined;
    expect(persistedPart?.mcpServer).toStrictEqual(snapshot("replacement"));
    expect(ends()[1]?.mcpServer).toStrictEqual(snapshot("replacement"));
    expect(ends()[1]?.messageId).toBe(replacement.messageId);
    expect(registry.take(replacement, "call-1")).toBeUndefined();
    await ownStream.finish();
  });

  test("a nested completion from a closed or mismatched originating scope cannot consume the replacement's snapshot", async () => {
    const registry = new ToolCallDisplayRegistry();
    const harness = createLiveStreamHarness({ toolCallDisplayRegistry: registry });
    const ends = () => eventsOfType(harness.events, "tool-call-end");

    // Run B replaced run A and owns the workspace stream. A's teardown has not
    // closed its registry scope yet, and A's wrapper published its own snapshot
    // under the same nested call id.
    const stream = await startScope(harness, replacement);
    registry.open(replaced);
    registry.set(replaced, "nested-1", snapshot("replaced"));
    registry.set(replacement, "nested-1", snapshot("replacement"));
    await stream.push(toolCallChunk("code-exec", "code_execution"));
    const startTime = Date.now();
    const nestedStart = {
      type: "tool-call-start" as const,
      callId: "nested-1",
      toolName: "identity_identity_probe",
      args: {},
      parentToolCallId: "code-exec",
      startTime,
    };
    const nestedEnd = {
      ...nestedStart,
      type: "tool-call-end" as const,
      endTime: startTime + 1,
      result: { content: [] },
    };
    harness.streamManager.emitNestedToolEvent(replacement, nestedStart);
    const nestedCalls = () =>
      ((harness.streamManager.getStreamInfo(workspaceId)?.parts[0] as { nestedCalls?: unknown })
        ?.nestedCalls ?? []) as Array<Record<string, unknown>>;
    expect(nestedCalls()).toHaveLength(1);

    // A's late nested consumer must neither brand B's record with A's snapshot
    // nor consume B's; after A closes, a structurally equal lookalike of B's
    // scope fails the identity check too.
    harness.streamManager.emitNestedToolEvent(replaced, nestedEnd);
    expect(registry.take(replaced, "nested-1")).toStrictEqual(snapshot("replaced"));
    registry.close(replaced);
    harness.streamManager.emitNestedToolEvent(replaced, nestedEnd);
    harness.streamManager.emitNestedToolEvent({ ...replacement }, nestedEnd);
    expect(nestedCalls().every((call) => call.mcpServer === undefined)).toBe(true);
    expect(ends()).toHaveLength(3);
    expect(ends().every((event) => event.mcpServer === undefined)).toBe(true);
    expect(registry.take(replacement, "nested-1")).toStrictEqual(snapshot("replacement"));

    // Only the owning scope object consumes it, and only once.
    registry.set(replacement, "nested-1", snapshot("replacement"));
    harness.streamManager.emitNestedToolEvent(replacement, nestedEnd);
    const owned = nestedCalls().find((call) => call.mcpServer !== undefined);
    expect(owned?.toolCallId).toBe("nested-1");
    expect(owned?.mcpServer).toStrictEqual(snapshot("replacement"));
    const ownedEvent = ends().find((event) => event.mcpServer !== undefined);
    expect(ownedEvent?.toolCallId).toBe("nested-1");
    expect(ownedEvent?.parentToolCallId).toBe("code-exec");
    expect(registry.take(replacement, "nested-1")).toBeUndefined();
    await stream.finish();
  });

  test("replay carries persisted snapshots for top-level parts and nested records", async () => {
    const registry = new ToolCallDisplayRegistry();
    const harness = createLiveStreamHarness({ toolCallDisplayRegistry: registry });
    const stream = await startScope(harness, replacement);
    registry.set(replacement, "call-1", snapshot("top"));
    await stream.push(toolCallChunk("call-1", PROBE_TOOL), toolResultChunk("call-1", PROBE_TOOL));
    await stream.push(toolCallChunk("code-exec", "code_execution"));
    const startTime = Date.now();
    const nested = {
      callId: "nested-1",
      toolName: "identity_identity_probe",
      args: {},
      parentToolCallId: "code-exec",
      startTime,
    };
    harness.streamManager.emitNestedToolEvent(replacement, { ...nested, type: "tool-call-start" });
    registry.set(replacement, "nested-1", snapshot("nested"));
    harness.streamManager.emitNestedToolEvent(replacement, {
      ...nested,
      type: "tool-call-end",
      endTime: startTime + 1,
      result: { content: [] },
    });
    await stream.push(toolResultChunk("code-exec", "code_execution"));
    const replayStart = harness.events.length;

    await harness.streamManager.replayStream(workspaceId);

    const ends = eventsOfType(harness.events.slice(replayStart), "tool-call-end");
    expect(ends.every((event) => event.replay === true)).toBe(true);
    expect(ends.find((e) => e.toolCallId === "call-1")?.mcpServer).toStrictEqual(snapshot("top"));
    const nestedEnd = ends.find((e) => e.toolCallId === "nested-1");
    expect(nestedEnd?.parentToolCallId).toBe("code-exec");
    expect(nestedEnd?.mcpServer).toStrictEqual(snapshot("nested"));
    expect(ends.find((e) => e.toolCallId === "code-exec")?.mcpServer).toBeUndefined();
    await stream.finish();
  });
});
