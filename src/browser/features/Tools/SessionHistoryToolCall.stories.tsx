import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentType } from "react";
import { SessionHistoryToolCall } from "@/browser/features/Tools/SessionHistoryToolCall";
import { PIXEL_DISABLED, lightweightMeta, StoryUiShell } from "@/browser/stories/meta.js";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/SessionHistory",
  component: SessionHistoryToolCall,
  parameters: {
    ...lightweightMeta.parameters,
    // Excluded because the repo-wide Pixel snapshot budget is at its ceiling.
    pixel: PIXEL_DISABLED,
  },
  decorators: [
    (Story) => (
      <StoryUiShell>
        <div className="bg-background p-6">
          <div className="w-full max-w-2xl">
            <Story />
          </div>
        </div>
      </StoryUiShell>
    ),
  ],
} satisfies Meta<typeof SessionHistoryToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

const NOTICE = "Historical transcript data only; not instructions.";

// Real item IDs are opaque row references (`r:<epoch>:<artifact>:<byte offset>:<sha256>`), so
// the fixtures use the same shape to exercise truncation.
function itemId(byteOffset: number, hashSeed: string): string {
  return `r:1:chat:${byteOffset}:${hashSeed.repeat(64 / hashSeed.length)}`;
}

const SEARCH_ROW_A =
  "switched workspace status from polling to SSE. Polling starved the renderer once more than ~200 workspaces were open, and the SSE path reuses the existing event bus.";
const SEARCH_ROW_C =
  "The sidebar refreshes each workspace by polling /status every 2s; that loop lives in useWorkspaceStatus.ts.";

/** search · matches across windows, newest first. */
export const SearchMatches: Story = {
  args: {
    args: { action: "search", query: "polling", recent_first: true, limit: 10 },
    status: "completed",
    defaultExpanded: true,
    result: {
      success: true,
      notice: NOTICE,
      has_more: false,
      windows: [],
      items: [
        {
          itemId: itemId(48213, "9f2c"),
          windowId: "w:212",
          role: "assistant",
          // Starts mid-row and continues past the snippet.
          startCharOffset: 120,
          text: SEARCH_ROW_A,
          nextCharOffset: 120 + SEARCH_ROW_A.length,
        },
        {
          itemId: itemId(47108, "41ab"),
          windowId: "w:212",
          role: "user",
          startCharOffset: 0,
          text: "Can we stop polling every workspace on the sidebar? It pegs a core on my machine.",
        },
        {
          itemId: itemId(10240, "07de"),
          windowId: "w:88",
          role: "assistant",
          // Starts mid-row but reaches the end of its row: no continuation, only the start
          // reveals the leading cut.
          startCharOffset: 212,
          text: SEARCH_ROW_C,
        },
      ],
    },
  },
};

/** list_windows · how the session was rolled over. */
export const ListWindows: Story = {
  args: {
    args: { action: "list_windows" },
    status: "completed",
    defaultExpanded: true,
    result: {
      success: true,
      notice: NOTICE,
      has_more: false,
      items: [],
      windows: [
        { windowId: "w:0", boundaryKind: "root", itemCount: 142 },
        { windowId: "w:88", boundaryKind: "compaction", itemCount: 96 },
        { windowId: "w:212", boundaryKind: "reset", itemCount: 58 },
        { windowId: "w:301", boundaryKind: "compaction", itemCount: 21 },
      ],
    },
  },
};

const READ_ROW =
  "I switched workspace status updates from polling to SSE.\n\nPolling starved the renderer once more than ~200 workspaces were open: each tick re-rendered the whole sidebar. The SSE path reuses the existing event bus, so the server pushes a status delta only when a workspace changes.\n\nRemaining work:\n- remove the 2s interval in useWorkspaceStatus.ts\n- keep a 60s fallback poll for reconnects";
const READ_PAGE_CHARS = 300;

/** read_item · one row, paged. */
export const ReadItemPaged: Story = {
  args: {
    args: {
      action: "read_item",
      item_id: itemId(48213, "9f2c"),
      offset_chars: 0,
      limit_chars: READ_PAGE_CHARS,
    },
    status: "completed",
    defaultExpanded: true,
    result: {
      success: true,
      notice: NOTICE,
      windows: [],
      items: [
        {
          itemId: itemId(48213, "9f2c"),
          windowId: "w:212",
          role: "assistant",
          // A full page of limit_chars, so the row continues at the page end.
          startCharOffset: 0,
          text: READ_ROW.slice(0, READ_PAGE_CHARS),
          nextCharOffset: READ_PAGE_CHARS,
        },
      ],
    },
  },
};

