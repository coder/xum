import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { AgentListItem } from "@/browser/components/AgentListItem/AgentListItem";
import { APIProvider } from "@/browser/contexts/API";
import { ProjectProvider } from "@/browser/contexts/ProjectContext";
import { TitleEditProvider } from "@/browser/contexts/WorkspaceTitleEditContext";
import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { expect, screen, waitFor, userEvent, within } from "@storybook/test";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { NOW, createWorkspace } from "@/browser/stories/mocks/workspaces";
import { useWorkspaceStoreRaw, workspaceStore } from "@/browser/stores/WorkspaceStore";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  GIT_STATUS_INDICATOR_MODE_KEY,
  LEFT_SIDEBAR_COLLAPSED_KEY,
  getStatusStateKey,
  getWorkspaceLastReadKey,
} from "@/common/constants/storage";
import type { AgentRowRenderMeta } from "@/browser/utils/ui/workspaceFiltering";
import type { WorkspaceActivitySnapshot } from "@/common/orpc/types";
import { SubAgentListItem } from "./SubAgentListItem";

const meta: Meta<typeof AgentListItem> = {
  title: "Components/AgentListItem",
  component: AgentListItem,
  tags: ["connector-regression"],
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

const PROJECT_PATH = "/home/user/projects/workspace-item-states";
const PROJECT_NAME = "workspace-item-states";
const STORY_WORKSPACES = [
  createWorkspace({
    id: "ws-selected",
    name: "selected",
    title: "Selected agent workflow",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    createdAt: new Date(NOW - 1_000).toISOString(),
  }),
  createWorkspace({
    id: "ws-active",
    name: "active",
    title: "Active agent workflow",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    createdAt: new Date(NOW - 2_000).toISOString(),
  }),
  createWorkspace({
    id: "ws-idle",
    name: "idle",
    title: "Idle agent workflow",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    createdAt: new Date(NOW - 3_000).toISOString(),
  }),
  createWorkspace({
    id: "ws-error",
    name: "error",
    title: "Error state agent workflow",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    createdAt: new Date(NOW - 4_000).toISOString(),
  }),
  createWorkspace({
    id: "ws-question",
    name: "question",
    title: "Agent workflow needs input",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    createdAt: new Date(NOW - 5_000).toISOString(),
  }),
];

function StoryScaffold(props: {
  children: ReactNode;
  activeWorkspaceId?: string;
  workspaces?: ReadonlyArray<(typeof STORY_WORKSPACES)[number]>;
  rowContainerClassName?: string;
  workspaceActivitySnapshots?: Record<string, WorkspaceActivitySnapshot>;
}) {
  const api = createMockORPCClient({
    workspaceActivitySnapshots: props.workspaceActivitySnapshots,
    onChat: (workspaceId, emit) => {
      emit({ type: "caught-up", historyReplayStatus: "complete", hasOlderHistory: false });
      if (workspaceId === "ws-active") {
        emit({
          type: "stream-start",
          workspaceId,
          messageId: "story-ws-active-stream",
          model: "mock-model",
          historySequence: 1_000,
          startTime: NOW,
        });
      }
      if (workspaceId === "ws-error") {
        emit({
          type: "stream-start",
          workspaceId,
          messageId: "story-ws-error-stream",
          model: "mock-model",
          historySequence: 1_001,
          startTime: NOW,
        });
        emit({
          type: "stream-abort",
          workspaceId,
          messageId: "story-ws-error-stream",
          abortReason: "system",
        });
      }
      if (workspaceId === "ws-question") {
        emit({
          type: "stream-start",
          workspaceId,
          messageId: "story-ws-question-stream",
          model: "mock-model",
          historySequence: 1_002,
          startTime: NOW,
        });
        emit({
          type: "tool-call-start",
          workspaceId,
          messageId: "story-ws-question-stream",
          toolCallId: "story-call-ask-1",
          toolName: "ask_user_question",
          args: {
            questions: [
              {
                id: "scope",
                prompt: "Which approach should we use?",
                options: [
                  { id: "a", label: "Approach A" },
                  { id: "b", label: "Approach B" },
                ],
              },
            ],
          },
          tokens: 5,
          timestamp: NOW,
        });
      }
    },
  });
  const workspaceStoreRaw = useWorkspaceStoreRaw();
  useEffect(() => {
    workspaceStoreRaw.setClient(api);
    return () => {
      workspaceStoreRaw.setClient(null);
    };
  }, [api, workspaceStoreRaw]);
  const workspaces = props.workspaces ?? STORY_WORKSPACES;
  for (const workspace of workspaces) {
    workspaceStore.addWorkspace(workspace);
  }
  workspaceStore.setActiveWorkspaceId(props.activeWorkspaceId ?? null);
  updatePersistedState(LEFT_SIDEBAR_COLLAPSED_KEY, false);
  updatePersistedState(GIT_STATUS_INDICATOR_MODE_KEY, "line-delta");
  updatePersistedState(getStatusStateKey("ws-selected"), {
    emoji: "🔍",
    message: "Agent text will go here like so",
  });
  updatePersistedState(getStatusStateKey("ws-active"), {
    emoji: "🔧",
    message: "Agent text will go here like so",
  });
  updatePersistedState(getStatusStateKey("ws-error"), {
    emoji: "🔧",
    message: "Build failed with error",
  });
  updatePersistedState(getStatusStateKey("ws-question"), {
    emoji: "🔍",
    message: "Agent has a question for you",
  });

  return (
    <APIProvider client={api}>
      <ProjectProvider>
        <TitleEditProvider onUpdateTitle={() => Promise.resolve({ success: true })}>
          <TooltipProvider>
            <DndProvider backend={HTML5Backend}>
              <div className="subagent-connector-clock border-border bg-surface-primary w-[360px] max-w-full rounded-md border p-2">
                <div className={props.rowContainerClassName ?? "space-y-1"}>{props.children}</div>
              </div>
            </DndProvider>
          </TooltipProvider>
        </TitleEditProvider>
      </ProjectProvider>
    </APIProvider>
  );
}

// Labeled wrapper so each gallery permutation stays visually distinct and
// identifiable to reviewers even though many states now share one snapshot.
function GallerySection(props: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium opacity-60">{props.label}</div>
      {props.children}
    </div>
  );
}

