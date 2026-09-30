import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { requireTestModule } from "@/browser/testUtils";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { SettingsProvider } from "@/browser/contexts/SettingsContext";
import { cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import * as RealLottieModule from "lottie-react";
import { APIContext } from "@/browser/contexts/API";
import * as RealProvidersConfigModule from "@/browser/hooks/useProvidersConfig";
import * as RealConfiguredProvidersBarModule from "@/browser/components/ConfiguredProvidersBar/ConfiguredProvidersBar";
import * as RealProjectContextModule from "@/browser/contexts/ProjectContext";
import * as RealChatInputModule from "@/browser/features/ChatInput/index";
import type * as ProjectPageModule from "@/browser/components/ProjectPage/ProjectPage";
import type * as WorkspaceContextModule from "@/browser/contexts/WorkspaceContext";

let cleanupDom: (() => void) | null = null;
let focusMock: ReturnType<typeof mock> | null = null;
let readyCalls = 0;

restoreModulesAfterSuite([
  ["lottie-react", { ...RealLottieModule }],
  ["@/browser/hooks/useProvidersConfig", { ...RealProvidersConfigModule }],
  [
    "@/browser/components/ConfiguredProvidersBar/ConfiguredProvidersBar",
    { ...RealConfiguredProvidersBarModule },
  ],
  ["@/browser/contexts/ProjectContext", { ...RealProjectContextModule }],
  ["@/browser/features/ChatInput/index", { ...RealChatInputModule }],
]);

function registerProjectPageMocks() {
  // Re-register mocks before each test because afterEach restores them and this
  // file should not depend on top-level module mock state leaking across tests.

  // Mock lottie-react so tests don't run lottie-web animation internals in happy-dom.
  void mock.module("lottie-react", () => ({
    __esModule: true,
    default: () => <div data-testid="LottieMock" />,
  }));

  // Mock useProvidersConfig to return a configured provider so ChatInput renders
  void mock.module("@/browser/hooks/useProvidersConfig", () => ({
    useProvidersConfig: () => ({
      config: { anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true } },
      loading: false,
      error: null,
    }),
  }));

  // Mock ConfiguredProvidersBar to avoid tooltip/context dependencies
  void mock.module("@/browser/components/ConfiguredProvidersBar/ConfiguredProvidersBar", () => ({
    ConfiguredProvidersBar: () => <div data-testid="ConfiguredProvidersBarMock" />,
  }));

  // Mock ProjectContext to provide the minimal routing/project surface used by the
  // real WorkspaceProvider/AgentProvider stack without wiring the full app shell.
  void mock.module("@/browser/contexts/ProjectContext", () => ({
    useProjectContext: () => ({
      userProjects: new Map(),
      systemProjectPath: null,
      resolveProjectPath: () => null,
      resolveNewChatProjectPath: () => null,
      getProjectConfig: () => undefined,
      loading: false,
      refreshProjects: () => Promise.resolve(),
      addProject: () => undefined,
      removeProject: () => Promise.resolve({ success: true }),
      isProjectCreateModalOpen: false,
      openProjectCreateModal: () => undefined,
      closeProjectCreateModal: () => undefined,
      workspaceModalState: {
        isOpen: false,
        projectPath: null,
        projectName: "",
        branches: [],
        defaultTrunkBranch: undefined,
        loadErrorMessage: null,
        isLoading: false,
      },
      openWorkspaceModal: () => Promise.resolve(),
      closeWorkspaceModal: () => undefined,
      getBranchesForProject: () => Promise.resolve({ branches: [], trunkBranch: null }),
      getSecrets: () => Promise.resolve([]),
      updateSecrets: () => Promise.resolve(),
      updateDisplayName: () => Promise.resolve({ success: true }),
      createSection: () => Promise.resolve({ ok: false, error: "not implemented in test" }),
      updateSection: () => Promise.resolve({ ok: false, error: "not implemented in test" }),
      removeSection: () => Promise.resolve({ ok: false, error: "not implemented in test" }),
      reorderSections: () => Promise.resolve({ ok: false, error: "not implemented in test" }),
      assignWorkspaceToSection: () =>
        Promise.resolve({ ok: false, error: "not implemented in test" }),
      hasAnyProject: false,
    }),
  }));

  // Mock ChatInput to simulate the old (buggy) behavior where onReady can fire again
  // on unrelated re-renders (e.g. workspace list updates).
  void mock.module("@/browser/features/ChatInput/index", () => ({
    ChatInput: (props: {
      onReady?: (api: {
        focus: () => void;
        restoreText: (text: string) => void;
        restoreDraft: (pending: unknown) => void;
        appendText: (text: string) => void;
        prependText: (text: string) => void;
      }) => void;
    }) => {
      useEffect(() => {
        readyCalls += 1;

        props.onReady?.({
          focus: () => {
            if (!focusMock) {
              throw new Error("focusMock not initialized");
            }
            focusMock();
          },
          restoreText: () => undefined,
          restoreDraft: () => undefined,
          appendText: () => undefined,
          prependText: () => undefined,
        });
      }, [props]);

      return <div data-testid="ChatInputMock" />;
    },
  }));
}

// The page renders against a backend that is still connecting. Inject that state through
// the real context instead of mocking the API module (module mocks leak across suites).
function ConnectingAPIWrapper(props: { children: ReactNode }) {
  return (
    <APIContext.Provider
      value={{
        api: null,
        status: "connecting",
        error: null,
        authenticate: () => undefined,
        retry: () => undefined,
      }}
    >
      {props.children}
    </APIContext.Provider>
  );
}

describe("ProjectPage", () => {
  beforeEach(() => {
    cleanupDom = installDom();

    readyCalls = 0;
    focusMock = mock(() => undefined);
    registerProjectPageMocks();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
    focusMock = null;
  });

  test("auto-focuses the creation input only once even if ChatInput re-initializes", async () => {
    const { ProjectPage } = requireTestModule<{
      ProjectPage: typeof ProjectPageModule.ProjectPage;
    }>("@/browser/components/ProjectPage/ProjectPage");
    const { WorkspaceProvider } = requireTestModule<{
      WorkspaceProvider: typeof WorkspaceContextModule.WorkspaceProvider;
    }>("@/browser/contexts/WorkspaceContext");

    const baseProps = {
      projectPath: "/projects/demo",
      projectName: "demo",
      leftSidebarCollapsed: true,
      onToggleLeftSidebarCollapsed: () => undefined,
      onWorkspaceCreated: () => undefined,
    };

    const { rerender } = render(
      <RouterProvider>
        <SettingsProvider>
          <WorkspaceProvider>
            <ProjectPage {...baseProps} />
          </WorkspaceProvider>
        </SettingsProvider>
      </RouterProvider>,
      { wrapper: ConnectingAPIWrapper }
    );

    await waitFor(() => expect(readyCalls).toBe(1));
    await waitFor(() => expect(focusMock).toHaveBeenCalledTimes(1));

    // Simulate an unrelated App re-render that changes an inline callback identity.
    rerender(
      <RouterProvider>
        <SettingsProvider>
          <WorkspaceProvider>
            <ProjectPage {...baseProps} onWorkspaceCreated={() => undefined} />
          </WorkspaceProvider>
        </SettingsProvider>
      </RouterProvider>
    );

    await waitFor(() => expect(readyCalls).toBe(2));

    // Focus should not be re-triggered (would move caret to end).
    expect(focusMock).toHaveBeenCalledTimes(1);
  });
});
