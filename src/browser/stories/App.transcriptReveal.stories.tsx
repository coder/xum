/**
 * Tail-first transcript reveal (real Chromium via the Storybook test-runner).
 *
 * Switching to a long transcript mounts the newest rows first and the rest in frame-yielded
 * chunks (`useBoundedTranscriptReveal`). These plays prove what happy-dom cannot: that a
 * rendering opportunity (an animation frame) separates the tail commit from the first chunk,
 * and that a reader who scrolled up mid-reveal keeps their place while older rows mount above.
 */
import type { ComponentType } from "react";
import { expect, userEvent, waitFor, within } from "@storybook/test";
import type { APIClient } from "@/browser/contexts/API";
import type { ChatMuxMessage } from "@/common/orpc/types";
import { TRANSCRIPT_REVEAL_TAIL_ROWS } from "@/common/constants/ui";
import { transcriptRevealFrameScheduler } from "@/browser/hooks/useBoundedTranscriptReveal";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createMockORPCClient } from "./mocks/orpc";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { createWorkspace, groupWorkspacesByProject } from "./mocks/workspaces";
import {
  collapseLeftSidebar,
  collapseRightSidebar,
  expandLeftSidebar,
  expandProjects,
  selectWorkspace,
} from "./helpers/uiState";

export default { ...appMeta, title: "App/TranscriptReveal" };

const LARGE_ROWS = 300;
const rowId = (index: number) => `reveal-row-${index}`;
const rowText = (index: number) => `Transcript row ${index} of the tail-first reveal.`;

const smallWorkspace = createWorkspace({
  id: "ws-reveal-small",
  name: "small",
  projectName: "mux",
});
const largeWorkspace = createWorkspace({
  id: "ws-reveal-large",
  name: "large",
  projectName: "mux",
});

function largeHistory(): ChatMuxMessage[] {
  return Array.from({ length: LARGE_ROWS }, (_, index) =>
    index % 2 === 0
      ? createUserMessage(rowId(index), rowText(index), { historySequence: index + 1 })
      : createAssistantMessage(rowId(index), rowText(index), { historySequence: index + 1 })
  );
}

function setup(): APIClient {
  selectWorkspace(smallWorkspace);
  collapseLeftSidebar();
  collapseRightSidebar();
  expandProjects([smallWorkspace.projectPath]);
  return createMockORPCClient({
    projects: groupWorkspacesByProject([smallWorkspace, largeWorkspace]),
    workspaces: [smallWorkspace, largeWorkspace],
    onChat: (workspaceId, emit) => {
      if (workspaceId === largeWorkspace.id) {
        for (const row of largeHistory()) emit(row);
      } else {
        emit(createAssistantMessage("small-1", "A short transcript.", { historySequence: 1 }));
      }
      emit({ type: "caught-up", historyReplayStatus: "complete", hasOlderHistory: false });
    },
  });
}

async function switchToLargeWorkspace(canvasElement: HTMLElement): Promise<void> {
  expandLeftSidebar();
  const row = await waitFor(async () => {
    const element = canvasElement.querySelector<HTMLElement>(
      `[data-workspace-id="${largeWorkspace.id}"][role="button"]`
    );
    await expect(element).not.toBeNull();
    return element!;
  });
  await userEvent.click(row);
  collapseLeftSidebar();
}

/** The AppLoader fades in; a row found in the DOM can still be at opacity 0 for a moment. */
async function findVisibleText(canvasElement: HTMLElement, text: string): Promise<HTMLElement> {
  const element = await within(canvasElement).findByText(text, {}, { timeout: 15_000 });
  await waitFor(() => expect(element).toBeVisible());
  return element;
}

function mountedRowIds(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-message-id]")).map(
    (element) => element.getAttribute("data-message-id") ?? ""
  );
}