// Shared row factory so gallery permutations don't duplicate the long prop list.
function WorkspaceRow(props: {
  workspace: (typeof STORY_WORKSPACES)[number];
  isSelected?: boolean;
  isArchiving?: boolean;
  rowRenderMeta?: AgentRowRenderMeta;
  completedChildrenExpanded?: boolean;
  onToggleCompletedChildren?: (workspaceId: string) => void;
}) {
  return (
    <AgentListItem
      metadata={props.workspace}
      projectPath={PROJECT_PATH}
      projectName={PROJECT_NAME}
      depth={props.rowRenderMeta?.depth}
      rowRenderMeta={props.rowRenderMeta}
      completedChildrenExpanded={props.completedChildrenExpanded}
      onToggleCompletedChildren={props.onToggleCompletedChildren}
      isSelected={props.isSelected ?? false}
      isArchiving={props.isArchiving === true}
      onSelectWorkspace={() => undefined}
      onForkWorkspace={() => Promise.resolve()}
      onArchiveWorkspace={() => Promise.resolve()}
      onCancelCreation={() => Promise.resolve()}
    />
  );
}

function DraftRow() {
  return (
    <AgentListItem
      variant="draft"
      draft={{
        draftId: "draft-state",
        draftNumber: 1,
        title: "Draft agent workflow",
        promptPreview: "",
        onOpen: () => undefined,
        onDelete: () => undefined,
      }}
      projectPath={PROJECT_PATH}
      isSelected={false}
    />
  );
}

