import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { installDom } from "../../../../tests/ui/dom";
import { APIProvider } from "@/browser/contexts/API";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { useWorkspaceStoreRaw, workspaceStore } from "@/browser/stores/WorkspaceStore";
import type { WorkspaceStatsSnapshot } from "@/common/orpc/types";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { TimingPanel } from "./StatsTab";

const WORKSPACE_ID = "workspace-1";

const metadata: FrontendWorkspaceMetadata = {
  id: WORKSPACE_ID,
  name: WORKSPACE_ID,
  title: WORKSPACE_ID,
  projectName: "Project",
  projectPath: "/tmp/project",
  namedWorkspacePath: `/tmp/project/${WORKSPACE_ID}`,
  runtimeConfig: { type: "local" },
  createdAt: "2026-06-28T00:00:00.000Z",
};

const snapshot: WorkspaceStatsSnapshot = {
  workspaceId: WORKSPACE_ID,
  generatedAt: Date.now(),
  session: {
    totalDurationMs: 1000,
    totalToolExecutionMs: 0,
    totalStreamingMs: 900,
    totalTtftMs: 100,
    ttftCount: 1,
    responseCount: 1,
    totalOutputTokens: 10,
    totalReasoningTokens: 0,
    byModel: {},
  },
};

describe("TimingPanel clear", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    useWorkspaceStoreRaw().dispose();
  });

  afterEach(() => {
    cleanup();
    useWorkspaceStoreRaw().dispose();
    useWorkspaceStoreRaw().setClient(null);
    cleanupDom?.();
    cleanupDom = null;
  });

  test("renders an inline error when workspace.stats.clear rejects", async () => {
    // The panel reads the live stats subscription and clears through the injected client,
    // so this drives the same path the Stats tab uses in the app.
    const client = createMockORPCClient({
      workspaceStatsSnapshots: new Map([[WORKSPACE_ID, snapshot]]),
    });
    let rejectClear: ((error: unknown) => void) | null = null;
    client.workspace.stats.clear = () =>
      new Promise((_, reject) => {
        rejectClear = reject;
      });
    useWorkspaceStoreRaw().setClient(client);
    workspaceStore.addWorkspace(metadata);
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const view = render(
        <APIProvider client={client}>
          <TimingPanel workspaceId={WORKSPACE_ID} />
        </APIProvider>
      );

      const clearButton = (await view.findByRole("button", {
        name: "Clear stats",
      })) as HTMLButtonElement;
      fireEvent.click(clearButton);
      await waitFor(() => expect(clearButton.disabled).toBe(true));

      expect(rejectClear).not.toBeNull();
      rejectClear!(new Error("nope"));

      const error = await view.findByTestId("clear-stats-error");
      expect(error.textContent).toContain("Failed to clear stats");
      expect(clearButton.disabled).toBe(false);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
