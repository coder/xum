import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import { AgentProvider } from "@/browser/contexts/AgentContext";
import { consumeWorkspaceModelChange } from "@/browser/utils/modelChange";
import { setTestAgentAiDefaults } from "@/browser/testUtils";

import { WorkspaceModeAISync } from "../WorkspaceModeAISync/WorkspaceModeAISync";

let workspaceCounter = 0;

let cleanupDom: (() => void) | null = null;

function nextWorkspaceId(): string {
  workspaceCounter += 1;
  return `workspace-mode-ai-sync-test-${workspaceCounter}`;
}

const noop = () => {
  // intentional noop for tests
};

function SyncHarness(props: { workspaceId: string; agentId: string }) {
  return (
    <AgentProvider
      value={{
        agentId: props.agentId,
        setAgentId: noop,
        currentAgent: undefined,
        agents: [],
        loaded: true,
        loadFailed: false,
        refresh: () => Promise.resolve(),
        refreshing: false,
      }}
    >
      <WorkspaceModeAISync workspaceId={props.workspaceId} />
    </AgentProvider>
  );
}

function renderSync(props: { workspaceId: string; agentId: string }) {
  return render(<SyncHarness workspaceId={props.workspaceId} agentId={props.agentId} />);
}

describe("WorkspaceModeAISync", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    setTestAgentAiDefaults(undefined);
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("only records explicit model changes when agentId changes", async () => {
    const workspaceId = nextWorkspaceId();

    const execModel = "openai:gpt-4o-mini";
    const planModel = "anthropic:claude-3-5-sonnet-latest";

    setTestAgentAiDefaults({
      exec: { modelString: execModel },
      plan: { modelString: planModel },
    });

    const { rerender } = renderSync({ workspaceId, agentId: "exec" });
    // Mount sync is not a switch, so it records no explicit change entry.
    expect(consumeWorkspaceModelChange(workspaceId, execModel)).toBeNull();

    // Switching agents (within the same workspace) should be treated as explicit.
    rerender(<SyncHarness workspaceId={workspaceId} agentId="plan" />);

    await waitFor(() => {
      expect(consumeWorkspaceModelChange(workspaceId, planModel)).toBe("agent");
    });
  });
});