// Gallery merging the primary single-workspace visual states (formerly the
// FigmaStates, Selected, Active, ErrorState, Archiving, Question, and Draft
// stories) into one snapshot. Status text/emoji is per-workspace (driven by the
// persisted status state set in StoryScaffold), so each row shows its own state.
function renderStatesGallery() {
  return (
    <StoryScaffold activeWorkspaceId="ws-active">
      <GallerySection label="Selected">
        <WorkspaceRow workspace={STORY_WORKSPACES[0]} isSelected />
      </GallerySection>
      <GallerySection label="Active (streaming)">
        <WorkspaceRow workspace={STORY_WORKSPACES[1]} />
      </GallerySection>
      <GallerySection label="Idle">
        <WorkspaceRow workspace={STORY_WORKSPACES[2]} />
      </GallerySection>
      <GallerySection label="Error">
        <WorkspaceRow workspace={STORY_WORKSPACES[3]} />
      </GallerySection>
      <GallerySection label="Archiving">
        <WorkspaceRow workspace={STORY_WORKSPACES[3]} isArchiving />
      </GallerySection>
      <GallerySection label="Question">
        <WorkspaceRow workspace={STORY_WORKSPACES[4]} />
      </GallerySection>
      <GallerySection label="Draft">
        <DraftRow />
      </GallerySection>
    </StoryScaffold>
  );
}

function renderSingleWorkspaceState(workspaceIndex: number, options?: { isArchiving?: boolean }) {
  const workspace = STORY_WORKSPACES[workspaceIndex];
  return (
    <StoryScaffold activeWorkspaceId={workspace.id}>
      <AgentListItem
        metadata={workspace}
        projectPath={PROJECT_PATH}
        projectName={PROJECT_NAME}
        isSelected={workspace.id === "ws-selected"}
        isArchiving={options?.isArchiving === true}
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
    </StoryScaffold>
  );
}

function renderIdleState(isUnread: boolean) {
  const workspace = STORY_WORKSPACES[2];
  const createdAtMs = Date.parse(workspace.createdAt ?? new Date(NOW).toISOString());
  // Explicitly control idle visual state for stories: unread => gray ring dot, seen => hidden dot.
  updatePersistedState(
    getWorkspaceLastReadKey(workspace.id),
    isUnread ? createdAtMs - 60_000 : createdAtMs + 60_000
  );
  return renderSingleWorkspaceState(2);
}

const SUB_AGENT_ROW_META_BASE = {
  depth: 1,
  rowKind: "subagent",
  sharedTrunkActiveThroughRow: false,
  sharedTrunkActiveBelowRow: false,
  ancestorTrunks: [],
  hasHiddenCompletedChildren: false,
  visibleCompletedChildrenCount: 0,
} as const satisfies Omit<AgentRowRenderMeta, "connectorPosition">;

function createSubAgentRowRenderMeta(
  connectorPosition: AgentRowRenderMeta["connectorPosition"],
  overrides?: Partial<
    Pick<AgentRowRenderMeta, "sharedTrunkActiveThroughRow" | "sharedTrunkActiveBelowRow">
  >
): AgentRowRenderMeta {
  return {
    ...SUB_AGENT_ROW_META_BASE,
    connectorPosition,
    ...overrides,
  };
}

const NESTED_CONNECTOR_PARENT_ROW_META = {
  depth: 0,
  rowKind: "primary",
  connectorPosition: "single",
  sharedTrunkActiveThroughRow: false,
  sharedTrunkActiveBelowRow: false,
  // The parent owns the top of the shared child trunk, so the connector run
  // starts at the parent row instead of the first child row.
  childTrunkActive: true,
  ancestorTrunks: [],
  hasHiddenCompletedChildren: false,
  visibleCompletedChildrenCount: 0,
} as const satisfies AgentRowRenderMeta;