/** First DOM insertion of every transcript row: which commit batch, and how many animation frames had run. */
function observeRowMounts(root: HTMLElement): {
  firstSeen: Map<string, { batch: number; frame: number }>;
  stop: () => void;
} {
  const firstSeen = new Map<string, { batch: number; frame: number }>();
  let batch = 0;
  let frame = 0;
  let rafId = requestAnimationFrame(function tick() {
    frame += 1;
    rafId = requestAnimationFrame(tick);
  });
  const observer = new MutationObserver((records) => {
    batch += 1;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const rows = node.matches("[data-message-id]")
          ? [node]
          : Array.from(node.querySelectorAll<HTMLElement>("[data-message-id]"));
        for (const element of rows) {
          const id = element.getAttribute("data-message-id");
          if (id && !firstSeen.has(id)) firstSeen.set(id, { batch, frame });
        }
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return {
    firstSeen,
    stop: () => {
      observer.disconnect();
      cancelAnimationFrame(rafId);
    },
  };
}

const revealTailFirst: AppStory["play"] = async ({ canvasElement, step }) => {
  const canvas = within(canvasElement);
  await findVisibleText(canvasElement, "A short transcript.");
  const mounts = observeRowMounts(canvasElement);
  try {
    await step(
      "The newest rows mount first, then older chunks after a rendering opportunity",
      async () => {
        await switchToLargeWorkspace(canvasElement);
        await findVisibleText(canvasElement, rowText(LARGE_ROWS - 1));
        await waitFor(() => expect(canvas.queryByText(rowText(0))).not.toBeNull(), {
          timeout: 15_000,
        });
        const newest = mounts.firstSeen.get(rowId(LARGE_ROWS - 1))!;
        const oldest = mounts.firstSeen.get(rowId(0))!;
        await expect(newest.batch, "tail committed before the oldest row").toBeLessThan(
          oldest.batch
        );
        await expect(
          oldest.frame,
          "an animation frame ran between the tail and the oldest chunk"
        ).toBeGreaterThan(newest.frame);
        const tailBatchRows = Array.from(mounts.firstSeen.values()).filter(
          (seen) => seen.batch === newest.batch
        ).length;
        await expect(tailBatchRows).toBeGreaterThanOrEqual(TRANSCRIPT_REVEAL_TAIL_ROWS);
        await expect(tailBatchRows).toBeLessThan(LARGE_ROWS);
        await expect(mountedRowIds(canvasElement)).toEqual(
          expect.arrayContaining([rowId(0), rowId(LARGE_ROWS - 1)])
        );
      }
    );
  } finally {
    mounts.stop();
  }
};

export const TailFirstSwitch: AppStory = {
  render: () => <AppWithMocks setup={setup} />,
  play: revealTailFirst,
};

const IPHONE_16E = { width: 390, height: 844 } as const;
function IPhone16eDecorator(Story: ComponentType) {
  return (
    <div style={{ width: IPHONE_16E.width, height: IPHONE_16E.height, overflow: "hidden" }}>
      <Story />
    </div>
  );
}

export const TailFirstSwitchPhone: AppStory = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
  render: () => <AppWithMocks setup={setup} />,
  decorators: [IPhone16eDecorator],
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } },
  },
  play: async (context) => {
    await waitFor(() =>
      expect(
        context.canvasElement
          .querySelector('[data-testid="message-window"]')!
          .getBoundingClientRect().width
      ).toBeLessThanOrEqual(IPHONE_16E.width)
    );
    await revealTailFirst(context);
  },
};

/** The transcript row whose box is the first to cross the scrollport's top edge. */
function topVisibleRowId(scrollport: HTMLElement): string | null {
  const top = scrollport.getBoundingClientRect().top;
  for (const element of scrollport.querySelectorAll<HTMLElement>("[data-message-id]")) {
    if (element.getBoundingClientRect().bottom > top) {
      return element.getAttribute("data-message-id");
    }
  }
  return null;
}

export const ScrollUpMidReveal: AppStory = {
  render: () => <AppWithMocks setup={setup} />,
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await findVisibleText(canvasElement, "A short transcript.");
    // Hold the reveal after its tail commit so the scroll happens deterministically mid-reveal;
    // the remaining chunks then run on the production scheduler.
    const held: Array<() => void> = [];
    const realSchedule = transcriptRevealFrameScheduler.schedule;
    transcriptRevealFrameScheduler.schedule = (callback) => {
      held.push(callback);
      return () => {
        const index = held.indexOf(callback);
        if (index !== -1) held.splice(index, 1);
      };
    };
    try {
      await step(
        "Scrolling up while only the tail is mounted keeps the reader's row in place",
        async () => {
          await switchToLargeWorkspace(canvasElement);
          await findVisibleText(canvasElement, rowText(LARGE_ROWS - 1));
          await waitFor(() => expect(held).toHaveLength(1));
          await expect(canvas.queryByText(rowText(0))).toBeNull();
          const scrollport = canvas.getByTestId("message-window");
          await expect(scrollport.scrollHeight).toBeGreaterThan(scrollport.clientHeight);
          // A wheel gesture releases the bottom lock; land in the middle of the mounted tail.
          scrollport.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
          scrollport.scrollTop = Math.floor(scrollport.scrollHeight / 2);
          scrollport.dispatchEvent(new Event("scroll"));
          await canvas.findByRole("button", { name: /Jump to bottom/ });
          const anchorRow = topVisibleRowId(scrollport);
          if (anchorRow === null)
            throw new Error("no transcript row is visible after scrolling up");
          const anchorElement = () => scrollport.querySelector(`[data-message-id="${anchorRow}"]`)!;
          const anchorTop = anchorElement().getBoundingClientRect().top;

          transcriptRevealFrameScheduler.schedule = realSchedule;
          held.shift()!();
          await waitFor(() => expect(canvas.queryByText(rowText(0))).not.toBeNull(), {
            timeout: 15_000,
          });
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          );
          await expect(topVisibleRowId(scrollport), "top visible row after the reveal").toBe(
            anchorRow
          );
          // Native scroll anchoring restores the row within a sub-pixel of its previous position.
          await expect(
            Math.abs(anchorElement().getBoundingClientRect().top - anchorTop),
            "anchor row displacement (px)"
          ).toBeLessThanOrEqual(1);
        }
      );
    } finally {
      transcriptRevealFrameScheduler.schedule = realSchedule;
    }
  },
};