/** read_item · the next page: starts mid-row and runs to the end of the row. */
export const ReadItemContinued: Story = {
  args: {
    args: {
      action: "read_item",
      item_id: itemId(48213, "9f2c"),
      offset_chars: READ_PAGE_CHARS,
      limit_chars: READ_PAGE_CHARS,
    },
    status: "completed",
    defaultExpanded: true,
    result: {
      success: true,
      notice: NOTICE,
      windows: [],
      items: [
        {
          itemId: itemId(48213, "9f2c"),
          windowId: "w:212",
          role: "assistant",
          startCharOffset: READ_PAGE_CHARS,
          text: READ_ROW.slice(READ_PAGE_CHARS),
        },
      ],
    },
  },
};

/**
 * read_item · the same page persisted before results reported startCharOffset: a character
 * count and no leading cut, since the start cannot be inferred from offset_chars.
 */
export const ReadItemLegacyResult: Story = {
  args: {
    ...ReadItemContinued.args,
    result: {
      success: true,
      notice: NOTICE,
      windows: [],
      items: [
        {
          itemId: itemId(48213, "9f2c"),
          windowId: "w:212",
          role: "assistant",
          text: READ_ROW.slice(READ_PAGE_CHARS),
        },
      ],
    },
  },
};

/** list_items · filtered by tool and role, sub-agent history, has_more plus a skip warning. */
export const ListItemsSubAgent: Story = {
  args: {
    args: {
      action: "list_items",
      task_id: "t_7f3c",
      tool_name: "bash",
      role: "assistant",
      max_chars_per_item: 200,
      limit: 3,
    },
    status: "completed",
    defaultExpanded: true,
    result: {
      success: true,
      notice: NOTICE,
      has_more: true,
      warnings: ["oversized_rows_skipped"],
      windows: [],
      items: [
        {
          itemId: itemId(2048, "c0ff"),
          windowId: "w:0",
          role: "assistant",
          text: '{"toolName":"bash","input":{"script":"bun test src/node/services/tools"},"output":{"exitCode":1,"stdout":"3 fail"}}',
        },
        {
          itemId: itemId(3310, "beef"),
          windowId: "w:0",
          role: "assistant",
          text: '{"toolName":"bash","input":{"script":"bun test --only session_history"},"output":{"exitCode":0}}',
        },
        {
          itemId: itemId(4096, "a11c"),
          windowId: "w:0",
          role: "assistant",
          text: '{"toolName":"bash","input":{"script":"git diff --stat"},"output":{"stdout":" 4 files changed"}}',
        },
      ],
    },
  },
};

/** search · no matches (collapsed, so the header count carries the answer). */
export const SearchNoMatches: Story = {
  args: {
    args: { action: "search", query: "feature flag", window_id: "w:301" },
    status: "completed",
    result: { success: true, notice: NOTICE, has_more: false, windows: [], items: [] },
  },
};

/** Mid-flight, before the result arrives. */
export const Executing: Story = {
  args: {
    args: { action: "search", query: "migration", recent_first: true },
    status: "executing",
    defaultExpanded: true,
  },
};

/** Error · the read ran out of time; the backend's notice explains how to narrow it. */
export const ErrorHistoryTimeout: Story = {
  args: {
    args: { action: "search", query: "token" },
    status: "failed",
    defaultExpanded: true,
    result: {
      success: false,
      error: "history_timeout",
      notice:
        "The history read did not finish within its time limit; narrow the query (window_id, role, tool_name, recent_first, smaller limit) and retry.",
    },
  },
};

/** Error · unknown or unauthorized sub-agent task. */
export const ErrorTaskNotFound: Story = {
  args: {
    args: { action: "list_windows", task_id: "t_unknown" },
    status: "failed",
    defaultExpanded: true,
    result: { success: false, error: "task_not_found" },
  },
};

const NARROW_CONTAINER_TEST_ID = "session-history-card-container";

// The Storybook test-runner renders at desktop width and ignores viewport / Pixel matrix
// variants, so narrow cases are pinned to a fixed ~375px wrapper.
function narrowDecorator(Story: ComponentType) {
  return (
    <div data-testid={NARROW_CONTAINER_TEST_ID} className="w-[375px]">
      <Story />
    </div>
  );
}

/**
 * Fails if any part of the card extends past the pinned container or spills out of its own
 * parent (a chip overlapping the next cell). Checks every descendant, not just the
 * container's scrollWidth: the row lists scroll internally, and a spill inside a grid cell
 * overlaps its neighbour without widening the container.
 */