const APP_SIDEBAR_ACTIVE_SUBAGENT_WORKSPACES = [
  createWorkspace({
    id: "ws-sidebar-parent",
    name: "sidebar-parent",
    title: "Sidebar parent agent",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    createdAt: new Date(NOW - 11_000).toISOString(),
  }),
  createWorkspace({
    id: "ws-sidebar-sub-1",
    name: "sidebar-sub-1",
    title: "Active sub-agent 1",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    createdAt: new Date(NOW - 12_000).toISOString(),
  }),
  createWorkspace({
    id: "ws-sidebar-sub-2",
    name: "sidebar-sub-2",
    title: "Active sub-agent 2",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    createdAt: new Date(NOW - 13_000).toISOString(),
  }),
  createWorkspace({
    id: "ws-sidebar-sub-3",
    name: "sidebar-sub-3",
    title: "Active sub-agent 3",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    createdAt: new Date(NOW - 14_000).toISOString(),
  }),
];

function renderAppSidebarThreeActiveSubAgents() {
  return (
    <StoryScaffold
      workspaces={APP_SIDEBAR_ACTIVE_SUBAGENT_WORKSPACES}
      rowContainerClassName="space-y-0"
    >
      <AgentListItem
        metadata={APP_SIDEBAR_ACTIVE_SUBAGENT_WORKSPACES[0]}
        projectPath={PROJECT_PATH}
        projectName={PROJECT_NAME}
        depth={0}
        rowRenderMeta={NESTED_CONNECTOR_PARENT_ROW_META}
        isSelected={false}
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
      <AgentListItem
        metadata={APP_SIDEBAR_ACTIVE_SUBAGENT_WORKSPACES[1]}
        projectPath={PROJECT_PATH}
        projectName={PROJECT_NAME}
        depth={1}
        rowRenderMeta={createSubAgentRowRenderMeta("middle", {
          sharedTrunkActiveThroughRow: true,
          sharedTrunkActiveBelowRow: true,
        })}
        isSelected={false}
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
      <AgentListItem
        metadata={APP_SIDEBAR_ACTIVE_SUBAGENT_WORKSPACES[2]}
        projectPath={PROJECT_PATH}
        projectName={PROJECT_NAME}
        depth={1}
        rowRenderMeta={createSubAgentRowRenderMeta("middle", {
          sharedTrunkActiveThroughRow: true,
          sharedTrunkActiveBelowRow: true,
        })}
        isSelected={false}
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
      <AgentListItem
        metadata={APP_SIDEBAR_ACTIVE_SUBAGENT_WORKSPACES[3]}
        projectPath={PROJECT_PATH}
        projectName={PROJECT_NAME}
        depth={1}
        rowRenderMeta={createSubAgentRowRenderMeta("last", {
          sharedTrunkActiveThroughRow: true,
          sharedTrunkActiveBelowRow: false,
        })}
        isSelected={false}
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
    </StoryScaffold>
  );
}

function renderWorkflowOnlyActivity() {
  const workflowWorkspace = createWorkspace({
    id: "ws-workflow-only",
    name: "workflow-only",
    title: "Workflow-only run",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    createdAt: new Date(NOW - 6_000).toISOString(),
  });

  return (
    <StoryScaffold
      workspaces={[workflowWorkspace]}
      workspaceActivitySnapshots={{
        [workflowWorkspace.id]: {
          recency: NOW,
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          activeWorkflowRunCount: 1,
        },
      }}
    >
      <WorkspaceRow workspace={workflowWorkspace} />
    </StoryScaffold>
  );
}

// Idle workspace parked on an armed background bash monitor: pulsing
// backgrounded-blue "waiting" dot + "Watching background bash" caption.
function renderBashMonitorWaiting() {
  const monitorWorkspace = createWorkspace({
    id: "ws-bash-monitor",
    name: "bash-monitor",
    title: "Waiting on background bash monitor",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    createdAt: new Date(NOW - 6_000).toISOString(),
  });

  return (
    <StoryScaffold
      workspaces={[monitorWorkspace]}
      workspaceActivitySnapshots={{
        [monitorWorkspace.id]: {
          recency: NOW,
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          activeBashMonitorCount: 1,
        },
      }}
    >
      <WorkspaceRow workspace={monitorWorkspace} />
    </StoryScaffold>
  );
}

