import { within, waitFor } from "@storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef, useState } from "react";
import type { ComponentProps, ComponentType, FC, ReactNode } from "react";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ExperimentsProvider } from "@/browser/contexts/ExperimentsContext";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { createReview } from "@/browser/stories/helpers/reviews";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { TodoItem } from "@/common/types/tools";
import type { DiffHunk, Review } from "@/common/types/review";
import { extractAllHunks, parseDiff } from "@/common/utils/git/diffParser";
import {
  buildFileTree,
  extractNewPath,
  parseNumstat,
  type FileTreeNode,
} from "@/common/utils/git/numstatParser";

import { ImmersiveReviewView } from "./ImmersiveReviewView";

const LINE_HEIGHT_DEBUG_WORKSPACE_ID = "ws-review-immersive-line-height";

const IMMERSIVE_REVIEW_COMPLETE_WORKSPACE_ID = "ws-review-immersive-complete";

// Includes highlighted TypeScript lines and neutral/context lines so row-height
// differences are easy to compare while debugging immersive review rendering.
const IMMERSIVE_LINE_HEIGHT_DIFF = `diff --git a/src/utils/formatPrice.ts b/src/utils/formatPrice.ts
index 1111111..2222222 100644
--- a/src/utils/formatPrice.ts
+++ b/src/utils/formatPrice.ts
@@ -1,10 +1,15 @@
 export function formatPrice(amount: number, currency = "USD"): string {
+  const formatter = new Intl.NumberFormat("en-US", {
+    style: "currency",
+    currency,
+  });
+
   if (!Number.isFinite(amount)) {
-    return "$0.00";
+    return formatter.format(0);
   }

-  return amount.toFixed(2);
+  return formatter.format(amount);
 }

 // Keep this context line unchanged for neutral-row comparison.
 export const DEFAULT_LOCALE = "en-US";
`;

const IMMERSIVE_LINE_HEIGHT_NUMSTAT = "7\t2\tsrc/utils/formatPrice.ts";

const IMMERSIVE_NOTES_PREVIEW_WORKSPACE_ID = "ws-review-immersive-notes-preview";
const IMMERSIVE_NOTES_PREVIEW_BASE_TIME = 1700000000000;

const HIGHLIGHT_VS_PLAIN_WORKSPACE_ID = "ws-review-immersive-highlight-vs-plain";
const HIGHLIGHT_FALLBACK_THRESHOLD_BYTES = 32 * 1024;
const HIGHLIGHT_FALLBACK_BUFFER_BYTES = 1024;
const HIGHLIGHT_VS_PLAIN_NUMSTAT = "3\t2\tsrc/review/lineHeightProbe.ts";

const IMMERSIVE_MINIMAP_WORKSPACE_ID = "ws-review-immersive-minimap";
const IMMERSIVE_MINIMAP_NUMSTAT = "5\t5\tsrc/review/minimapProbe.ts";
const IMMERSIVE_FIRST_SEEN_BASE_TIME = 1700000005000;

function buildMinimapDiffOutput(): string {
  const hunkLines: string[] = [];

  for (let lineNumber = 1; lineNumber <= 55; lineNumber += 1) {
    if (lineNumber % 11 === 0) {
      hunkLines.push(`-const previousLine${lineNumber} = createProbe(${lineNumber}, "old");`);
      hunkLines.push(`+const nextLine${lineNumber} = createProbe(${lineNumber}, "new");`);
      continue;
    }

    hunkLines.push(` const sharedLine${lineNumber} = createProbe(${lineNumber}, "context");`);
  }

  return [
    "diff --git a/src/review/minimapProbe.ts b/src/review/minimapProbe.ts",
    "index 9999999..aaaaaaa 100644",
    "--- a/src/review/minimapProbe.ts",
    "+++ b/src/review/minimapProbe.ts",
    "@@ -1,55 +1,55 @@",
    ...hunkLines,
    "",
  ].join("\n");
}

