import "../../../../tests/ui/dom";

import type { ComponentProps, PropsWithChildren, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import * as RealDialogModule from "@/browser/components/Dialog/Dialog";
import * as RealExperimentsHookModule from "@/browser/hooks/useExperiments";
import * as APIModule from "@/browser/contexts/API";
import * as AgentContextModule from "@/browser/contexts/AgentContext";
import * as WorkspaceContextModule from "@/browser/contexts/WorkspaceContext";
import * as ProjectContextModule from "@/browser/contexts/ProjectContext";
import * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import * as RuntimeStatusStoreModule from "@/browser/stores/RuntimeStatusStore";
import * as OpenTerminalModule from "@/browser/hooks/useOpenTerminal";
import * as OpenInEditorModule from "@/browser/hooks/useOpenInEditor";
import * as PersistedStateModule from "@/browser/hooks/usePersistedState";
import * as PopoverErrorHookModule from "@/browser/hooks/usePopoverError";
import * as DesktopTitlebarModule from "@/browser/hooks/useDesktopTitlebar";
import * as TutorialContextModule from "@/browser/contexts/TutorialContext";
import * as ChatCommandsModule from "@/browser/utils/chatCommands";
import type { WorkspaceMenuBar as WorkspaceMenuBarComponent } from "./WorkspaceMenuBar";
import * as WorkspaceMCPModalModule from "../WorkspaceMCPModal/WorkspaceMCPModal";
import * as WorkspaceUnrelatedMessagingModalModule from "../WorkspaceUnrelatedMessagingModal";
import * as TooltipModule from "../Tooltip/Tooltip";
import * as PopoverModule from "../Popover/Popover";
import * as CheckboxModule from "../Checkbox/Checkbox";
import * as DebugLlmRequestModalModule from "../DebugLlmRequestModal/DebugLlmRequestModal";
import * as ConfirmationModalModule from "../ConfirmationModal/ConfirmationModal";
import * as PopoverErrorModule from "../PopoverError/PopoverError";
import * as WorkspaceActionsMenuContentModule from "../WorkspaceActionsMenuContent/WorkspaceActionsMenuContent";
import * as WorkspaceTerminalIconModule from "../icons/WorkspaceTerminalIcon/WorkspaceTerminalIcon";
import * as SkillIndicatorModule from "../SkillIndicator/SkillIndicator";
import * as TimelineDialogModule from "@/browser/features/RightSidebar/Timeline/TimelineDialog";

import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type * as ExperimentsModuleType from "@/browser/hooks/useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { CODER_RUNTIME_PLACEHOLDER, type RuntimeConfig } from "@/common/types/runtime";
import { Err, Ok, type Result } from "@/common/types/result";
import {
  NARROW_VIEWPORT_MAX_WIDTH_PX,
  WORKSPACE_MENU_BAR_LEFT_SIDEBAR_COLLAPSED_PADDING_PX,
} from "@/constants/layout";

// The consent dialog integration test renders the REAL modal inside the menu bar. Radix
// Dialog portals do not render in happy-dom, so the shell is inlined (same double as the
// modal's own test) and restored after this suite so it cannot leak into later files.
// useExperiments re-exports useExperimentValue from ExperimentsContext, so the timeline-gate
// stub below also patches that live binding; restore it so later ExperimentsContext consumers
// (e.g. GeneralSection) do not keep reading the stub.
restoreModulesAfterSuite([
  ["@/browser/components/Dialog/Dialog", { ...RealDialogModule }],
  ["@/browser/hooks/useExperiments", { ...RealExperimentsHookModule }],
]);
void mock.module("@/browser/components/Dialog/Dialog", () => ({
  Dialog: (props: { open: boolean; children: ReactNode }) =>
    props.open ? <div>{props.children}</div> : null,
  DialogContent: (props: { children: ReactNode; className?: string }) => (
    <div className={props.className}>{props.children}</div>
  ),
  DialogHeader: (props: { children: ReactNode }) => <div>{props.children}</div>,
  DialogDescription: (props: { children: ReactNode; className?: string }) => (
    <p className={props.className}>{props.children}</p>
  ),
  DialogTitle: (props: { children: ReactNode; className?: string }) => (
    <h2 className={props.className}>{props.children}</h2>
  ),
}));

// Captured before any spy is installed so the integration test can render the real modal
// through the recording double without recursing into itself.
const RealWorkspaceUnrelatedMessagingModal =
  WorkspaceUnrelatedMessagingModalModule.WorkspaceUnrelatedMessagingModal;

// The real Dialog primitives (distinct specifier, so the inline shell above does not apply):
// the "another modal is open" test needs the actual overlay the MCP/heartbeat dialogs render.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDialog = require("../Dialog/Dialog?real=1") as typeof RealDialogModule;

let WorkspaceMenuBar!: typeof WorkspaceMenuBarComponent;

let workspaceMetadata = new Map<string, FrontendWorkspaceMetadata>();
let archivingWorkspaceIds = new Set<string>();
let cleanupDom: (() => void) | null = null;
const workspaceId = "workspace-1";
// Per-test API double read by the useAPI spy (null = not connected), so a test can supply a
// real-shaped client without stacking a second spy on the same hook.
let mockApi: unknown = null;

function TestWrapper(props: PropsWithChildren) {
  return <>{props.children}</>;
}

// The WorkspaceActionsMenuContent test double records every render's props, so
// gating assertions read the latest call instead of clicking through the menu.
function getLastMenuContentProps() {
  const spy = WorkspaceActionsMenuContentModule.WorkspaceActionsMenuContent as unknown as {
    mock: {
      calls: Array<
        [
          {
            onForkChat?: ((anchorEl: HTMLElement) => void) | null;
            onEnterImmersiveReview?: (() => void) | null;
            onOpenTouchFullscreenReview?: (() => void) | null;
            onOpenTimeline?: (() => void) | null;
            onConfigureUnrelatedMessaging?: (() => void) | null;
          },
        ]
      >;
    };
  };
  return spy.mock.calls.at(-1)?.[0];
}

function resolveArchivePreflight(
  result: { kind: "ready" } | { kind: "confirm-lossy-untracked-files"; paths: string[] } = {
    kind: "ready",
  }
) {
  return Promise.resolve({ success: true as const, data: result });
}

function resolveArchiveResult(
  result: { kind: "archived" } | { kind: "confirm-lossy-untracked-files"; paths: string[] } = {
    kind: "archived",
  }
) {
  return Promise.resolve({ success: true as const, data: result });
}

type ArchiveConfirmationResult =
  | { kind: "archived" }
  | { kind: "confirm-lossy-untracked-files"; paths: string[] };
type ArchivePreflightConfirmationResult =
  | { kind: "ready" }
  | { kind: "confirm-lossy-untracked-files"; paths: string[] };
interface ArchiveWorkspaceActionResult {
  success: boolean;
  error?: string;
  data?: ArchiveConfirmationResult;
}
interface ArchivePreflightActionResult {
  success: boolean;
  error?: string;
  data?: ArchivePreflightConfirmationResult;
}

let preflightArchiveWorkspaceMock = mock(
  (_workspaceId: string): Promise<ArchivePreflightActionResult> => resolveArchivePreflight()
);
let archiveWorkspaceMock = mock(
  (
    _workspaceId: string,
    _options?: { acknowledgedUntrackedPaths?: string[] }
  ): Promise<ArchiveWorkspaceActionResult> => resolveArchiveResult()
);
let archiveShowErrorMock = mock(() => undefined);

// Timeline gate control. useExperimentValue must be module-mocked, not driven through
// localStorage: bun module mocks are process-global, so another test file's leaked
// useExperiments mock would otherwise override the real hook and poison these gates.
let mockTimelineExperimentEnabled = false;

function installWorkspaceMenuBarTestDoubles() {
  const actualExperiments =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("@/browser/hooks/useExperiments?real=1") as typeof ExperimentsModuleType;
  void mock.module("@/browser/hooks/useExperiments", () => ({
    ...actualExperiments,
    useExperimentValue: (experimentId: string) =>
      experimentId === EXPERIMENT_IDS.TIMELINE && mockTimelineExperimentEnabled,
  }));

  preflightArchiveWorkspaceMock = mock(
    (_workspaceId: string): Promise<ArchivePreflightActionResult> => resolveArchivePreflight()
  );
  archiveWorkspaceMock = mock(
    (
      _workspaceId: string,
      _options?: { acknowledgedUntrackedPaths?: string[] }
    ): Promise<ArchiveWorkspaceActionResult> => resolveArchiveResult()
  );
  archiveShowErrorMock = mock(() => undefined);

  spyOn(APIModule, "useAPI").mockImplementation(
    () => ({ api: mockApi }) as unknown as ReturnType<typeof APIModule.useAPI>
  );
  spyOn(AgentContextModule, "useAgent").mockImplementation(
    () =>
      ({ disableWorkspaceAgents: false }) as unknown as ReturnType<
        typeof AgentContextModule.useAgent
      >
  );
  spyOn(WorkspaceContextModule, "useWorkspaceActions").mockImplementation(
    () =>
      ({
        archivingWorkspaceIds,
        preflightArchiveWorkspace: preflightArchiveWorkspaceMock,
        archiveWorkspace: archiveWorkspaceMock,
      }) as unknown as ReturnType<typeof WorkspaceContextModule.useWorkspaceActions>
  );
  spyOn(WorkspaceContextModule, "useWorkspaceContext").mockImplementation(
    () =>
      ({ workspaceMetadata }) as unknown as ReturnType<
        typeof WorkspaceContextModule.useWorkspaceContext
      >
  );
  spyOn(ProjectContextModule, "useProjectContext").mockImplementation(
    () =>
      ({
        getProjectConfig: () => undefined,
        userProjects: new Map(),
      }) as unknown as ReturnType<typeof ProjectContextModule.useProjectContext>
  );
  spyOn(WorkspaceStoreModule, "useWorkspaceSidebarState").mockImplementation(
    () =>
      ({
        canInterrupt: false,
        isStarting: false,
        awaitingUserQuestion: false,
        loadedSkills: [],
        skillLoadErrors: [],
      }) as unknown as ReturnType<typeof WorkspaceStoreModule.useWorkspaceSidebarState>
  );
  spyOn(RuntimeStatusStoreModule, "useRuntimeStatus").mockImplementation(() => "unsupported");
  spyOn(RuntimeStatusStoreModule, "useRuntimeStatusStoreRaw").mockImplementation(
    () =>
      ({ invalidateWorkspace: () => undefined }) as unknown as ReturnType<
        typeof RuntimeStatusStoreModule.useRuntimeStatusStoreRaw
      >
  );
  spyOn(OpenTerminalModule, "useOpenTerminal").mockImplementation(() =>
    mock(() => Promise.resolve())
  );
  spyOn(OpenInEditorModule, "useOpenInEditor").mockImplementation(() =>
    mock(() => Promise.resolve({ success: true }))
  );
  spyOn(PersistedStateModule, "usePersistedState").mockImplementation(
    <T,>(_key: string, defaultValue: T) => [defaultValue, mock(() => undefined)] as const
  );
  spyOn(PopoverErrorHookModule, "usePopoverError").mockImplementation(
    () =>
      ({
        error: null,
        showError: archiveShowErrorMock,
        clearError: () => undefined,
      }) as unknown as ReturnType<typeof PopoverErrorHookModule.usePopoverError>
  );
  spyOn(DesktopTitlebarModule, "isDesktopMode").mockImplementation(() => false);
  spyOn(TutorialContextModule, "useTutorial").mockImplementation(
    () =>
      ({ startSequence: () => undefined }) as unknown as ReturnType<
        typeof TutorialContextModule.useTutorial
      >
  );
  spyOn(ChatCommandsModule, "forkWorkspace").mockImplementation(() =>
    Promise.resolve({ success: true as const })
  );

  spyOn(WorkspaceMCPModalModule, "WorkspaceMCPModal").mockImplementation(
    (() => null) as unknown as typeof WorkspaceMCPModalModule.WorkspaceMCPModal
  );
  spyOn(TooltipModule, "Tooltip").mockImplementation(
    TestWrapper as unknown as typeof TooltipModule.Tooltip
  );
  spyOn(TooltipModule, "TooltipTrigger").mockImplementation(
    TestWrapper as unknown as typeof TooltipModule.TooltipTrigger
  );
  spyOn(TooltipModule, "TooltipContent").mockImplementation(
    (() => null) as unknown as typeof TooltipModule.TooltipContent
  );
  spyOn(PopoverModule, "Popover").mockImplementation(
    TestWrapper as unknown as typeof PopoverModule.Popover
  );
  spyOn(PopoverModule, "PopoverTrigger").mockImplementation(
    TestWrapper as unknown as typeof PopoverModule.PopoverTrigger
  );
  spyOn(PopoverModule, "PopoverContent").mockImplementation(
    TestWrapper as unknown as typeof PopoverModule.PopoverContent
  );
  spyOn(CheckboxModule, "Checkbox").mockImplementation(
    (() => null) as unknown as typeof CheckboxModule.Checkbox
  );
  spyOn(DebugLlmRequestModalModule, "DebugLlmRequestModal").mockImplementation(
    (() => null) as unknown as typeof DebugLlmRequestModalModule.DebugLlmRequestModal
  );
  spyOn(ConfirmationModalModule, "ConfirmationModal").mockImplementation(((props: {
    isOpen: boolean;
    title: string;
    description?: React.ReactNode;
    warning?: React.ReactNode;
    confirmLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
  }) =>
    props.isOpen ? (
      <div data-testid="archive-confirmation-modal">
        <div>{props.title}</div>
        {props.description}
        {props.warning}
        <button type="button" onClick={props.onConfirm}>
          {props.confirmLabel ?? "Confirm"}
        </button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    ) : null) as unknown as typeof ConfirmationModalModule.ConfirmationModal);
  spyOn(PopoverErrorModule, "PopoverError").mockImplementation(
    (() => null) as unknown as typeof PopoverErrorModule.PopoverError
  );
  spyOn(WorkspaceActionsMenuContentModule, "WorkspaceActionsMenuContent").mockImplementation(
    ((props: { onArchiveChat?: ((anchorEl: HTMLElement) => void) | null }) =>
      props.onArchiveChat ? (
        <button type="button" onClick={(event) => props.onArchiveChat?.(event.currentTarget)}>
          Archive chat
        </button>
      ) : null) as unknown as typeof WorkspaceActionsMenuContentModule.WorkspaceActionsMenuContent
  );
  spyOn(WorkspaceTerminalIconModule, "WorkspaceTerminalIcon").mockImplementation(
    (() => null) as unknown as typeof WorkspaceTerminalIconModule.WorkspaceTerminalIcon
  );
  spyOn(SkillIndicatorModule, "SkillIndicator").mockImplementation(
    (() => null) as unknown as typeof SkillIndicatorModule.SkillIndicator
  );
  spyOn(TimelineDialogModule, "TimelineDialog").mockImplementation(
    (() => null) as unknown as typeof TimelineDialogModule.TimelineDialog
  );
  spyOn(
    WorkspaceUnrelatedMessagingModalModule,
    "WorkspaceUnrelatedMessagingModal"
  ).mockImplementation(
    (() =>
      null) as unknown as typeof WorkspaceUnrelatedMessagingModalModule.WorkspaceUnrelatedMessagingModal
  );
}

// Records render props like the WorkspaceActionsMenuContent double, so tests can
// assert the dialog opened without rendering the real timeline panel.
function getLastTimelineDialogProps() {
  const spy = TimelineDialogModule.TimelineDialog as unknown as {
    mock: { calls: Array<[{ workspaceId: string; open: boolean }]> };
  };
  return spy.mock.calls.at(-1)?.[0];
}

// Same recording double for the consent dialog (Radix portals do not render in happy-dom).
function getLastUnrelatedMessagingModalProps() {
  const spy =
    WorkspaceUnrelatedMessagingModalModule.WorkspaceUnrelatedMessagingModal as unknown as {
      mock: {
        calls: Array<
          [{ open: boolean; consentSupported: boolean; onOpenChange: (open: boolean) => void }]
        >;
      };
    };
  return spy.mock.calls.at(-1)?.[0];
}

/**
 * Replace window.matchMedia so viewport-gated actions can be exercised per test.
 * `matches` is re-read on every access and registered change listeners are returned
 * so tests can simulate live viewport transitions.
 */
function stubMatchMedia(matches: (query: string) => boolean) {
  const changeListeners: Array<() => void> = [];
  window.matchMedia = ((query: string) =>
    ({
      get matches() {
        return matches(query);
      },
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: (_type: string, listener: () => void) => {
        changeListeners.push(listener);
      },
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  return {
    fireChange: () => {
      for (const listener of changeListeners) {
        listener();
      }
    },
  };
}

const defaultProps: ComponentProps<typeof WorkspaceMenuBarComponent> = {
  workspaceId,
  projectName: "demo",
  projectPath: "/projects/demo",
  workspaceName: "feature-branch",
  workspaceTitle: "Feature branch",
  namedWorkspacePath: "/projects/demo/workspaces/feature-branch",
  runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
  leftSidebarCollapsed: false,
  onToggleLeftSidebarCollapsed: () => undefined,
};

const CONSENT_SWITCH_NAME = /allow messages from unrelated workspaces/i;

describe("WorkspaceMenuBar archive confirmations", () => {
  beforeEach(() => {
    workspaceMetadata = new Map();
    archivingWorkspaceIds = new Set();
    mockApi = null;
    mockTimelineExperimentEnabled = false;
    cleanupDom = installDom();
    installWorkspaceMenuBarTestDoubles();
    /* eslint-disable @typescript-eslint/no-require-imports */
    ({ WorkspaceMenuBar } = require("./WorkspaceMenuBar?workspace-menu-bar-test=1") as {
      WorkspaceMenuBar: typeof WorkspaceMenuBarComponent;
    });
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (!window.matchMedia) {
      window.matchMedia = (query: string): MediaQueryList => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: (_listener) => undefined,
        removeListener: (_listener) => undefined,
        addEventListener: (
          _type: string,
          _listener: EventListenerOrEventListenerObject | null,
          _options?: boolean | AddEventListenerOptions
        ) => undefined,
        removeEventListener: (
          _type: string,
          _listener: EventListenerOrEventListenerObject | null,
          _options?: boolean | EventListenerOptions
        ) => undefined,
        dispatchEvent: (_event) => false,
      });
    }
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  it("hides repo-dependent More-menu actions for scratch workspaces", () => {
    const scratchPath = "/home/user/.mux/scratch/workspace-1";
    workspaceMetadata.set(workspaceId, {
      kind: "scratch",
      id: workspaceId,
      name: "scratch-workspace-1",
      projectName: "Scratch",
      projectPath: scratchPath,
      namedWorkspacePath: scratchPath,
      runtimeConfig: { type: "local" },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const view = render(
      <WorkspaceMenuBar
        {...defaultProps}
        projectName="Scratch"
        projectPath={scratchPath}
        workspaceName="scratch-workspace-1"
        namedWorkspacePath={scratchPath}
        runtimeConfig={{ type: "local" }}
      />
    );

    expect(view.getByTestId("workspace-title").textContent).toBe("Feature branch");

    // Repo-dependent More-menu actions must be hidden: review events are
    // ignored by RightSidebar for scratch and forking scratch is unsupported.
    const scratchMenuProps = getLastMenuContentProps();
    expect(scratchMenuProps?.onForkChat).toBeNull();
    expect(scratchMenuProps?.onEnterImmersiveReview).toBeNull();
    expect(scratchMenuProps?.onOpenTouchFullscreenReview).toBeNull();
  });

  it("shows the archiving status only while this workspace has an archive request in flight", () => {
    archivingWorkspaceIds = new Set(["some-other-workspace"]);
    const idle = render(<WorkspaceMenuBar {...defaultProps} />);
    expect(idle.queryByTestId("workspace-archiving-status")).toBeNull();
    idle.unmount();

    archivingWorkspaceIds = new Set([workspaceId]);
    const archiving = render(<WorkspaceMenuBar {...defaultProps} />);
    expect(archiving.getByTestId("workspace-archiving-status")).not.toBeNull();
  });

  it("offers fork and immersive review in the More menu for repo-backed workspaces", () => {
    workspaceMetadata.set(workspaceId, {
      id: workspaceId,
      name: "feature-branch",
      projectName: "demo",
      projectPath: "/projects/demo",
      namedWorkspacePath: "/projects/demo/workspaces/feature-branch",
      runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    render(<WorkspaceMenuBar {...defaultProps} />);

    const menuProps = getLastMenuContentProps();
    expect(typeof menuProps?.onForkChat).toBe("function");
    expect(typeof menuProps?.onEnterImmersiveReview).toBe("function");
  });

  it("offers the Timeline action on narrow viewports and opens the dialog", () => {
    mockTimelineExperimentEnabled = true;
    stubMatchMedia((query) => query === `(max-width: ${NARROW_VIEWPORT_MAX_WIDTH_PX}px)`);

    render(<WorkspaceMenuBar {...defaultProps} />);

    const menuProps = getLastMenuContentProps();
    expect(typeof menuProps?.onOpenTimeline).toBe("function");

    act(() => {
      menuProps?.onOpenTimeline?.();
    });

    const dialogProps = getLastTimelineDialogProps();
    expect(dialogProps?.open).toBe(true);
    expect(dialogProps?.workspaceId).toBe(workspaceId);
  });

  it("hides the Timeline action on wide viewports", () => {
    mockTimelineExperimentEnabled = true;
    stubMatchMedia(() => false);

    render(<WorkspaceMenuBar {...defaultProps} />);

    expect(getLastMenuContentProps()?.onOpenTimeline).toBeNull();
  });

  it("hides the Timeline action when the timeline experiment is disabled", () => {
    stubMatchMedia((query) => query === `(max-width: ${NARROW_VIEWPORT_MAX_WIDTH_PX}px)`);

    render(<WorkspaceMenuBar {...defaultProps} />);

    expect(getLastMenuContentProps()?.onOpenTimeline).toBeNull();
  });

  it("offers the Timeline action when the shell container hides the sidebar at wide viewports", () => {
    mockTimelineExperimentEnabled = true;
    stubMatchMedia(() => false);

    // Mimic WorkspaceShell: the shell wraps the menu bar and a CSS-hidden right sidebar
    // (the <=684px container query), which the gate reads via computed style.
    const shell = document.createElement("div");
    shell.setAttribute("data-workspace-shell", "");
    document.body.appendChild(shell);
    const sidebar = document.createElement("div");
    sidebar.className = "mobile-hide-right-sidebar";
    sidebar.style.display = "none";
    shell.appendChild(sidebar);
    const mount = document.createElement("div");
    shell.appendChild(mount);

    render(<WorkspaceMenuBar {...defaultProps} />, { container: mount });

    expect(typeof getLastMenuContentProps()?.onOpenTimeline).toBe("function");
    shell.remove();
  });

  it("re-gates the Timeline action when the viewport crosses the narrow breakpoint", () => {
    mockTimelineExperimentEnabled = true;
    let narrow = false;
    const media = stubMatchMedia(
      (query) => narrow && query === `(max-width: ${NARROW_VIEWPORT_MAX_WIDTH_PX}px)`
    );

    render(<WorkspaceMenuBar {...defaultProps} />);
    expect(getLastMenuContentProps()?.onOpenTimeline).toBeNull();

    narrow = true;
    act(() => {
      media.fireChange();
    });

    expect(typeof getLastMenuContentProps()?.onOpenTimeline).toBe("function");
  });

  it("opens the timeline dialog with the keyboard shortcut on narrow viewports", () => {
    mockTimelineExperimentEnabled = true;
    stubMatchMedia((query) => query === `(max-width: ${NARROW_VIEWPORT_MAX_WIDTH_PX}px)`);

    render(<WorkspaceMenuBar {...defaultProps} />);

    act(() => {
      fireEvent.keyDown(window, { key: "T", shiftKey: true });
    });

    const dialogProps = getLastTimelineDialogProps();
    expect(dialogProps?.open).toBe(true);
  });

  it("ignores the timeline shortcut while the sidebar is visible", () => {
    mockTimelineExperimentEnabled = true;
    stubMatchMedia(() => false);

    render(<WorkspaceMenuBar {...defaultProps} />);

    act(() => {
      fireEvent.keyDown(window, { key: "T", shiftKey: true });
    });

    expect(getLastTimelineDialogProps()?.open).toBe(false);
  });

  it("ignores the timeline shortcut while another modal is open", () => {
    mockTimelineExperimentEnabled = true;
    stubMatchMedia((query) => query === `(max-width: ${NARROW_VIEWPORT_MAX_WIDTH_PX}px)`);

    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);

    render(<WorkspaceMenuBar {...defaultProps} />);

    act(() => {
      fireEvent.keyDown(window, { key: "T", shiftKey: true });
    });

    expect(getLastTimelineDialogProps()?.open).toBe(false);
    modal.remove();
  });

  it("closes the timeline dialog when switching workspaces", () => {
    mockTimelineExperimentEnabled = true;
    stubMatchMedia((query) => query === `(max-width: ${NARROW_VIEWPORT_MAX_WIDTH_PX}px)`);

    const view = render(<WorkspaceMenuBar {...defaultProps} />);

    act(() => {
      fireEvent.keyDown(window, { key: "T", shiftKey: true });
    });
    expect(getLastTimelineDialogProps()?.open).toBe(true);

    // The timeline's "Open child workspace" action swaps the selected workspace while
    // App reuses this menu bar instance; the dialog must not cover the new workspace.
    view.rerender(<WorkspaceMenuBar {...defaultProps} workspaceId="workspace-2" />);

    expect(getLastTimelineDialogProps()?.open).toBe(false);

    // Returning to the original workspace must not resurrect the dialog: the
    // retained id is cleared on leave, not merely masked by the comparison.
    view.rerender(<WorkspaceMenuBar {...defaultProps} />);

    expect(getLastTimelineDialogProps()?.open).toBe(false);
  });

  it.each([
    {
      opener: "More menu",
      open: () => getLastMenuContentProps()?.onConfigureUnrelatedMessaging?.(),
    },
    {
      opener: "keyboard shortcut",
      open: () => fireEvent.keyDown(window, { key: "U", ctrlKey: true, shiftKey: true }),
    },
  ])("closes the consent dialog opened from the $opener when switching workspaces", ({ open }) => {
    const view = render(<WorkspaceMenuBar {...defaultProps} />);
    expect(getLastUnrelatedMessagingModalProps()?.open).toBe(false);

    act(() => {
      open();
    });
    expect(getLastUnrelatedMessagingModalProps()?.open).toBe(true);
    const staleOnOpenChange = getLastUnrelatedMessagingModalProps()!.onOpenChange;

    // Consent is granted per recipient workspace. Selecting another workspace while App
    // reuses this menu bar must close the dialog so the switch cannot be flipped against
    // the workspace the user navigated to.
    view.rerender(<WorkspaceMenuBar {...defaultProps} workspaceId="workspace-2" />);
    expect(getLastUnrelatedMessagingModalProps()?.open).toBe(false);

    // A callback retained from the first workspace's dialog cannot reopen it here either.
    act(() => {
      staleOnOpenChange(true);
    });
    expect(getLastUnrelatedMessagingModalProps()?.open).toBe(false);

    // Returning does not resurrect it: the retained id is cleared on leave.
    view.rerender(<WorkspaceMenuBar {...defaultProps} />);
    expect(getLastUnrelatedMessagingModalProps()?.open).toBe(false);
  });

  it("gives each workspace its own consent dialog so a pending request cannot leak across a switch", async () => {
    // Real-shaped client whose calls stay pending until the test settles them.
    const requests: Array<{
      input: { workspaceId: string; enabled: boolean };
      settle: (result: Result<void, string>) => void;
    }> = [];
    mockApi = {
      workspace: {
        setUnrelatedWorkspaceConsent: (input: { workspaceId: string; enabled: boolean }) =>
          new Promise<Result<void, string>>((settle) => requests.push({ input, settle })),
      },
    };
    // Render the real modal through the recording double so its pending/error state is live.
    (
      WorkspaceUnrelatedMessagingModalModule.WorkspaceUnrelatedMessagingModal as unknown as {
        mockImplementation: (
          impl: typeof WorkspaceUnrelatedMessagingModalModule.WorkspaceUnrelatedMessagingModal
        ) => void;
      }
    ).mockImplementation((props) => <RealWorkspaceUnrelatedMessagingModal {...props} />);

    const view = render(<WorkspaceMenuBar {...defaultProps} />);
    act(() => {
      getLastMenuContentProps()?.onConfigureUnrelatedMessaging?.();
    });
    // Workspace A: start a request and leave it in flight (switch locked, "Saving" shown).
    fireEvent.click(view.getByRole("switch", { name: CONSENT_SWITCH_NAME }));
    expect(requests).toHaveLength(1);
    expect(requests[0].input).toEqual({ workspaceId, enabled: true });
    await waitFor(() => {
      expect(
        (view.getByRole("switch", { name: CONSENT_SWITCH_NAME }) as HTMLButtonElement).disabled
      ).toBe(true);
    });
    expect(view.queryByRole("status")).not.toBeNull();

    // Workspace B: the dialog opened here must be B's own, not A's still-saving instance.
    view.rerender(<WorkspaceMenuBar {...defaultProps} workspaceId="workspace-2" />);
    expect(view.queryByRole("switch", { name: CONSENT_SWITCH_NAME })).toBeNull();
    act(() => {
      getLastMenuContentProps()?.onConfigureUnrelatedMessaging?.();
    });
    expect(
      (view.getByRole("switch", { name: CONSENT_SWITCH_NAME }) as HTMLButtonElement).disabled
    ).toBe(false);
    expect(view.queryByRole("status")).toBeNull();

    // A's request settling (here: refused) belongs to A's dialog and must not surface in B.
    await act(async () => {
      requests[0].settle(Err("workspace-1 refused"));
      await Promise.resolve();
    });
    expect(view.queryByRole("alert")).toBeNull();
    expect(
      (view.getByRole("switch", { name: CONSENT_SWITCH_NAME }) as HTMLButtonElement).disabled
    ).toBe(false);

    // B is fully usable and its request targets B.
    fireEvent.click(view.getByRole("switch", { name: CONSENT_SWITCH_NAME }));
    expect(requests).toHaveLength(2);
    expect(requests[1].input).toEqual({ workspaceId: "workspace-2", enabled: true });
    await act(async () => {
      requests[1].settle(Ok(undefined));
      await Promise.resolve();
    });
    expect(
      (view.getByRole("switch", { name: CONSENT_SWITCH_NAME }) as HTMLButtonElement).disabled
    ).toBe(false);
    expect(view.queryByRole("alert")).toBeNull();
  });

  it("ignores the consent shortcut while another modal is open", () => {
    // A real open modal built from the shared primitives (overlay inline: the Radix Portal does
    // not render in happy-dom). Like the MCP and heartbeat dialogs at runtime, nothing here
    // carries aria-modal, so the guard must recognise the overlay itself.
    const view = render(
      <>
        <RealDialog.Dialog open>
          <RealDialog.DialogOverlay data-testid="other-modal-overlay" />
        </RealDialog.Dialog>
        <WorkspaceMenuBar {...defaultProps} />
      </>
    );
    expect(view.getByTestId("other-modal-overlay").getAttribute("data-state")).toBe("open");
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();

    act(() => {
      fireEvent.keyDown(window, { key: "U", ctrlKey: true, shiftKey: true });
    });

    expect(getLastUnrelatedMessagingModalProps()?.open).toBe(false);
  });

  // Unrelated delivery requires local or worktree runtimes on BOTH endpoints (TaskService
  // refuses otherwise), so remote/container workspaces get no consent switch: a grant there
  // could never be honoured. The dialog still opens there for the same-tree hold preference.
  // An unset config means the canonical default.
  it.each<{ runtime: string; runtimeConfig: RuntimeConfig | undefined }>([
    { runtime: "worktree", runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" } },
    { runtime: "project-dir local", runtimeConfig: { type: "local" } },
    { runtime: "legacy local worktree", runtimeConfig: { type: "local", srcBaseDir: "/tmp/src" } },
    { runtime: "canonical default (unset)", runtimeConfig: undefined },
  ])("offers the consent action and shortcut for $runtime workspaces", ({ runtimeConfig }) => {
    render(<WorkspaceMenuBar {...defaultProps} runtimeConfig={runtimeConfig} />);

    expect(typeof getLastMenuContentProps()?.onConfigureUnrelatedMessaging).toBe("function");
    act(() => {
      fireEvent.keyDown(window, { key: "U", ctrlKey: true, shiftKey: true });
    });
    expect(getLastUnrelatedMessagingModalProps()?.open).toBe(true);
    expect(getLastUnrelatedMessagingModalProps()?.consentSupported).toBe(true);
  });

  it.each<{ runtime: string; runtimeConfig: RuntimeConfig }>([
    { runtime: "SSH", runtimeConfig: { type: "ssh", host: "dev.example", srcBaseDir: "/srv/src" } },
    {
      runtime: "Coder",
      runtimeConfig: { type: "ssh", host: CODER_RUNTIME_PLACEHOLDER, srcBaseDir: "~/src" },
    },
    { runtime: "Docker", runtimeConfig: { type: "docker", image: "node:20" } },
    {
      runtime: "devcontainer",
      runtimeConfig: { type: "devcontainer", configPath: ".devcontainer/devcontainer.json" },
    },
  ])("opens the dialog without the consent switch for $runtime workspaces", ({ runtimeConfig }) => {
    render(<WorkspaceMenuBar {...defaultProps} runtimeConfig={runtimeConfig} />);

    expect(typeof getLastMenuContentProps()?.onConfigureUnrelatedMessaging).toBe("function");
    act(() => {
      fireEvent.keyDown(window, { key: "U", ctrlKey: true, shiftKey: true });
    });
    expect(getLastUnrelatedMessagingModalProps()?.open).toBe(true);
    expect(getLastUnrelatedMessagingModalProps()?.consentSupported).toBe(false);
  });

  it("keeps the Timeline action hidden when immersive review hides the sidebar", () => {
    mockTimelineExperimentEnabled = true;
    stubMatchMedia(() => false);

    // Immersive review hides the sidebar via the same display:none but marks it
    // aria-hidden; the gate must not treat that as a responsive (narrow) layout.
    const shell = document.createElement("div");
    shell.setAttribute("data-workspace-shell", "");
    document.body.appendChild(shell);
    const sidebar = document.createElement("div");
    sidebar.className = "mobile-hide-right-sidebar";
    sidebar.style.display = "none";
    sidebar.setAttribute("aria-hidden", "true");
    shell.appendChild(sidebar);
    const mount = document.createElement("div");
    shell.appendChild(mount);

    render(<WorkspaceMenuBar {...defaultProps} />, { container: mount });

    expect(getLastMenuContentProps()?.onOpenTimeline).toBeNull();

    act(() => {
      fireEvent.keyDown(window, { key: "T", shiftKey: true });
    });
    expect(getLastTimelineDialogProps()?.open).toBe(false);
    shell.remove();
  });

  it("applies the collapsed-left-sidebar inset immediately from props", () => {
    const view = render(<WorkspaceMenuBar {...defaultProps} leftSidebarCollapsed />);

    expect(view.getByTestId("workspace-menu-bar").style.paddingLeft).toBe(
      `${WORKSPACE_MENU_BAR_LEFT_SIDEBAR_COLLAPSED_PADDING_PX}px`
    );
  });

  it("opens the archive confirmation modal when preflight finds untracked files", async () => {
    preflightArchiveWorkspaceMock = mock(
      (_workspaceId: string): Promise<ArchivePreflightActionResult> =>
        resolveArchivePreflight({
          kind: "confirm-lossy-untracked-files",
          paths: [".cache/", "temp.txt"],
        })
    );

    const view = render(<WorkspaceMenuBar {...defaultProps} />);

    act(() => {
      fireEvent.click(view.getByRole("button", { name: "Archive chat" }));
    });

    await waitFor(() => {
      expect(view.getByTestId("archive-confirmation-modal")).toBeTruthy();
    });
    expect(archiveWorkspaceMock).not.toHaveBeenCalled();
    expect(view.getByText("Archive workspace with untracked files?")).toBeTruthy();
  });

  it("does not show another workspace's archive confirmation after navigating away", async () => {
    let resolvePreflight: ((result: ArchivePreflightActionResult) => void) | undefined;
    preflightArchiveWorkspaceMock = mock(
      (_workspaceId: string) =>
        new Promise<ArchivePreflightActionResult>((resolve) => {
          resolvePreflight = resolve;
        })
    );

    const view = render(<WorkspaceMenuBar {...defaultProps} />);
    act(() => {
      fireEvent.click(view.getByRole("button", { name: "Archive chat" }));
    });
    await waitFor(() => expect(resolvePreflight).toBeDefined());

    // The menu bar is reused when the user switches workspaces mid-preflight.
    view.rerender(<WorkspaceMenuBar {...defaultProps} workspaceId="workspace-2" />);
    await act(async () => {
      resolvePreflight?.({
        success: true,
        data: { kind: "confirm-lossy-untracked-files", paths: ["a.txt"] },
      });
      await Promise.resolve();
    });

    expect(view.queryByTestId("archive-confirmation-modal")).toBeNull();
    expect(archiveWorkspaceMock).not.toHaveBeenCalled();
  });
});