// Composite gallery covering the primary single-workspace states. Replaces the
// former FigmaStates, Selected, Active, ErrorState, Archiving, Question, and
// Draft stories — one snapshot, all states preserved and labeled.
export const WorkflowOnlyActivity: Story = {
  args: undefined as never,
  render: renderWorkflowOnlyActivity,
};

export const BashMonitorWaiting: Story = {
  args: undefined as never,
  render: renderBashMonitorWaiting,
};

export const States: Story = {
  args: undefined as never,
  render: renderStatesGallery,
};

// Idle seen vs unread are kept as separate stories: both drive the same
// ws-idle last-read persisted key, so they cannot coexist in one scaffold.
export const IdleSeen: Story = {
  args: undefined as never,
  render: () => renderIdleState(false),
};

export const IdleNotSeen: Story = {
  args: undefined as never,
  render: () => renderIdleState(true),
};

const PRIMARY_ROW_META_WITH_HIDDEN_COMPLETED_CHILDREN = {
  depth: 0,
  rowKind: "primary",
  connectorPosition: "single",
  sharedTrunkActiveThroughRow: false,
  sharedTrunkActiveBelowRow: false,
  ancestorTrunks: [],
  hasHiddenCompletedChildren: true,
  visibleCompletedChildrenCount: 0,
} as const satisfies AgentRowRenderMeta;

const noopToggleCompletedChildren = () => undefined;

// Composite gallery for sub-agent row permutations. Replaces the eleven former
// SubAgent* / Parent* stories with one labeled snapshot. activeWorkspaceId is
// "ws-active": rows backed by ws-active (which has persisted status state) show
// status text, matching the former "...With Status Text" variants, while
// ws-idle rows show none — exactly as before. The single AppSidebar story stays
// separate because it uses a distinct workspace set.
function renderSubAgentGallery() {
  // ws-idle (index 2) used as a generic sub-agent row with no status text.
  const idle = STORY_WORKSPACES[2];
  // ws-active (index 1) carries persisted status state, so its rows render the
  // status-text treatment from the former "...With Status Text" stories.
  const active = STORY_WORKSPACES[1];
  // Own ws-idle's last-read state. IdleSeen/IdleNotSeen write the same persisted
  // key, so without pinning it here the idle rows inherit whichever sibling story
  // rendered last and flip between "idle" (primary title) and "seen" (tertiary
  // title), causing a non-deterministic snapshot diff. Pin to unread (matching the
  // workspace's "idle" semantics) so the gallery is stable regardless of order.
  const idleCreatedAtMs = Date.parse(idle.createdAt ?? new Date(NOW).toISOString());
  updatePersistedState(getWorkspaceLastReadKey(idle.id), idleCreatedAtMs - 60_000);
  return (
    // storybook-static-subagent-connectors freezes the active sub-agent connector
    // animation for this gallery (see globals.css) so snapshots don't race the
    // infinite stroke-dashoffset/translate animation to a random frame.
    <StoryScaffold
      activeWorkspaceId="ws-active"
      rowContainerClassName="storybook-static-subagent-connectors space-y-1"
    >
      <GallerySection label="Middle">
        <WorkspaceRow workspace={idle} rowRenderMeta={createSubAgentRowRenderMeta("middle")} />
      </GallerySection>
      <GallerySection label="Running">
        <WorkspaceRow
          workspace={{ ...idle, taskStatus: "running" }}
          rowRenderMeta={createSubAgentRowRenderMeta("middle", {
            sharedTrunkActiveThroughRow: true,
            sharedTrunkActiveBelowRow: true,
          })}
        />
      </GallerySection>
      <GallerySection label="Last">
        <WorkspaceRow workspace={idle} rowRenderMeta={createSubAgentRowRenderMeta("last")} />
      </GallerySection>
      <GallerySection label="Single">
        <WorkspaceRow workspace={idle} rowRenderMeta={createSubAgentRowRenderMeta("single")} />
      </GallerySection>
      <GallerySection label="Middle Selected">
        <WorkspaceRow
          workspace={idle}
          rowRenderMeta={createSubAgentRowRenderMeta("middle")}
          isSelected
        />
      </GallerySection>
      <GallerySection label="With Status Text">
        <WorkspaceRow workspace={active} rowRenderMeta={createSubAgentRowRenderMeta("middle")} />
      </GallerySection>
      <GallerySection label="Middle Selected With Status Text">
        <WorkspaceRow
          workspace={active}
          rowRenderMeta={createSubAgentRowRenderMeta("middle")}
          isSelected
        />
      </GallerySection>
      <GallerySection label="Last With Status Text">
        <WorkspaceRow workspace={active} rowRenderMeta={createSubAgentRowRenderMeta("last")} />
      </GallerySection>
      <GallerySection label="Last Selected">
        <WorkspaceRow
          workspace={idle}
          rowRenderMeta={createSubAgentRowRenderMeta("last")}
          isSelected
        />
      </GallerySection>
      <GallerySection label="Last Selected With Status Text">
        <WorkspaceRow
          workspace={active}
          rowRenderMeta={createSubAgentRowRenderMeta("last")}
          isSelected
        />
      </GallerySection>
      <GallerySection label="Parent With Completed Children Collapsed">
        <WorkspaceRow
          workspace={idle}
          rowRenderMeta={PRIMARY_ROW_META_WITH_HIDDEN_COMPLETED_CHILDREN}
          completedChildrenExpanded={false}
          onToggleCompletedChildren={noopToggleCompletedChildren}
        />
      </GallerySection>
      <GallerySection label="Parent With Completed Children Expanded">
        <WorkspaceRow
          workspace={idle}
          rowRenderMeta={PRIMARY_ROW_META_WITH_HIDDEN_COMPLETED_CHILDREN}
          completedChildrenExpanded={true}
          onToggleCompletedChildren={noopToggleCompletedChildren}
        />
      </GallerySection>
    </StoryScaffold>
  );
}