function buildHighlightVsPlainDiffOutput(): string {
  const oversizedContextLines: string[] = [];
  let contextBytes = 0;
  let lineIndex = 0;

  // Keep adding context lines until this single context chunk exceeds the
  // 32kb highlight limit, forcing plain/fallback rendering for those rows.
  while (contextBytes <= HIGHLIGHT_FALLBACK_THRESHOLD_BYTES + HIGHLIGHT_FALLBACK_BUFFER_BYTES) {
    const contextLine =
      `const fallbackProbe${lineIndex.toString().padStart(4, "0")} = createProbeEntry(` +
      `"fallback-${lineIndex}", { index: ${lineIndex}, mode: "plain-context-chunk" });`;
    oversizedContextLines.push(` ${contextLine}`);
    contextBytes += contextLine.length + 1;
    lineIndex += 1;
  }

  return [
    "diff --git a/src/review/lineHeightProbe.ts b/src/review/lineHeightProbe.ts",
    "index abcdef1..1234567 100644",
    "--- a/src/review/lineHeightProbe.ts",
    "+++ b/src/review/lineHeightProbe.ts",
    "@@ -1,8 +1,9 @@",
    "-export const BASE_ROW_HEIGHT = 20;",
    "+export const BASE_ROW_HEIGHT = 22;",
    '+export const ROW_HEIGHT_MODE = "immersive";',
    " export function resolveRowHeight(scale = 1): number {",
    "   return BASE_ROW_HEIGHT * scale;",
    " }",
    ...oversizedContextLines,
    '-export const ROW_HEIGHT_LABEL = "compact";',
    '+export const ROW_HEIGHT_LABEL = "immersive";',
    "",
  ].join("\n");
}

interface ImmersiveStoryFixture {
  fileTree: FileTreeNode | null;
  hunks: DiffHunk[];
  allHunks: DiffHunk[];
  reviewsByFilePath: Map<string, Review[]>;
  firstSeenMap: Record<string, number>;
}

function buildReviewsByFilePath(reviews: Review[]): Map<string, Review[]> {
  const grouped = new Map<string, Review[]>();

  for (const review of reviews) {
    const existing = grouped.get(review.data.filePath);
    if (existing) {
      existing.push(review);
    } else {
      grouped.set(review.data.filePath, [review]);
    }
  }

  return grouped;
}

function parseImmersiveFixture(
  diffOutput: string,
  numstatOutput: string
): {
  fileTree: FileTreeNode | null;
  hunks: DiffHunk[];
} {
  // Keep fixture parsing aligned with production review parsing so isolated stories
  // receive the same hunk and file-tree shapes as the app-level flow.
  const fileDiffs = parseDiff(diffOutput);
  const hunks = extractAllHunks(fileDiffs);

  const fileDiffByPath = new Map(
    fileDiffs.map((fileDiff) => [extractNewPath(fileDiff.filePath), fileDiff])
  );
  const fileStats = parseNumstat(numstatOutput).map((stat) => {
    const fileDiff = fileDiffByPath.get(extractNewPath(stat.filePath));

    return {
      ...stat,
      changeType: fileDiff?.changeType ?? "modified",
      oldPath: fileDiff?.oldPath,
    };
  });

  return {
    fileTree: fileStats.length > 0 ? buildFileTree(fileStats) : null,
    hunks,
  };
}

function getDiffHunkIds(diffOutput: string): string[] {
  return extractAllHunks(parseDiff(diffOutput)).map((hunk) => hunk.id);
}

