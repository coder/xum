import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type React from "react";

import { APIProvider, type APIClient } from "@/browser/contexts/API";
import {
  WorkspaceContext,
  type WorkspaceContext as WorkspaceContextValue,
} from "@/browser/contexts/WorkspaceContext";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { installDom } from "../../../tests/ui/dom";
import { useWorkspaceHeartbeat, type HeartbeatFormSettings } from "./useWorkspaceHeartbeat";

interface HeartbeatApi {
  workspace: {
    heartbeat: {
      get: (input: { workspaceId: string }) => Promise<HeartbeatFormSettings | null>;
      set: (input: { workspaceId: string } & HeartbeatFormSettings) => Promise<{
        success: boolean;
        error?: string;
      }>;
    };
  };
  config: {
    getConfig: () => Promise<{
      heartbeatDefaultIntervalMs?: number;
      heartbeatDefaultPrompt?: string;
    }>;
  };
}

const TEST_WORKSPACE_ID = "workspace-1";

type WorkspaceMetadataMap = Map<string, FrontendWorkspaceMetadata>;
type WorkspaceMetadataUpdater = (prev: WorkspaceMetadataMap) => WorkspaceMetadataMap;

let capturedWorkspaceMetadataUpdate: WorkspaceMetadataUpdater | null = null;
const setWorkspaceMetadataMock = mock((update: WorkspaceMetadataUpdater) => {
  capturedWorkspaceMetadataUpdate = update;
});

// Use real providers instead of mock.module(): Bun runs test files in one process, so
// module-level API/context mocks can leak into unrelated hook tests.
function createWrapper(api: HeartbeatApi): React.FC<{ children: React.ReactNode }> {
  return function Wrapper(props) {
    const workspaceContext = {
      workspaceMetadata: new Map<string, FrontendWorkspaceMetadata>(),
      loading: false,
      loaded: true,
      loadError: null,
      setWorkspaceMetadata: setWorkspaceMetadataMock,
    } as unknown as WorkspaceContextValue;

    return (
      // eslint-disable-next-line local/no-unknown-cast-to-api-client -- #4627 (needs full config fixture)
      <APIProvider client={api as unknown as APIClient}>
        <WorkspaceContext.Provider value={workspaceContext}>
          {props.children}
        </WorkspaceContext.Provider>
      </APIProvider>
    );
  };
}

function createMetadata(
  overrides: Partial<FrontendWorkspaceMetadata> = {}
): FrontendWorkspaceMetadata {
  return {
    id: TEST_WORKSPACE_ID,
    name: "workspace-1",
    title: "Workspace 1",
    projectName: "Project",
    projectPath: "/tmp/project",
    namedWorkspacePath: "/tmp/project/workspace-1",
    runtimeConfig: { type: "local" },
    createdAt: "2026-04-09T00:00:00.000Z",
    ...overrides,
  };
}

function applyCapturedMetadataUpdate(
  metadata: FrontendWorkspaceMetadata
): FrontendWorkspaceMetadata {
  const update = capturedWorkspaceMetadataUpdate;
  if (!update) {
    throw new Error("Expected workspace metadata update to be captured");
  }

  const nextMap = update(new Map([[metadata.id, metadata]]));
  const nextMetadata = nextMap.get(metadata.id);
  if (!nextMetadata) {
    throw new Error("Expected updated workspace metadata to exist");
  }

  return nextMetadata;
}

describe("useWorkspaceHeartbeat", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    capturedWorkspaceMetadataUpdate = null;
    setWorkspaceMetadataMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    capturedWorkspaceMetadataUpdate = null;
    cleanupDom?.();
    cleanupDom = null;
  });

  test("optimistically enables heartbeat metadata after a successful save", async () => {
    const saveHeartbeat = mock(() => Promise.resolve({ success: true }));
    const api: HeartbeatApi = {
      workspace: {
        heartbeat: {
          get: () => Promise.resolve(null),
          set: saveHeartbeat,
        },
      },
      config: {
        getConfig: () => Promise.resolve({}),
      },
    };

    const { result } = renderHook(() => useWorkspaceHeartbeat({ workspaceId: TEST_WORKSPACE_ID }), {
      wrapper: createWrapper(api),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const nextSettings: HeartbeatFormSettings = {
      enabled: true,
      intervalMs: 120000,
      contextMode: "normal",
      message: "Status update",
    };

    let saveSucceeded = false;
    await act(async () => {
      saveSucceeded = await result.current.save(nextSettings);
    });

    expect(saveSucceeded).toBe(true);
    expect(saveHeartbeat).toHaveBeenCalledWith({
      workspaceId: TEST_WORKSPACE_ID,
      ...nextSettings,
    });
    expect(setWorkspaceMetadataMock).toHaveBeenCalledTimes(1);

    const updatedMetadata = applyCapturedMetadataUpdate(
      createMetadata({
        heartbeat: {
          enabled: false,
          intervalMs: 60000,
          contextMode: "normal",
        },
      })
    );

    expect(updatedMetadata.heartbeat).toEqual(nextSettings);
  });

  test("optimistically disables heartbeat metadata after a successful save", async () => {
    const initialSettings: HeartbeatFormSettings = {
      enabled: true,
      intervalMs: 120000,
      contextMode: "compact",
      message: "Keep watching",
    };
    const api: HeartbeatApi = {
      workspace: {
        heartbeat: {
          get: () => Promise.resolve(initialSettings),
          set: () => Promise.resolve({ success: true }),
        },
      },
      config: {
        getConfig: () => Promise.resolve({}),
      },
    };

    const { result } = renderHook(() => useWorkspaceHeartbeat({ workspaceId: TEST_WORKSPACE_ID }), {
      wrapper: createWrapper(api),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const nextSettings: HeartbeatFormSettings = {
      enabled: false,
      intervalMs: initialSettings.intervalMs,
      contextMode: initialSettings.contextMode,
      message: initialSettings.message,
    };

    let saveSucceeded = false;
    await act(async () => {
      saveSucceeded = await result.current.save(nextSettings);
    });

    expect(saveSucceeded).toBe(true);
    expect(setWorkspaceMetadataMock).toHaveBeenCalledTimes(1);

    const updatedMetadata = applyCapturedMetadataUpdate(
      createMetadata({
        heartbeat: initialSettings,
      })
    );

    expect(updatedMetadata.heartbeat?.enabled).toBe(false);
    expect(updatedMetadata.heartbeat?.intervalMs).toBe(initialSettings.intervalMs);
    expect(updatedMetadata.heartbeat?.contextMode).toBe(initialSettings.contextMode);
    expect(updatedMetadata.heartbeat?.message).toBe(initialSettings.message);
  });
});