export const SubAgentStates: Story = {
  args: undefined as never,
  name: "SubAgent States/Gallery",
  render: renderSubAgentGallery,
  // ws-active streams asynchronously: the scaffold's onChat emits stream-start
  // through a fire-and-forget store subscription (ensureActiveOnChatSubscription
  // → void runOnChatSubscription), which flips its rows to the "active" visual
  // state (success-colored status dot). With no play() the snapshot races that
  // async transition and captures the dot as active-or-not at random. Wait for
  // the settled signal so every snapshot captures the same frame.
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      if (!canvasElement.querySelector(".workspace-status-dot-active")) {
        throw new Error("ws-active streaming status dot has not settled yet");
      }
    });
  },
};

export const AppSidebarThreeActiveSubAgents: Story = {
  args: undefined as never,
  name: "SubAgent States/App Sidebar Three Active Sub-Agents",
  render: renderAppSidebarThreeActiveSubAgents,
};

// Permanent regression story for connector-line continuity: a parent with
// several running sub-agents must render one uninterrupted trunk from the
// parent row's center down to the last child's elbow (parent-side child-trunk
// stub + full-height middle trunks + curve-only last elbow). The middle child
// carries status text so the story also covers trunk continuity across mixed
// row heights. Connector animations are frozen
// (storybook-static-subagent-connectors) so snapshots capture a deterministic
// dash phase.
function renderParentTrunkContinuity() {
  updatePersistedState(getStatusStateKey("ws-sidebar-sub-2"), {
    emoji: "🔧",
    message: "Two-line row keeps the trunk continuous",
  });
  const runningSubAgentMeta = createSubAgentRowRenderMeta("middle", {
    sharedTrunkActiveThroughRow: true,
    sharedTrunkActiveBelowRow: true,
  });
  return (
    <StoryScaffold
      workspaces={APP_SIDEBAR_ACTIVE_SUBAGENT_WORKSPACES}
      rowContainerClassName="storybook-static-subagent-connectors space-y-0"
    >
      <WorkspaceRow
        workspace={APP_SIDEBAR_ACTIVE_SUBAGENT_WORKSPACES[0]}
        rowRenderMeta={NESTED_CONNECTOR_PARENT_ROW_META}
      />
      <WorkspaceRow
        workspace={{ ...APP_SIDEBAR_ACTIVE_SUBAGENT_WORKSPACES[1], taskStatus: "running" }}
        rowRenderMeta={runningSubAgentMeta}
      />
      <WorkspaceRow
        workspace={{ ...APP_SIDEBAR_ACTIVE_SUBAGENT_WORKSPACES[2], taskStatus: "running" }}
        rowRenderMeta={runningSubAgentMeta}
      />
      <WorkspaceRow
        workspace={{ ...APP_SIDEBAR_ACTIVE_SUBAGENT_WORKSPACES[3], taskStatus: "running" }}
        rowRenderMeta={createSubAgentRowRenderMeta("last", {
          sharedTrunkActiveThroughRow: true,
        })}
      />
    </StoryScaffold>
  );
}