function buildImmersiveFixture(options: {
  diffOutput: string;
  numstatOutput: string;
  reviews?: Review[];
}): ImmersiveStoryFixture {
  const parsed = parseImmersiveFixture(options.diffOutput, options.numstatOutput);
  const reviewsByFilePath = buildReviewsByFilePath(options.reviews ?? []);

  const firstSeenMap: Record<string, number> = {};
  for (const [index, hunk] of parsed.hunks.entries()) {
    firstSeenMap[hunk.id] = IMMERSIVE_FIRST_SEEN_BASE_TIME + index;
  }

  return {
    fileTree: parsed.fileTree,
    hunks: parsed.hunks,
    allHunks: parsed.hunks,
    reviewsByFilePath,
    firstSeenMap,
  };
}

const IMMERSIVE_NOTES_REVIEWS = [
  createReview(
    "review-footer-1",
    "src/utils/formatPrice.ts",
    "1-4",
    "Keep the formatter instance shared so the fallback and regular output stay aligned when the currency changes.",
    "pending",
    IMMERSIVE_NOTES_PREVIEW_BASE_TIME + 1
  ),
  createReview(
    "review-footer-2",
    "src/utils/formatPrice.ts",
    "6-8",
    "The shorter note makes it easier to compare where each card footer lands.",
    "checked",
    IMMERSIVE_NOTES_PREVIEW_BASE_TIME + 2
  ),
];

const LINE_HEIGHT_FIXTURE = buildImmersiveFixture({
  diffOutput: IMMERSIVE_LINE_HEIGHT_DIFF,
  numstatOutput: IMMERSIVE_LINE_HEIGHT_NUMSTAT,
});

const IMMERSIVE_REVIEW_COMPLETE_FIXTURE: ImmersiveStoryFixture = {
  ...buildImmersiveFixture({
    diffOutput: IMMERSIVE_LINE_HEIGHT_DIFF,
    numstatOutput: IMMERSIVE_LINE_HEIGHT_NUMSTAT,
  }),
  hunks: [],
};

const IMMERSIVE_REVIEW_COMPLETE_HUNK_IDS = getDiffHunkIds(IMMERSIVE_LINE_HEIGHT_DIFF);

const IMMERSIVE_NOTES_FIXTURE = buildImmersiveFixture({
  diffOutput: IMMERSIVE_LINE_HEIGHT_DIFF,
  numstatOutput: IMMERSIVE_LINE_HEIGHT_NUMSTAT,
  reviews: IMMERSIVE_NOTES_REVIEWS,
});

const HIGHLIGHT_VS_PLAIN_FIXTURE = buildImmersiveFixture({
  diffOutput: buildHighlightVsPlainDiffOutput(),
  numstatOutput: HIGHLIGHT_VS_PLAIN_NUMSTAT,
});

const MINIMAP_FIXTURE = buildImmersiveFixture({
  diffOutput: buildMinimapDiffOutput(),
  numstatOutput: IMMERSIVE_MINIMAP_NUMSTAT,
});

function createImmersiveStoryClient(): APIClient {
  return createMockORPCClient({
    executeBash: () =>
      Promise.resolve({
        success: true,
        output: "",
        exitCode: 0,
        wall_duration_ms: 0,
      }),
  });
}

interface AgentStatusSeed {
  /**
   * TODO plan the agent has written (drives the horizontal TODO strip +
   * summary). Omit (or pass an empty array) to model "streaming before any plan
   * is written", where the bar shows only the streaming chip.
   */
  todos?: TodoItem[];
  /**
   * When true, leaves the seeded stream open so the bar shows the live
   * "Streaming…" chip. When false the stream is left un-started, so only the
   * persisted (incomplete) plan shows.
   */
  streaming?: boolean;
}

/**
 * Register a workspace in the singleton WorkspaceStore and push a `todo_write`
 * tool call through its aggregator so the immersive view's
 * ImmersiveReviewAgentStatusBar has real plan + streaming state to render.
 * Seeds exactly once per workspace (addWorkspace is idempotent and the stream
 * events are replayed only when the aggregator is freshly created), and runs
 * during render before the child subscribes so the bar paints populated on the
 * first frame (flash-free for snapshots).
 */
