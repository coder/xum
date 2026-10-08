import { GlobalWindow } from "happy-dom";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import React from "react";
import { ThinkingProvider } from "./ThinkingContext";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { AgentProvider, type AgentContextValue } from "@/browser/contexts/AgentContext";
import { ProviderOptionsProvider } from "@/browser/contexts/ProviderOptionsContext";
import { useThinkingLevel } from "@/browser/hooks/useThinkingLevel";
import type { OpenAIReasoningMode, ThinkingLevel } from "@/common/types/thinking";
import { getProjectScopeId } from "@/common/constants/storage";
import { setAutoRoutingChoice } from "@/browser/utils/modelChange";
import { getAutoRouting } from "@/browser/utils/workspaceAiSettingsSync";
import { useReasoningMode } from "@/browser/hooks/useReasoningMode";
import { useSendMessageOptions } from "@/browser/hooks/useSendMessageOptions";
import { enforceThinkingPolicy, getThinkingPolicyForModel } from "@/common/utils/thinking/policy";
import {
  createTestApiClient,
  createTestPreferencesConfig,
  type TestApiOverrides,
} from "@/browser/testUtils";
import type { UserPreferences } from "@/common/config/schemas/userPreferences";
import { getAppConfigStore, getUserPreferences } from "@/browser/stores/AppConfigStore";
import {
  getPendingAiSelection,
  markAiSelectionIntent,
  resetAiSelectionIntentForTests,
  setWorkspaceAiMetadata,
  type WorkspaceAiMetadata,
} from "@/browser/utils/aiSelectionIntent";

let currentClientMock: TestApiOverrides<APIClient> = {};
const METADATA_WAIT_OPTIONS = { timeout: 5000, interval: 50 };

// Setup basic DOM environment for testing-library
const dom = new GlobalWindow();
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalLocation = globalThis.location;
const originalStorageEvent = globalThis.StorageEvent;
const originalCustomEvent = globalThis.CustomEvent;
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
(global as any).window = dom.window;
(global as any).document = dom.window.document;
(global as any).location = new URL("https://example.com/");

// Ensure globals exist for instanceof checks inside usePersistedState
(globalThis as any).StorageEvent = dom.window.StorageEvent;
(globalThis as any).CustomEvent = dom.window.CustomEvent;

(global as any).console = console;
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */

// Unit shards run many files in one Bun process: a leaked about:blank window makes
// json-schema-ref-parser (PTC type generation) in later files parse paths as browser URLs.
afterAll(() => {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
  globalThis.location = originalLocation;
  globalThis.StorageEvent = originalStorageEvent;
  globalThis.CustomEvent = originalCustomEvent;
});

interface TestProps {
  workspaceId: string;
}

const TestComponent: React.FC<TestProps> = (props) => {
  const [thinkingLevel] = useThinkingLevel();
  return (
    <div data-testid="thinking">
      {thinkingLevel}:{props.workspaceId}
    </div>
  );
};

const agentContextValue: AgentContextValue = {
  agentId: "exec",
  setAgentId: () => undefined,
  currentAgent: undefined,
  agents: [],
  loaded: true,
  loadFailed: false,
  refresh: () => Promise.resolve(),
  refreshing: false,
};

const ThinkingSetterComponent: React.FC = () => {
  const [, setThinkingLevel] = useThinkingLevel();
  return (
    <button data-testid="set-thinking-medium" onClick={() => setThinkingLevel("medium")}>
      Set thinking
    </button>
  );
};

const SendOptionsComponent: React.FC<{ workspaceId: string }> = (props) => {
  const options = useSendMessageOptions(props.workspaceId);
  return <div data-testid="base-model">{options.baseModel}</div>;
};

const ReasoningModeComponent: React.FC = () => {
  const [reasoningMode] = useReasoningMode();
  return <div data-testid="reasoning-mode">{reasoningMode}</div>;
};

function renderWithAPI(children: React.ReactNode, preferences?: UserPreferences) {
  return render(
    <APIProvider
      client={createTestApiClient({
        config: createTestPreferencesConfig(preferences),
        ...currentClientMock,
      })}
    >
      {children}
    </APIProvider>
  );
}

function seedWorkspace(workspaceId: string, aiSettings?: WorkspaceAiMetadata["aiSettings"]) {
  setWorkspaceAiMetadata(workspaceId, { projectPath: "/tmp/project", aiSettings });
}