export const ParentTrunkContinuity: Story = {
  args: undefined as never,
  name: "SubAgent States/Parent Trunk Continuity",
  render: renderParentTrunkContinuity,
  play: async ({ canvasElement }) => {
    await waitFor(async () => {
      const canvas = within(canvasElement);
      const parent = canvas.getByTestId("subagent-child-trunk").getBoundingClientRect();
      const trunks = canvas
        .getAllByTestId("subagent-connector-trunk")
        .map((node) => node.getBoundingClientRect());
      const elbows = canvas.getAllByTestId("subagent-connector-elbow");
      await expect(trunks).toHaveLength(3);
      await expect(parent.height).toBeGreaterThan(0);
      await expect(Math.abs(parent.bottom - trunks[0].top)).toBeLessThan(1);
      for (const [index, trunk] of trunks.entries()) {
        await expect(trunk.height).toBeGreaterThan(0);
        await expect(Math.abs(trunk.left - parent.left)).toBeLessThan(1);
        const nextTop = trunks[index + 1]?.top ?? elbows[index].getBoundingClientRect().top;
        await expect(Math.abs(trunk.bottom - nextTop)).toBeLessThan(1);
      }
    });
  },
};

export const ParentTrunkContinuityPhone: Story = {
  ...ParentTrunkContinuity,
  name: "SubAgent States/Parent Trunk Continuity Phone",
  parameters: {
    pixel: { matrix: { viewports: ["phone"] } },
    viewport: {
      options: {
        phone: { name: "Phone", styles: { width: "390px", height: "844px" }, type: "mobile" },
      },
    },
  },
  globals: { viewport: { value: "phone", isRotated: false } },
  // The test runner ignores viewport globals; constrain the actual container too.
  decorators: [
    (Story) => (
      <div style={{ width: 343, maxWidth: "100%" }}>
        <Story />
      </div>
    ),
  ],
};

function ConnectorAnimationLifecycleFixture() {
  const [count, setCount] = useState(1);
  const [active, setActive] = useState(false);
  return (
    <div className="subagent-connector-clock w-[340px] max-w-full">
      <button onClick={() => setCount((value) => value + 1)}>Add child</button>
      <button onClick={() => setActive((value) => !value)}>Toggle child</button>
      <button
        onClick={() => {
          setCount(0);
          setActive(false);
        }}
      >
        Stop children
      </button>
      {Array.from({ length: count + 1 }, (_, index) => (
        <SubAgentListItem
          key={index}
          connectorPosition="middle"
          sharedTrunkActiveThroughRow={index !== 0 || active}
          ancestorTrunks={[]}
          connectorRailX={18}
          childStatusCenterX={26}
          isSelected={false}
          isElbowActive={index !== 0 || active}
        >
          <div className="h-8 pl-8">Child {index}</div>
        </SubAgentListItem>
      ))}
    </div>
  );
}