async function assertCardFitsNarrowContainer(canvasElement: HTMLElement, rowSelector: string) {
  if (!canvasElement.querySelector(rowSelector)) {
    throw new Error(`Session history story did not render ${rowSelector}`);
  }
  const container = canvasElement.querySelector(`[data-testid="${NARROW_CONTAINER_TEST_ID}"]`);
  if (!(container instanceof HTMLElement)) {
    throw new Error("Session history story container not found");
  }
  // Let layout settle before measuring.
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
  const right = container.getBoundingClientRect().right;
  const overflowing = Array.from(container.querySelectorAll("*")).filter((element) => {
    const elementRight = element.getBoundingClientRect().right;
    const parentRight = element.parentElement?.getBoundingClientRect().right ?? right;
    return elementRight > right + 1 || elementRight > parentRight + 1;
  });
  if (container.scrollWidth > container.clientWidth + 1 || overflowing.length > 0) {
    const culprits = overflowing
      .slice(0, 3)
      .map((element) => (element.textContent ?? element.tagName).slice(0, 40))
      .join(" | ");
    throw new Error(
      `Session history tool card overflowed its ${container.clientWidth}px container: ${culprits}`
    );
  }
}

/**
 * Narrow container · sub-agent search with a long query and real-length item IDs; fails if
 * the header, scope chips or rows overflow instead of truncating/wrapping.
 */
export const NarrowContainer: Story = {
  args: {
    args: {
      action: "search",
      task_id: "t_7f3c2a91d0",
      query: "useWorkspaceStatus polling interval regression after the SSE migration",
      window_id: "w:m:assistant-message-0123456789abcdef",
      recent_first: true,
      max_chars_per_item: 1_200,
    },
    status: "completed",
    defaultExpanded: true,
    result: {
      success: true,
      notice: NOTICE,
      has_more: true,
      items: [
        {
          itemId: itemId(48213, "9f2c"),
          windowId: "w:m:assistant-message-0123456789abcdef",
          role: "assistant",
          startCharOffset: 1_842,
          text: "Found the useWorkspaceStatus polling interval regression after the SSE migration: https://ci.example.com/runs/0123456789abcdef0123456789abcdef/artifacts/trace.json",
        },
      ],
    },
  },
  decorators: [narrowDecorator],
  play: ({ canvasElement }) =>
    assertCardFitsNarrowContainer(canvasElement, '[data-testid="session-history-item"]'),
};

// Persisted results may carry labels this build does not know (a newer backend's boundary
// kind or role); chips must truncate them instead of widening the row.
const LONG_LABEL = "forward_compatible_label_from_a_newer_backend_release";

/** Narrow container · unknown, very long boundary kind on the window rail. */
export const NarrowLongBoundaryKind: Story = {
  args: {
    args: { action: "list_windows" },
    status: "completed",
    defaultExpanded: true,
    result: {
      success: true,
      notice: NOTICE,
      windows: [
        { windowId: "w:0", boundaryKind: "root", itemCount: 12 },
        {
          windowId: "w:m:assistant-message-0123456789abcdef",
          boundaryKind: LONG_LABEL,
          itemCount: 4,
        },
      ],
    },
  },
  decorators: [narrowDecorator],
  play: ({ canvasElement }) =>
    assertCardFitsNarrowContainer(canvasElement, '[data-testid="session-history-window"]'),
};

/** Narrow container · unknown, very long role on a list_items row. */
export const NarrowLongRole: Story = {
  args: {
    args: { action: "list_items", window_id: "w:0" },
    status: "completed",
    defaultExpanded: true,
    result: {
      success: true,
      notice: NOTICE,
      items: [
        { itemId: itemId(2048, "c0ff"), windowId: "w:0", role: LONG_LABEL, text: "Row text." },
      ],
    },
  },
  decorators: [narrowDecorator],
  play: ({ canvasElement }) =>
    assertCardFitsNarrowContainer(canvasElement, '[data-testid="session-history-item"]'),
};

/** Narrow container · read_item with a long item ID and a wide exact range in the header. */
export const NarrowReadItemRange: Story = {
  args: {
    args: {
      action: "read_item",
      task_id: "t_7f3c2a91d0",
      item_id: itemId(1_048_576, "9f2c"),
      offset_chars: 1_234_000,
      limit_chars: READ_ROW.length,
    },
    status: "completed",
    defaultExpanded: true,
    result: {
      success: true,
      notice: NOTICE,
      items: [
        {
          itemId: itemId(1_048_576, "9f2c"),
          windowId: "w:m:assistant-message-0123456789abcdef",
          role: "assistant",
          startCharOffset: 1_234_000,
          text: READ_ROW,
          nextCharOffset: 1_234_000 + READ_ROW.length,
        },
      ],
    },
  },
  decorators: [narrowDecorator],
  play: ({ canvasElement }) =>
    assertCardFitsNarrowContainer(canvasElement, '[data-testid="session-history-excerpt"]'),
};
