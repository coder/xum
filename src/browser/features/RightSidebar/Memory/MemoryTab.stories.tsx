import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "@storybook/test";

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { APIProvider } from "@/browser/contexts/API";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { blurActiveElement } from "@/browser/stories/storyPlayHelpers.js";
import type {
  MemoryConsolidationRecordPayload,
  MemoryFileInfo,
} from "@/common/orpc/schemas/memory";

import { EXPERIMENT_IDS, getExperimentKey } from "@/common/constants/experiments";
import { MemoryTab } from "./MemoryTab";

const meta: Meta<typeof MemoryTab> = {
  title: "Features/RightSidebar/MemoryTab",
  component: MemoryTab,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof meta>;

const STORY_WORKSPACE_ID = "ws-story-memorytab";

// Multi-file fixture covering every row permutation the tree cares about:
// all three scopes, root files, a dir with multiple files, two-level nesting,
// a pinned file, with/without descriptions, and used/never-used usage stats.
const MEMORY_FILES: MemoryFileInfo[] = [
  {
    path: "/memories/global/preferences.md",
    scope: "global",
    description: "Coding style and tooling preferences",
    pinned: true,
    accessCount: 12,
    lastAccessedAt: Date.now() - 3_600_000,
  },
  {
    path: "/memories/global/people/reviewers.md",
    scope: "global",
    description: "Preferred reviewers per code area",
    pinned: false,
    accessCount: 3,
    lastAccessedAt: Date.now() - 86_400_000,
  },
  {
    path: "/memories/global/people/teammates.md",
    scope: "global",
    description: "Working agreements with teammates",
    pinned: false,
    accessCount: 0,
    lastAccessedAt: null,
  },
  {
    path: "/memories/global/projects/mux/architecture.md",
    scope: "global",
    description: "High-level architecture notes",
    pinned: false,
    accessCount: 5,
    lastAccessedAt: Date.now() - 600_000,
  },
  {
    path: "/memories/project/conventions.md",
    scope: "project",
    description: "Repo conventions distilled from AGENTS.md",
    pinned: false,
    accessCount: 7,
    lastAccessedAt: Date.now() - 7_200_000,
  },
  {
    path: "/memories/project/testing.md",
    scope: "project",
    description: "",
    pinned: false,
    accessCount: 0,
    lastAccessedAt: null,
  },
  {
    path: "/memories/workspace/scratch.md",
    scope: "workspace",
    description: "Notes for the current branch work",
    pinned: false,
    accessCount: 1,
    lastAccessedAt: Date.now() - 60_000,
  },
];

const CONSOLIDATION_RECORD: MemoryConsolidationRecordPayload = {
  lastRunAt: Date.now() - 30 * 60 * 1000,
  trigger: "manual",
  summary: "Merged duplicate project notes",
  ops: [{ command: "delete", path: "/memories/project/duplicate.md", applied: true }],
};

// The Memory tab lives in the narrow right sidebar, so pin the story to a
// sidebar-like width (also exercises the ~375px mobile layout contract).
function renderTab(width: string) {
  updatePersistedState(getExperimentKey(EXPERIMENT_IDS.MEMORY_CONSOLIDATION), true);
  return (
    <APIProvider
      client={createMockORPCClient({
        memoryFiles: MEMORY_FILES,
        memoryConsolidationStatus: {
          workspaceRecord: null,
          projectRecord: CONSOLIDATION_RECORD,
          globalRecord: CONSOLIDATION_RECORD,
          latestHarvestRecord: {
            status: "completed",
            startedAt: Date.now() - 45 * 60 * 1000,
            completedAt: Date.now() - 44 * 60 * 1000,
            attemptCount: 1,
            boundaryKey: "summary-story",
            compactionEpoch: 3,
            acceptedCandidates: 2,
            skippedCandidates: 1,
          },
          projectAvailable: true,
        },
      })}
    >
      <div className="border-border-light h-[480px] border" style={{ width }}>
        <MemoryTab workspaceId={STORY_WORKSPACE_ID} />
      </div>
    </APIProvider>
  );
}

export const List: Story = {
  parameters: {
    pixel: {
      // Duplicates the same tree permutations covered by Settings/MemorySection.WithFiles, while
      // Chromium rasterizes its nested rounded borders/chevrons nondeterministically.
      exclude: true,
    },
  },
  render: () => renderTab("360px"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("preferences.md");
    await canvas.findByText(/Project:/);
    await canvas.findByText(/Harvest: completed/);
    await canvas.findByText("scratch.md");
  },
};

export const Editor: Story = {
  render: () => renderTab("360px"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = await canvas.findByText("preferences.md");
    await userEvent.click(row);
    await canvas.findByLabelText("Memory file content");
    // Hide the focused textarea caret before Pixel captures the editor state.
    await userEvent.hover(canvasElement);
    blurActiveElement();
  },
};