function seedAgentStatus(
  workspaceStore: ReturnType<typeof useWorkspaceStoreRaw>,
  workspaceId: string,
  seed: AgentStatusSeed
): void {
  const alreadyRegistered = workspaceStore.hasRegisteredWorkspace(workspaceId);
  workspaceStore.addWorkspace({
    id: workspaceId,
    name: workspaceId,
    projectName: "story-project",
    projectPath: "/story/project",
    namedWorkspacePath: "/story/workspace",
    createdAt: new Date(0).toISOString(),
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
  });
  if (alreadyRegistered) {
    return;
  }

  const aggregator = workspaceStore.getAggregator(workspaceId);
  if (!aggregator) {
    return;
  }

  const messageId = `${workspaceId}-stream`;
  aggregator.handleStreamStart({
    type: "stream-start",
    workspaceId,
    messageId,
    historySequence: 1,
    model: "anthropic:claude-sonnet-4",
    startTime: 0,
  });
  // Only push a plan when the seed has one; omitting it models "streaming
  // before any TODO is written" so the bar renders the chip-only state.
  if (seed.todos && seed.todos.length > 0) {
    aggregator.handleToolCallStart({
      type: "tool-call-start",
      workspaceId,
      messageId,
      toolCallId: `${workspaceId}-todo`,
      toolName: "todo_write",
      args: { todos: seed.todos },
      tokens: 10,
      timestamp: 1,
    });
    aggregator.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId,
      messageId,
      toolCallId: `${workspaceId}-todo`,
      toolName: "todo_write",
      result: { success: true },
      timestamp: 2,
    });
  }
  if (seed.streaming !== true) {
    // Collapse the active stream so the chip clears; incomplete todos persist.
    aggregator.clearActiveStreams();
  }
}

const ImmersiveStoryShell: FC<{ client: APIClient; children: ReactNode }> = ({
  client,
  children,
}) => {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <APIProvider client={client}>
          <ExperimentsProvider>{children}</ExperimentsProvider>
        </APIProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
};

interface ImmersiveReviewStoryProps {
  workspaceId: string;
  fixture: ImmersiveStoryFixture;
  reviewActions?: ComponentProps<typeof ImmersiveReviewView>["reviewActions"];
  initialReadHunkIds?: string[];
  /** Hunk IDs flagged by the agent (via `review_pane_update`). */
  assistedHunkIds?: ReadonlySet<string>;
  /** Per-hunk agent comments — drives the immersive assisted-review banner. */
  assistedCommentByHunkId?: Map<string, string>;
  /** Whether the Assisted worklist filter is active — drives the header badge. */
  assistedOnly?: boolean;
  assistedCount?: number;
  assistedUnreadCount?: number;
  /**
   * Seeds the singleton WorkspaceStore so the immersive view's top status bar
   * (ImmersiveReviewAgentStatusBar) renders a real TODO plan + streaming chip.
   */
  agentStatusSeed?: AgentStatusSeed;
}

