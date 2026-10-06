import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { useWorkspaceStoreRaw, workspaceStore } from "@/browser/stores/WorkspaceStore";
import { createTestApiClient } from "@/browser/testUtils";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { AGENT_AI_DEFAULTS_KEY } from "@/common/constants/storage";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import { isCompactionRecoveryError, useCompactAndRetry } from "./useCompactAndRetry";
import type {
  DisplayedMessage,
  DisplayedUserMessage,
  MuxMessage,
  MuxMessageMetadata,
} from "@/common/types/message";
import type { StreamErrorType } from "@/common/types/errors";

const compactRequest: DisplayedUserMessage = {
  type: "user",
  id: "user-1",
  historyId: "user-1",
  content: "/compact",
  historySequence: 1,
  compactionRequest: { parsed: {} },
};

function streamError(errorType: StreamErrorType): DisplayedMessage {
  return {
    type: "stream-error",
    id: "error-1",
    historyId: "error-1",
    error: "Request failed",
    errorType,
    historySequence: 2,
  };
}

describe("isCompactionRecoveryError", () => {
  test("offers compaction recovery when /compact fails with a generic API error", () => {
    expect(isCompactionRecoveryError(streamError("api"), compactRequest)).toBe(true);
  });

  // Daybreak access-program rejections are classified as authentication.
  test("does not offer compaction recovery for errors compaction cannot fix", () => {
    expect(isCompactionRecoveryError(streamError("authentication"), compactRequest)).toBe(false);
    expect(isCompactionRecoveryError(streamError("quota"), compactRequest)).toBe(false);
  });
});

const WORKSPACE_ID = "ws-compact-retry";
const COMPACT_MODEL = KNOWN_MODELS.SONNET.id;

function historyRow(message: MuxMessage): WorkspaceChatMessage {
  return { type: "message", ...message };
}

const userRow: MuxMessage = {
  id: "user-1",
  role: "user",
  parts: [{ type: "text", text: "Refactor the parser" }],
  metadata: { historySequence: 1, timestamp: 1 },
};

// A Token Budget warning: a synthetic, UI-visible user row the backend appends as a notice.
function warningRow(historySequence: number): MuxMessage {
  return {
    id: "budget-warning",
    role: "user",
    parts: [{ type: "text", text: "Token Budget warning" }],
    metadata: {
      historySequence,
      timestamp: historySequence,
      synthetic: true,
      uiVisible: true,
      muxMetadata: {
        type: "context-budget-warning",
        contextTokens: 800,
        maxTokens: 1000,
        budgetTokens: 991,
        handoff: true,
      },
    },
  };
}

function contextExceededRow(historySequence: number): MuxMessage {
  return {
    id: "assistant-error",
    role: "assistant",
    parts: [],
    metadata: {
      historySequence,
      timestamp: historySequence,
      model: COMPACT_MODEL,
      error: "Context window exceeded",
      errorType: "context_exceeded",
    },
  };
}

describe("useCompactAndRetry trigger message", () => {
  const sendMessage = mock((_input: Parameters<APIClient["workspace"]["sendMessage"]>[0]) =>
    Promise.resolve({ success: true as const, data: {} })
  );

  function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
      if (!signal || signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  // eslint-disable-next-line require-yield
  async function* idle(signal: AbortSignal | undefined): AsyncGenerator<never> {
    await waitForAbort(signal);
  }

  function createClient(history: readonly MuxMessage[]): APIClient {
    return createTestApiClient({
      workspace: {
        // A complete onChat replay, so the store holds the rows as persisted edit evidence
        // and the transcript barrier opens.
        onChat: (_input, options) =>
          Promise.resolve(
            (async function* (): AsyncGenerator<WorkspaceChatMessage> {
              for (const message of history) yield historyRow(message);
              yield { type: "caught-up", historyReplayStatus: "complete" };
              await waitForAbort(options?.signal);
            })()
          ),
        getSessionUsage: () => Promise.resolve(undefined),
        activity: {
          list: () => Promise.resolve({}),
          subscribe: (_input, options) => Promise.resolve(idle(options?.signal)),
        },
        sendMessage,
      },
      terminal: {
        activity: { subscribe: (_input, options) => Promise.resolve(idle(options?.signal)) },
      },
      providers: {
        getConfig: () =>
          Promise.resolve({
            anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true },
          }),
        onConfigChanged: (_input, options) => Promise.resolve(idle(options?.signal)),
      },
    });
  }

  beforeEach(() => {
    saveDomGlobals();
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    useWorkspaceStoreRaw().dispose();
    sendMessage.mockClear();
    // A configured compaction model makes a suggestion available, so context_exceeded
    // auto-compacts through executeCompaction.
    updatePersistedState<AgentAiDefaults>(AGENT_AI_DEFAULTS_KEY, {
      compact: { modelString: COMPACT_MODEL },
    });
  });

  afterEach(() => {
    cleanup();
    const store = useWorkspaceStoreRaw();
    store.setClient(null);
    store.dispose();
    restoreDomGlobals();
  });

  // The hidden Continue row is the backend's synthetic resume after a mid-stream warning:
  // not displayed, so only the warning row stands between the error and the user's message.
  const hiddenContinueRow: MuxMessage = {
    id: "hidden-continue",
    role: "user",
    parts: [{ type: "text", text: "Continue" }],
    metadata: {
      historySequence: 4,
      timestamp: 4,
      synthetic: true,
      muxMetadata: { type: "normal", contextBudgetContinuation: true },
    },
  };
  const completedAssistantRow: MuxMessage = {
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "text", text: "Working on it" }],
    metadata: { historySequence: 2, timestamp: 2, model: COMPACT_MODEL },
  };

  test.each([
    {
      name: "warning before the failed reply",
      history: [userRow, warningRow(2), contextExceededRow(3)],
    },
    {
      name: "mid-stream warning with a hidden Continue",
      history: [
        userRow,
        completedAssistantRow,
        warningRow(3),
        hiddenContinueRow,
        contextExceededRow(5),
      ],
    },
  ])(
    "compacts and retries the user's message, not the Token Budget warning ($name)",
    async (scenario) => {
      const client = createClient(scenario.history);
      const store = useWorkspaceStoreRaw();
      store.setClient(client);
      store.setActiveWorkspaceId(WORKSPACE_ID);
      store.addWorkspace({
        id: WORKSPACE_ID,
        name: WORKSPACE_ID,
        title: WORKSPACE_ID,
        projectName: "Project",
        projectPath: "/tmp/project",
        namedWorkspacePath: `/tmp/project/${WORKSPACE_ID}`,
        runtimeConfig: { type: "local" },
        createdAt: "2026-10-06T00:00:00.000Z",
      });
      await waitFor(() =>
        expect(workspaceStore.isWorkspaceTranscriptCaughtUp(WORKSPACE_ID)).toBe(true)
      );

      renderHook(() => useCompactAndRetry({ workspaceId: WORKSPACE_ID }), {
        wrapper: (props: { children: React.ReactNode }) => (
          <APIProvider client={client}>{props.children}</APIProvider>
        ),
      });

      await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
      const options = sendMessage.mock.calls[0]?.[0].options;
      expect(options?.editMessageId).toBe(userRow.id);
      // The RPC schema leaves muxMetadata untyped; executeCompaction builds MuxMessageMetadata.
      const muxMetadata = options?.muxMetadata as MuxMessageMetadata | undefined;
      if (muxMetadata?.type !== "compaction-request")
        throw new Error("expected compaction request");
      expect(muxMetadata.parsed.followUpContent?.text).toBe("Refactor the parser");
    }
  );
});
