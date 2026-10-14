import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type React from "react";

import { APIProvider, type APIClient } from "@/browser/contexts/API";
import {
  createConnectionHarness,
  GAP_MODES,
  type ConnectionHarness,
} from "@/browser/contexts/connection.testHarness";
import {
  WorkspaceContext,
  type WorkspaceContext as WorkspaceContextValue,
} from "@/browser/contexts/WorkspaceContext";
import { createTestApiClient, createTestConfig, type TestApiOverrides } from "@/browser/testUtils";
import { Ok } from "@/common/types/result";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { installDom } from "../../../tests/ui/dom";
import { useWorkspaceHeartbeat, type HeartbeatFormSettings } from "./useWorkspaceHeartbeat";

const TEST_WORKSPACE_ID = "workspace-1";

type WorkspaceMetadataMap = Map<string, FrontendWorkspaceMetadata>;
type WorkspaceMetadataUpdater = (prev: WorkspaceMetadataMap) => WorkspaceMetadataMap;

let capturedWorkspaceMetadataUpdate: WorkspaceMetadataUpdater | null = null;
const setWorkspaceMetadataMock = mock((update: WorkspaceMetadataUpdater) => {
  capturedWorkspaceMetadataUpdate = update;
});

// Use real providers instead of mock.module(): Bun runs test files in one process, so
// module-level API/context mocks can leak into unrelated hook tests.
function createWrapper(api: TestApiOverrides<APIClient>): React.FC<{ children: React.ReactNode }> {
  return function Wrapper(props) {
    const workspaceContext = {
      workspaceMetadata: new Map<string, FrontendWorkspaceMetadata>(),
      loading: false,
      loaded: true,
      loadError: null,
      setWorkspaceMetadata: setWorkspaceMetadataMock,
    } as unknown as WorkspaceContextValue;

    return (
      <APIProvider client={createTestApiClient(api)}>
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
    const saveHeartbeat = mock(() => Promise.resolve(Ok(undefined)));
    const api: TestApiOverrides<APIClient> = {
      workspace: {
        heartbeat: {
          get: () => Promise.resolve(null),
          set: saveHeartbeat,
        },
      },
      config: {
        getConfig: () => Promise.resolve(createTestConfig()),
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
    const api: TestApiOverrides<APIClient> = {
      workspace: {
        heartbeat: {
          get: () => Promise.resolve(initialSettings),
          set: () => Promise.resolve(Ok(undefined)),
        },
      },
      config: {
        getConfig: () => Promise.resolve(createTestConfig()),
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

// A reconnect reloads the workspace's heartbeat settings through the new client. The dialog keeps
// the shown settings (no "loading" form) until the reload answers; another workspace resets it.
describe.each([...GAP_MODES])("useWorkspaceHeartbeat across a reconnect (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;
  let harness: ConnectionHarness;
  /** The message the next server's heartbeat.get answers, or a promise of it. */
  let serverMessage: string | Promise<string>;

  beforeEach(() => {
    cleanupDom = installDom();
    serverMessage = "old";
    harness = createConnectionHarness(mode, (): TestApiOverrides<APIClient> => {
      const message = Promise.resolve(serverMessage);
      return {
        workspace: {
          heartbeat: {
            get: () =>
              message.then((text) => ({
                enabled: true,
                intervalMs: 120000,
                contextMode: "normal" as const,
                message: text,
              })),
          },
        },
        config: { getConfig: () => Promise.resolve(createTestConfig()) },
      };
    });
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  function Wrapper(props: { children: React.ReactNode }) {
    const workspaceContext = {
      workspaceMetadata: new Map<string, FrontendWorkspaceMetadata>(),
      setWorkspaceMetadata: setWorkspaceMetadataMock,
    } as unknown as WorkspaceContextValue;
    return (
      <harness.Wrapper>
        <WorkspaceContext.Provider value={workspaceContext}>
          {props.children}
        </WorkspaceContext.Provider>
      </harness.Wrapper>
    );
  }

  test("keeps the shown settings until the reload answers", async () => {
    const view = renderHook(
      (props: { workspaceId: string }) => useWorkspaceHeartbeat({ workspaceId: props.workspaceId }),
      { wrapper: Wrapper, initialProps: { workspaceId: TEST_WORKSPACE_ID } }
    );
    await waitFor(() => expect(view.result.current.settings.message).toBe("old"));

    let answer: ((message: string) => void) | null = null;
    serverMessage = new Promise((resolve) => (answer = resolve));
    await harness.drop();
    harness.reconnect();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(view.result.current.isLoading).toBe(false);
    expect(view.result.current.settings.message).toBe("old");
    // A save waits for the new client's read: the old form would overwrite server changes.
    expect(view.result.current.isReloading).toBe(true);

    act(() => answer?.("new"));
    await waitFor(() => expect(view.result.current.settings.message).toBe("new"));
    expect(view.result.current.isReloading).toBe(false);

    // Another workspace shows "loading" (not the first workspace's settings) until it loads.
    serverMessage = new Promise(() => undefined);
    await harness.drop();
    harness.reconnect();
    view.rerender({ workspaceId: "workspace-2" });
    expect(view.result.current.isLoading).toBe(true);
    expect(view.result.current.settings.message).not.toBe("new");
  });

  // Offline a save cannot reach the server (it would fail with the connection-lost error), so
  // the save gate holds during the whole outage. The shown settings stay.
  test("holds the save gate while offline", async () => {
    const view = renderHook(() => useWorkspaceHeartbeat({ workspaceId: TEST_WORKSPACE_ID }), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(view.result.current.settings.message).toBe("old"));
    expect(view.result.current.isReloading).toBe(false);

    await harness.drop();
    expect(view.result.current.isReloading).toBe(true);
    expect(view.result.current.settings.message).toBe("old");

    harness.reconnect();
    await waitFor(() => expect(view.result.current.isReloading).toBe(false));
  });
});