describe("ThinkingContext", () => {
  // Make getDefaultModel deterministic.
  beforeEach(() => {
    currentClientMock = {};
    window.localStorage.clear();
    getAppConfigStore().updateOptimistically({ defaultModel: "openai:default" });
  });

  afterEach(() => {
    cleanup();
    getAppConfigStore().updateOptimistically({
      userPreferences: undefined,
      defaultModel: undefined,
    });
    resetAiSelectionIntentForTests();
    currentClientMock = {};
  });

  test("uses metadata model before global default but keeps an unsent pick", async () => {
    const cases = [
      { workspaceId: "ws-model-metadata", pick: null, expected: "openai:gpt-5.5" },
      {
        workspaceId: "ws-model-explicit",
        pick: "anthropic:explicit-model",
        expected: "anthropic:explicit-model",
      },
    ];

    for (const testCase of cases) {
      seedWorkspace(testCase.workspaceId, { model: "openai:gpt-5.5", thinkingLevel: "high" });
      if (testCase.pick != null) {
        markAiSelectionIntent(testCase.workspaceId, "model", testCase.pick);
      }

      const view = renderWithAPI(
        <ProviderOptionsProvider>
          <AgentProvider value={agentContextValue}>
            <ThinkingProvider workspaceId={testCase.workspaceId}>
              <SendOptionsComponent workspaceId={testCase.workspaceId} />
            </ThinkingProvider>
          </AgentProvider>
        </ProviderOptionsProvider>
      );

      await waitFor(() => {
        expect(view.getByTestId("base-model").textContent).toBe(testCase.expected);
      }, METADATA_WAIT_OPTIONS);
      cleanup();
    }
  });

  test("setting thinking keeps the pick in memory without a backend write", async () => {
    const workspaceId = "ws-set-thinking-metadata-model";
    const updateAgentAISettings = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    currentClientMock = { workspace: { updateAgentAISettings } };
    seedWorkspace(workspaceId, { model: "metadataModel:abc", thinkingLevel: "high" });

    const view = renderWithAPI(
      <ThinkingProvider workspaceId={workspaceId}>
        <ThinkingSetterComponent />
        <TestComponent workspaceId={workspaceId} />
      </ThinkingProvider>
    );

    const button = await view.findByTestId("set-thinking-medium", undefined, METADATA_WAIT_OPTIONS);
    act(() => {
      button.click();
    });

    await waitFor(() => {
      expect(view.getByTestId("thinking").textContent).toBe(`medium:${workspaceId}`);
    }, METADATA_WAIT_OPTIONS);
    expect(getPendingAiSelection(workspaceId, "exec", "thinkingLevel")).toBe("medium");
    expect(updateAgentAISettings).not.toHaveBeenCalled();
  });

  test("self-heals a corrupt saved reasoningMode to standard but keeps valid pro", async () => {
    // Corrupt saved values (e.g. from a future downgrade) must coerce to
    // "standard" instead of flowing into SendMessageOptionsSchema and bricking sends.
    const cases = [
      { workspaceId: "ws-reasoning-corrupt", saved: "ultra", expected: "standard" },
      { workspaceId: "ws-reasoning-valid", saved: "pro", expected: "pro" },
    ];

    for (const testCase of cases) {
      seedWorkspace(testCase.workspaceId, {
        model: "openai:gpt-5.5",
        thinkingLevel: "high",
        reasoningMode: testCase.saved as OpenAIReasoningMode,
      });

      const view = renderWithAPI(
        <ProviderOptionsProvider>
          <AgentProvider value={agentContextValue}>
            <ThinkingProvider workspaceId={testCase.workspaceId}>
              <ReasoningModeComponent />
            </ThinkingProvider>
          </AgentProvider>
        </ProviderOptionsProvider>
      );

      await waitFor(() => {
        expect(view.getByTestId("reasoning-mode").textContent).toBe(testCase.expected);
      }, METADATA_WAIT_OPTIONS);
      cleanup();
    }
  });

  test("switching models does not remount children", async () => {
    const workspaceId = "ws-1";
    seedWorkspace(workspaceId, { model: "openai:gpt-5.2", thinkingLevel: "high" });

    let unmounts = 0;

    const Child: React.FC = () => {
      React.useEffect(() => {
        return () => {
          unmounts += 1;
        };
      }, []);

      const [thinkingLevel] = useThinkingLevel();
      return <div data-testid="child">{thinkingLevel}</div>;
    };

    const view = renderWithAPI(
      <ThinkingProvider workspaceId={workspaceId}>
        <Child />
      </ThinkingProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("child").textContent).toBe("high");
    });

    act(() => {
      markAiSelectionIntent(workspaceId, "model", "anthropic:claude-3.5");
    });

    // Thinking is workspace-scoped (not per-model), so switching models should not change it.
    await waitFor(() => {
      expect(view.getByTestId("child").textContent).toBe("high");
    });

    expect(unmounts).toBe(0);
  });

  test("cycles thinking with metadata model before global default", async () => {
    const workspaceId = "ws-cycle-thinking-metadata-model";
    const metadataModel = "openai:gpt-5.5-pro";
    const allowed = getThinkingPolicyForModel(metadataModel);
    const currentThinkingLevel = "off";
    const effectiveThinkingLevel = enforceThinkingPolicy(metadataModel, currentThinkingLevel);
    const expectedThinkingLevel =
      allowed[(allowed.indexOf(effectiveThinkingLevel) + 1) % allowed.length];
    seedWorkspace(workspaceId, { model: metadataModel, thinkingLevel: currentThinkingLevel });

    const view = renderWithAPI(
      <ThinkingProvider workspaceId={workspaceId}>
        <TestComponent workspaceId={workspaceId} />
      </ThinkingProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("thinking").textContent).toBe(
        `${currentThinkingLevel}:${workspaceId}`
      );
    }, METADATA_WAIT_OPTIONS);

    act(() => {
      window.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "T", ctrlKey: true, shiftKey: true })
      );
    });

    await waitFor(() => {
      expect(view.getByTestId("thinking").textContent).toBe(
        `${expectedThinkingLevel}:${workspaceId}`
      );
    }, METADATA_WAIT_OPTIONS);
  });

  test("requests a mid-turn override for the active workspace turn on slider changes", async () => {
    const workspaceId = "ws-set-thinking-mid-turn";
    const setActiveTurnThinkingLevel = mock<
      (args: {
        workspaceId: string;
        thinkingLevel: ThinkingLevel;
      }) => Promise<{ success: true; data: { accepted: boolean } }>
    >(() => Promise.resolve({ success: true as const, data: { accepted: true } }));
    currentClientMock = { workspace: { setActiveTurnThinkingLevel } };
    seedWorkspace(workspaceId);

    const view = renderWithAPI(
      <ThinkingProvider workspaceId={workspaceId}>
        <ThinkingSetterComponent />
      </ThinkingProvider>
    );

    const button = await view.findByTestId("set-thinking-medium", undefined, METADATA_WAIT_OPTIONS);
    act(() => {
      button.click();
    });

    await waitFor(() => {
      expect(setActiveTurnThinkingLevel).toHaveBeenCalledWith({
        workspaceId,
        thinkingLevel: "medium",
      });
    }, METADATA_WAIT_OPTIONS);
  });

  test("does not request a mid-turn override in project scope (no workspaceId)", async () => {
    const projectPath = "/Users/dev/mid-turn-scope";
    const setActiveTurnThinkingLevel = mock(() =>
      Promise.resolve({ success: true as const, data: { accepted: false } })
    );
    currentClientMock = {
      workspace: { setActiveTurnThinkingLevel },
    };

    const view = renderWithAPI(
      <ThinkingProvider projectPath={projectPath}>
        <ThinkingSetterComponent />
      </ThinkingProvider>
    );

    const button = await view.findByTestId("set-thinking-medium", undefined, METADATA_WAIT_OPTIONS);
    act(() => {
      button.click();
    });

    // Project/global scopes have no active turn to override; the route must
    // not fire (persisted settings alone drive the next turn).
    await waitFor(() => {
      expect(getUserPreferences().ai?.projectDefaults?.[projectPath]?.thinkingLevel).toBe("medium");
    }, METADATA_WAIT_OPTIONS);
    expect(setActiveTurnThinkingLevel).not.toHaveBeenCalled();
  });

  test("cycles thinking level via keybind in project-scoped (creation) flow", async () => {
    const projectPath = "/Users/dev/my-project";

    const ProjectChild: React.FC = () => {
      const [thinkingLevel] = useThinkingLevel();
      return <div data-testid="thinking-project">{thinkingLevel}</div>;
    };

    // Force a model with a multi-level thinking policy.
    const view = renderWithAPI(
      <ThinkingProvider projectPath={projectPath}>
        <ProjectChild />
      </ThinkingProvider>,
      { ai: { projectDefaults: { [projectPath]: { model: "openai:gpt-4.1" } } } }
    );

    await waitFor(() => {
      expect(view.getByTestId("thinking-project").textContent).toBe("off");
    });

    act(() => {
      window.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "T", ctrlKey: true, shiftKey: true })
      );
    });

    // gpt-4.1 is not an explicitly-recognized reasoning model, so it keeps the legacy
    // off-default floor and cycles off → low.
    await waitFor(() => {
      expect(view.getByTestId("thinking-project").textContent).toBe("low");
    });
  });

  test("a concrete pick via setter or keybind leaves Auto thinking routing", async () => {
    const projectPath = "/Users/dev/auto-thinking";
    const scopeId = getProjectScopeId(projectPath);
    setAutoRoutingChoice(scopeId, "thinkingLevel", true);

    const view = renderWithAPI(
      <ThinkingProvider projectPath={projectPath}>
        <ThinkingSetterComponent />
      </ThinkingProvider>,
      { ai: { projectDefaults: { [projectPath]: { model: "openai:gpt-4.1" } } } }
    );

    const button = await view.findByTestId("set-thinking-medium", undefined, METADATA_WAIT_OPTIONS);
    act(() => {
      button.click();
    });
    await waitFor(() => {
      expect(getAutoRouting(scopeId, "thinkingLevel")).toBe(false);
    }, METADATA_WAIT_OPTIONS);

    setAutoRoutingChoice(scopeId, "thinkingLevel", true);
    act(() => {
      window.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "T", ctrlKey: true, shiftKey: true })
      );
    });
    await waitFor(() => {
      expect(getAutoRouting(scopeId, "thinkingLevel")).toBe(false);
    }, METADATA_WAIT_OPTIONS);
  });
});