function ImmersiveReviewStory(props: ImmersiveReviewStoryProps) {
  const client = useRef(createImmersiveStoryClient()).current;
  const [selectedHunkId, setSelectedHunkId] = useState<string | null>(
    props.fixture.hunks[0]?.id ?? null
  );
  const [readHunkIds, setReadHunkIds] = useState<Set<string>>(
    () => new Set(props.initialReadHunkIds ?? [])
  );

  // Seed agent status synchronously during render (before the child subscribes)
  // so the top status bar paints with its plan/stream on the first frame.
  const workspaceStore = useWorkspaceStoreRaw();
  if (props.agentStatusSeed) {
    seedAgentStatus(workspaceStore, props.workspaceId, props.agentStatusSeed);
  }

  return (
    <ImmersiveStoryShell client={client}>
      <ImmersiveReviewView
        workspaceId={props.workspaceId}
        fileTree={props.fixture.fileTree}
        hunks={props.fixture.hunks}
        allHunks={props.fixture.allHunks}
        isRead={(hunkId) => readHunkIds.has(hunkId)}
        onToggleRead={(hunkId) => {
          setReadHunkIds((previousReadHunks) => {
            const nextReadHunks = new Set(previousReadHunks);
            if (nextReadHunks.has(hunkId)) {
              nextReadHunks.delete(hunkId);
            } else {
              nextReadHunks.add(hunkId);
            }
            return nextReadHunks;
          });
        }}
        onMarkFileAsRead={(hunkId) => {
          setReadHunkIds((previousReadHunks) => {
            if (previousReadHunks.has(hunkId)) {
              return previousReadHunks;
            }

            const nextReadHunks = new Set(previousReadHunks);
            nextReadHunks.add(hunkId);
            return nextReadHunks;
          });
        }}
        selectedHunkId={selectedHunkId}
        onSelectHunk={setSelectedHunkId}
        onExit={() => {
          // noop for isolated story playback
        }}
        reviewActions={props.reviewActions}
        reviewsByFilePath={props.fixture.reviewsByFilePath}
        firstSeenMap={props.fixture.firstSeenMap}
        assistedHunkIds={props.assistedHunkIds}
        assistedCommentByHunkId={props.assistedCommentByHunkId}
        assistedOnly={props.assistedOnly}
        assistedCount={props.assistedCount}
        assistedUnreadCount={props.assistedUnreadCount}
      />
    </ImmersiveStoryShell>
  );
}

