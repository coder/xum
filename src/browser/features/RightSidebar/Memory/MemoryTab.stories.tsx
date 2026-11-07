import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { APIProvider } from "@/browser/contexts/API";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { blurActiveElement } from "@/browser/stories/storyPlayHelpers.js";
import type {
  MemoryConsolidationRecordPayload,
  MemoryConsolidationStatusPayload,
  MemoryFileInfo,
  MemoryHarvestRecordPayload,
} from "@/common/orpc/schemas/memory";

import { EXPERIMENT_IDS } from "@/common/constants/experiments";
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

const PREFERENCES_CONTENT = `---
description: Coding style and tooling preferences
---
# Preferences

- Use \`bun\` for every package script.
- Keep diffs small and reviewable.
- Prefer \`rg\` over \`grep\` when searching.

## Validation

\`\`\`bash
make static-check
\`\`\`
`;

const CONSOLIDATION_RECORD: MemoryConsolidationRecordPayload = {
  lastRunAt: Date.now() - 30 * 60 * 1000,
  trigger: "manual",
  summary: "Merged duplicate project notes",
  ops: [{ command: "delete", path: "/memories/project/duplicate.md", applied: true }],
};

const HARVEST_RECORD: MemoryHarvestRecordPayload = {
  status: "completed",
  startedAt: Date.now() - 45 * 60 * 1000,
  completedAt: Date.now() - 44 * 60 * 1000,
  attemptCount: 1,
  boundaryKey: "summary-story",
  compactionEpoch: 3,
  acceptedCandidates: 2,
  skippedCandidates: 1,
  nextChunk: 1,
  ops: [
    { command: "create", path: "/memories/workspace/build.md", applied: true },
    { command: "str_replace", path: "/memories/workspace/build.md", applied: true },
    {
      command: "create",
      path: "/memories/global/build.md",
      applied: false,
      note: "Consolidation may not modify /memories/global/build.md",
    },
  ],
};

const DEFAULT_STATUS: MemoryConsolidationStatusPayload = {
  workspaceRecord: null,
  projectRecord: CONSOLIDATION_RECORD,
  globalRecord: CONSOLIDATION_RECORD,
  latestHarvestRecord: HARVEST_RECORD,
  projectAvailable: true,
};

// The Memory tab lives in the narrow right sidebar, so pin the story to a
// sidebar-like width (also exercises the ~375px mobile layout contract).
function renderTab(
  width: string,
  status: Partial<MemoryConsolidationStatusPayload> = {},
  consolidateError?: string
) {
  return (
    <APIProvider
      client={createMockORPCClient({
        experiments: { [EXPERIMENT_IDS.MEMORY_CONSOLIDATION]: true },
        memoryFiles: MEMORY_FILES,
        memoryFileContents: new Map([["/memories/global/preferences.md", PREFERENCES_CONTENT]]),
        memoryConsolidationStatus: { ...DEFAULT_STATUS, ...status },
        memoryConsolidateError: consolidateError,
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
    await canvas.findByText("Harvest: completed: 2 edits / 1 rejected");
    await canvas.findByText("scratch.md");
  },
};

export const Editor: Story = {
  render: () => renderTab("360px"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = await canvas.findByText("preferences.md");
    await userEvent.click(row);
    // Markdown files open in the rendered preview, frontmatter as a yaml block.
    await canvas.findByRole("heading", { name: "Preferences" });
    // Wait for Shiki tokens so the snapshot never captures unhighlighted code.
    await waitFor(() => {
      for (const language of ["yaml", "bash"]) {
        if (!canvasElement.querySelector(`[data-code-language="${language}"] .code-line span`)) {
          throw new Error(`${language} block is not highlighted yet`);
        }
      }
    });
    await expect(canvas.queryByRole("textbox", { name: "Memory file content" })).toBeNull();
    // Pixel does not emulate touch, so pin the class that hides the shortcut on touch screens.
    const toggle = canvas.getByRole("button", { name: "Preview" });
    await userEvent.hover(toggle);
    const tooltip = await within(document.body).findByRole("tooltip");
    await expect(tooltip.querySelector(".mobile-hide-shortcut-hints")).not.toBeNull();
    await userEvent.unhover(toggle);
    // Radix keeps a hoverable tooltip open after pointerleave until a pointermove leaves its
    // grace area, which a synthetic unhover never sends, so close it with Escape.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(within(document.body).queryByRole("tooltip")).toBeNull());
    await userEvent.hover(canvasElement);
    blurActiveElement();
  },
};

const CEILING_REASON = "estimate 4.06 USD (an upper bound) is over the 1.00 USD ceiling";

// A touch screen cannot open the tooltip that also holds the reason, so the line itself must show
// all of it: a truncated alert read "Dream stopped 2 minutes ago: estimate 4.06 USD (an up…".
export const DreamRefusedAtPhoneWidth: Story = {
  parameters: {
    // The play assertion pins the wrap; a snapshot of the same tab adds budget, not coverage.
    pixel: { exclude: true },
  },
  render: () =>
    renderTab(
      "375px",
      {
        latestRefusal: {
          at: Date.now() - 2 * 60 * 1000,
          reason: CEILING_REASON,
          estimatedUsd: 4.06,
        },
        latestHarvestRecord: {
          ...HARVEST_RECORD,
          status: "failed",
          error: CEILING_REASON,
        },
      },
      // The manual run's refusal: the same reason behind the organizer's own prefix.
      `consolidation not started: ${CEILING_REASON}`
    ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const alerts = await canvas.findAllByRole("alert");
    await expect(alerts).toHaveLength(2);
    // The third line appears once the manual run is refused.
    await userEvent.click(canvas.getByRole("button", { name: "Consolidate now" }));
    const runError = await canvas.findByText(/^consolidation not started: /);
    for (const line of [...alerts, runError]) {
      await expect(line.textContent).toContain("over the 1.00 USD ceiling");
      // Clipped text has more content than box: scrollWidth passes clientWidth.
      await expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);
      // Wrapped onto a second line, so it is taller than one 12px text line.
      await expect(line.getBoundingClientRect().height).toBeGreaterThan(20);
    }
  },
};

// A completed run that read only part of its epoch says so at the end of the harvest line. On a
// touch screen that note has no tooltip to fall back on, so a clipped line hides it.
export const HarvestNoteAtPhoneWidth: Story = {
  parameters: {
    // The play assertion pins the wrap; a snapshot of the same tab adds budget, not coverage.
    pixel: { exclude: true },
  },
  render: () =>
    renderTab("375px", {
      latestHarvestRecord: {
        ...HARVEST_RECORD,
        note: "edit budget spent: chunks 2-3 of 3 were not read",
      },
    }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const line = await canvas.findByText(/^Harvest: completed/);
    await expect(line.textContent).toContain("chunks 2-3 of 3 were not read");
    // Clipped text has more content than box: scrollWidth passes clientWidth.
    await expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);
    // Wrapped onto a second line, so it is taller than one 12px text line.
    await expect(line.getBoundingClientRect().height).toBeGreaterThan(20);
  },
};