export const ConnectorAnimationLifecycle: Story = {
  args: undefined as never,
  name: "SubAgent States/Connector Animation Lifecycle",
  // Pixel intentionally disables motion; exercise the live CSS timeline in the
  // browser test runner, leaving the pinned continuity stories for snapshots.
  parameters: { pixel: { exclude: true } },
  render: () => <ConnectorAnimationLifecycleFixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const root = canvasElement.ownerDocument.documentElement;
    const wasInactive = root.hasAttribute("data-renderer-inactive");
    const frame = () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );
    const trunkPhases = () =>
      Array.from(
        canvasElement.querySelectorAll(".subagent-connector-active"),
        (node) => getComputedStyle(node, "::before").backgroundPositionY
      );
    const assertSynchronized = async () => {
      // Sample all rendered offsets in one frame before instrumented assertions yield.
      const trunks = trunkPhases();
      const elbows = Array.from(
        canvasElement.querySelectorAll(".subagent-connector-elbow-active"),
        (node) => getComputedStyle(node).strokeDashoffset
      );
      const elbow = canvasElement.querySelector(".subagent-connector-elbow-active")!;
      const period = getComputedStyle(elbow)
        .strokeDasharray.split(/[, ]+/)
        .reduce((sum, part) => sum + Number.parseFloat(part), 0);
      await expect(new Set(trunks).size).toBe(1);
      await expect(new Set(elbows).size).toBe(1);
      await expect(Number.parseFloat(elbows[0]) + Number.parseFloat(trunks[0])).toBeCloseTo(
        period,
        2
      );
    };
    try {
      root.removeAttribute("data-renderer-inactive");
      const initialPhase = trunkPhases()[0];
      await waitFor(() => expect(trunkPhases()[0]).not.toBe(initialPhase));
      root.setAttribute("data-renderer-inactive", "");
      await frame();
      const pausedPhase = trunkPhases()[0];
      // Mount and reactivate real components while the renderer's timeline is paused.
      await userEvent.click(canvas.getByRole("button", { name: "Add child" }));
      await userEvent.click(canvas.getByRole("button", { name: "Toggle child" }));
      await frame();
      await expect(trunkPhases()).toHaveLength(3);
      await expect(trunkPhases()[0]).toBe(pausedPhase);
      await assertSynchronized();
      root.removeAttribute("data-renderer-inactive");
      await waitFor(() => expect(trunkPhases()[0]).not.toBe(pausedPhase));
      await assertSynchronized();
      // An ordinary rerender and another late mount must not restart old phases.
      await userEvent.click(canvas.getByRole("button", { name: "Add child" }));
      await frame();
      await expect(trunkPhases()).toHaveLength(4);
      await assertSynchronized();
      await userEvent.click(canvas.getByRole("button", { name: "Stop children" }));
      await frame();
      await expect(trunkPhases()).toHaveLength(0);
      await expect(
        canvasElement.querySelector(".subagent-connector-clock")!.getAnimations()
      ).toHaveLength(0);
    } finally {
      root.toggleAttribute("data-renderer-inactive", wasInactive);
    }
  },
};

export const ClickKebabButton: Story = {
  args: undefined as never,
  render: () => renderSingleWorkspaceState(1),
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      const row = canvasElement.querySelector<HTMLElement>('[data-workspace-id="ws-active"]');
      if (!row) throw new Error("ws-active row not found");
    });

    const row = canvasElement.querySelector<HTMLElement>('[data-workspace-id="ws-active"]')!;
    await userEvent.hover(row);

    const kebabButton = row.querySelector<HTMLButtonElement>(
      'button[aria-label^="Workspace actions for"]'
    );
    if (!kebabButton) {
      throw new Error("workspace kebab button not found");
    }

    await userEvent.click(kebabButton);
    await screen.findByText("Generate new title");
  },
};
