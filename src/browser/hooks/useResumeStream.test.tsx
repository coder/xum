import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

import { APIProvider, type APIClient } from "@/browser/contexts/API";
import {
  addEphemeralMessage,
  useWorkspaceStoreRaw,
  workspaceStore,
} from "@/browser/stores/WorkspaceStore";
import type { MuxMessage } from "@/common/types/message";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { useResumeStream } from "./useResumeStream";
import { createTestApiClient } from "@/browser/testUtils";

const DEFAULT_WORKSPACE_ID = "ws-1";

type ResumeStreamResult =
  | { success: true; data: { started: boolean } }
  | { success: false; error: { type: "runtime_start_failed"; message: string } };
let resumeStreamResult: ResumeStreamResult = { success: true, data: { started: true } };
const resumeStream = mock((_input: unknown) => Promise.resolve(resumeStreamResult));
const setAutoRetryEnabled = mock((_input: unknown) =>
  Promise.resolve({ success: true as const, data: { previousEnabled: false, enabled: true } })
);

function createApiClient(): APIClient {
  return createTestApiClient({
    workspace: { resumeStream, setAutoRetryEnabled },
  });
}

function createWorkspaceMetadata(workspaceId: string): FrontendWorkspaceMetadata {
  return {
    id: workspaceId,
    name: workspaceId,
    title: workspaceId,
    projectName: "Project",
    projectPath: "/tmp/project",
    namedWorkspacePath: `/tmp/project/${workspaceId}`,
    runtimeConfig: { type: "local" },
    createdAt: "2026-06-28T00:00:00.000Z",
  };
}

function seedWorkspaceWithUserMessage(workspaceId: string): void {
  workspaceStore.addWorkspace(createWorkspaceMetadata(workspaceId));

  const userMessage: MuxMessage = {
    id: `${workspaceId}-user-1`,
    role: "user",
    parts: [{ type: "text", text: "Hi" }],
    metadata: { historySequence: 1 },
  };
  addEphemeralMessage(workspaceId, userMessage);
}

// workspaceId/resetKey come straight from props so tests can rerender with new identity.
const ResumeHarness: React.FC<{ workspaceId?: string; resetKey?: string | null }> = (props) => {
  const { resume, error } = useResumeStream(
    props.workspaceId ?? DEFAULT_WORKSPACE_ID,
    props.resetKey
  );
  return (
    <div>
      <button type="button" onClick={() => void resume()}>
        resume
      </button>
      {error && <div data-testid="resume-error">{error}</div>}
    </div>
  );
};

const Harness: React.FC<{ workspaceId?: string; resetKey?: string | null }> = (props) => (
  <APIProvider client={createApiClient()}>
    <ResumeHarness workspaceId={props.workspaceId} resetKey={props.resetKey} />
  </APIProvider>
);

describe("useResumeStream", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    useWorkspaceStoreRaw().dispose();
    seedWorkspaceWithUserMessage(DEFAULT_WORKSPACE_ID);
    resumeStreamResult = { success: true, data: { started: true } };
    resumeStream.mockClear();
    setAutoRetryEnabled.mockClear();
  });

  afterEach(() => {
    cleanup();
    useWorkspaceStoreRaw().dispose();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("resumes the stream without touching the auto-retry preference", async () => {
    const view = render(<Harness />);

    fireEvent.click(view.getByText("resume"));

    await waitFor(() => {
      expect(resumeStream).toHaveBeenCalledTimes(1);
    });
    // A user-initiated (Esc) interrupt means "continue once": never enable/disable
    // auto-retry, so a transient divider can't cancel a scheduled retry on unmount.
    expect(setAutoRetryEnabled).not.toHaveBeenCalled();
    expect(resumeStream.mock.calls[0]?.[0]).toMatchObject({ workspaceId: DEFAULT_WORKSPACE_ID });
  });

  test("clears the error when workspaceId changes (no cross-workspace bleed)", async () => {
    seedWorkspaceWithUserMessage("ws-A");
    seedWorkspaceWithUserMessage("ws-B");
    resumeStreamResult = {
      success: false,
      error: { type: "runtime_start_failed", message: "Runtime failed to start" },
    };

    const view = render(<Harness workspaceId="ws-A" />);
    fireEvent.click(view.getByText("resume"));

    await waitFor(() => {
      expect(view.getByTestId("resume-error")).toBeTruthy();
    });

    // Same always-mounted hook now serves a different workspace: its error must reset.
    view.rerender(<Harness workspaceId="ws-B" />);

    expect(view.queryByTestId("resume-error")).toBeNull();
  });

  test("clears the error when the resume target (resetKey) changes in the same workspace", async () => {
    resumeStreamResult = {
      success: false,
      error: { type: "runtime_start_failed", message: "Runtime failed to start" },
    };

    const view = render(<Harness workspaceId={DEFAULT_WORKSPACE_ID} resetKey="turn-1" />);
    fireEvent.click(view.getByText("resume"));

    await waitFor(() => {
      expect(view.getByTestId("resume-error")).toBeTruthy();
    });

    // A later interrupted turn in the same workspace must not inherit the old error.
    view.rerender(<Harness workspaceId={DEFAULT_WORKSPACE_ID} resetKey="turn-2" />);

    expect(view.queryByTestId("resume-error")).toBeNull();
  });
});