const meta: Meta<typeof ImmersiveReviewView> = {
  title: "Features/RightSidebar/CodeReview/ImmersiveReviewView",
  component: ImmersiveReviewView,
  decorators: [
    (Story: ComponentType) => (
      <div style={{ width: 1600, height: "100dvh" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    pixel: {
      // Wide variant: these stories need >=1600px, so use the 1900px desktop viewport.
      matrix: { themes: ["dark", "light"], viewports: ["desktop"] },
    },
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

export const ReviewTabImmersiveLineHeightDebug: Story = {
  render: () => (
    <ImmersiveReviewStory
      workspaceId={LINE_HEIGHT_DEBUG_WORKSPACE_ID}
      fixture={LINE_HEIGHT_FIXTURE}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(
      () => {
        canvas.getByTestId("immersive-review-view");
        canvas.getByRole("button", { name: /exit immersive review/i });
      },
      { timeout: 10_000 }
    );
  },
};

export const ImmersiveReviewComplete: Story = {
  render: () => (
    <ImmersiveReviewStory
      workspaceId={IMMERSIVE_REVIEW_COMPLETE_WORKSPACE_ID}
      fixture={IMMERSIVE_REVIEW_COMPLETE_FIXTURE}
      initialReadHunkIds={IMMERSIVE_REVIEW_COMPLETE_HUNK_IDS}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(
      () => {
        canvas.getByTestId("immersive-review-complete");
        canvas.getByRole("heading", { name: /Review complete/i });
        canvas.getByRole("button", { name: /Return to chat/i });
        if (canvas.queryByText(/No hunks for this file/i)) {
          throw new Error(
            "Expected the immersive review completion state instead of the empty-file copy."
          );
        }
      },
      { timeout: 10_000 }
    );
  },
};

export const ImmersiveNotesSidebarActionFooter: Story = {
  render: () => (
    <ImmersiveReviewStory
      workspaceId={IMMERSIVE_NOTES_PREVIEW_WORKSPACE_ID}
      fixture={IMMERSIVE_NOTES_FIXTURE}
      reviewActions={{
        onDelete: () => {
          // noop for story interaction state
        },
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(
      () => {
        canvas.getByTestId("immersive-review-view");
        if (canvas.queryAllByText(/Keep the formatter instance shared/i).length === 0) {
          throw new Error("Expected the immersive review formatter note to render.");
        }
      },
      { timeout: 10_000 }
    );

    const noteCard = canvasElement.querySelector<HTMLElement>('[data-note-index="0"]');
    if (!noteCard) {
      throw new Error("Expected the first immersive review note card to render.");
    }

    // Focus the first card so Storybook captures the reserved footer state that prevents
    // the note preview layout from shifting when review actions appear. Focus is more
    // deterministic than hover in the CI interaction runner while exercising the same UI.
    noteCard.focus();

    await waitFor(() => {
      const deleteButton = noteCard.querySelector<HTMLButtonElement>(
        'button[aria-label="Delete review note"]'
      );
      if (!deleteButton) {
        throw new Error("Expected the focused note card to include a delete action.");
      }

      const computedStyle = window.getComputedStyle(deleteButton);
      if (computedStyle.visibility !== "visible" || computedStyle.opacity !== "1") {
        throw new Error("Expected the note footer action to be visible after focusing the card.");
      }
    });
  },
};

export const ReviewTabImmersiveHighlightVsPlainHeight: Story = {
  render: () => (
    <ImmersiveReviewStory
      workspaceId={HIGHLIGHT_VS_PLAIN_WORKSPACE_ID}
      fixture={HIGHLIGHT_VS_PLAIN_FIXTURE}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(
      () => {
        canvas.getByTestId("immersive-review-view");
        canvas.getByRole("button", { name: /exit immersive review/i });
      },
      { timeout: 10_000 }
    );
  },
};

export const ImmersiveWithMinimap: Story = {
  render: () => (
    <ImmersiveReviewStory workspaceId={IMMERSIVE_MINIMAP_WORKSPACE_ID} fixture={MINIMAP_FIXTURE} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(
      () => {
        canvas.getByTestId("immersive-review-view");
        canvas.getByRole("button", { name: /exit immersive review/i });
      },
      { timeout: 10_000 }
    );
  },
};

const IMMERSIVE_ASSISTED_WORKSPACE_ID = "ws-review-immersive-assisted";
const IMMERSIVE_ASSISTED_FIXTURE = LINE_HEIGHT_FIXTURE;
const IMMERSIVE_ASSISTED_FIRST_HUNK_ID = IMMERSIVE_ASSISTED_FIXTURE.hunks[0]?.id ?? "";
const IMMERSIVE_ASSISTED_HUNK_IDS: ReadonlySet<string> = new Set([
  IMMERSIVE_ASSISTED_FIRST_HUNK_ID,
]);
// Map literal lookup matches production — ImmersiveReviewView reads the comment
// for the *selected* hunk and renders the assisted banner above the diff.
const IMMERSIVE_ASSISTED_COMMENT_BY_HUNK_ID = new Map<string, string>([
  [
    IMMERSIVE_ASSISTED_FIRST_HUNK_ID,
    "Hoist the formatter out of formatPrice — recreating it on every call defeats the Intl.NumberFormat cache.",
  ],
]);

/**
 * Immersive review with an active assisted-review pin. Locks in the
 * `--color-review-accent` blue accent for the immersive banner (Sparkles +
 * border + background tint) in both light + dark themes.
 */
export const ImmersiveWithAssistedBanner: Story = {
  render: () => (
    <ImmersiveReviewStory
      workspaceId={IMMERSIVE_ASSISTED_WORKSPACE_ID}
      fixture={IMMERSIVE_ASSISTED_FIXTURE}
      assistedHunkIds={IMMERSIVE_ASSISTED_HUNK_IDS}
      assistedCommentByHunkId={IMMERSIVE_ASSISTED_COMMENT_BY_HUNK_ID}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(
      () => {
        canvas.getByTestId("immersive-review-view");
        canvas.getByTestId("immersive-assisted-banner");
      },
      { timeout: 10_000 }
    );
  },
};

/**
 * Immersive review with the Assisted worklist filter active. Locks in the
 * header "Assisted unread/total" badge (Sparkles + review-accent) that tells
 * the user the diff is filtered to agent-flagged hunks — the control bar that
 * normally hosts this toggle is hidden behind the immersive overlay.
 */
export const ImmersiveWithAssistedMode: Story = {
  render: () => (
    <ImmersiveReviewStory
      workspaceId={IMMERSIVE_ASSISTED_WORKSPACE_ID}
      fixture={IMMERSIVE_ASSISTED_FIXTURE}
      assistedHunkIds={IMMERSIVE_ASSISTED_HUNK_IDS}
      assistedCommentByHunkId={IMMERSIVE_ASSISTED_COMMENT_BY_HUNK_ID}
      assistedOnly
      assistedCount={3}
      assistedUnreadCount={2}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(
      () => {
        canvas.getByTestId("immersive-review-view");
        canvas.getByTestId("immersive-assisted-mode-badge");
      },
      { timeout: 10_000 }
    );
  },
};

const IMMERSIVE_AGENT_STATUS_WORKSPACE_ID = "ws-review-immersive-agent-status";
const IMMERSIVE_AGENT_STATUS_TODOS: TodoItem[] = [
  { content: "Audit immersive review layout", status: "completed" },
  { content: "Scope assisted comment to the diff column", status: "completed" },
  { content: "Add the top status bar (TODO + streaming)", status: "in_progress" },
  { content: "Wire up flash-free loading states", status: "pending" },
  { content: "Add Storybook + tests", status: "pending" },
];

/**
 * Immersive review with the top agent status bar populated: the agent's TODO
 * plan as a horizontal strip plus the live "Streaming…" chip. This is the piece
 * that keeps chat status visible while the user reviews code behind the
 * full-screen overlay. Seeds the WorkspaceStore so the bar has real state.
 */
export const ImmersiveWithAgentStatusBar: Story = {
  render: () => (
    <ImmersiveReviewStory
      workspaceId={IMMERSIVE_AGENT_STATUS_WORKSPACE_ID}
      fixture={LINE_HEIGHT_FIXTURE}
      agentStatusSeed={{ todos: IMMERSIVE_AGENT_STATUS_TODOS, streaming: true }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(
      () => {
        canvas.getByTestId("immersive-review-view");
        // The single-line TODO bar + its inline horizontal plan strip render.
        canvas.getByTestId("immersive-agent-status-bar");
        canvas.getByText("Add the top status bar (TODO + streaming)");
        // Live streaming chip is visible alongside the plan.
        canvas.getByText("Streaming…");
      },
      { timeout: 10_000 }
    );
  },
};

const IMMERSIVE_STREAMING_NO_TODO_WORKSPACE_ID = "ws-review-immersive-streaming-no-todo";

/**
 * Immersive review while the agent is streaming but has not written a TODO plan
 * yet. Locks in the chip-only state of the status bar: with no plan on the left
 * the "Streaming…" chip is left-aligned (reads as a status label) instead of
 * floating alone on the far right of an otherwise-empty bar, and the bar stays
 * a single row tall. Seeds an open stream with no `todo_write` call.
 */
export const ImmersiveWithStreamingNoTodo: Story = {
  render: () => (
    <ImmersiveReviewStory
      workspaceId={IMMERSIVE_STREAMING_NO_TODO_WORKSPACE_ID}
      fixture={LINE_HEIGHT_FIXTURE}
      agentStatusSeed={{ streaming: true }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(
      () => {
        canvas.getByTestId("immersive-review-view");
        // The bar renders the streaming chip with no TODO label/plan.
        canvas.getByTestId("immersive-agent-status-bar");
        canvas.getByText("Streaming…");
        if (canvas.queryByText("TODO")) {
          throw new Error("Expected the chip-only status bar with no TODO plan.");
        }
      },
      { timeout: 10_000 }
    );
  },
};
