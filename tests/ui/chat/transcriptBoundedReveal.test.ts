/**
 * Bundle-granular tail-first transcript reveal (full app, real IPC, mock AI router).
 *
 * A bulk arrival — here a since-replay of 300 seeded rows after a compaction boundary — mounts
 * the newest rows first and the rest in frame-yielded chunks. The hook's frame scheduler is
 * swapped for a held queue so every intermediate state is observable: the composer keeps
 * working, a stream renders at the tail while older rows are still unmounted, "Load older
 * messages" waits for the last chunk, and a navigation to a not-yet-mounted row scrolls once
 * its chunk lands.
 */
import "../dom";

jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));

import { act, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness } from "../harness";
import { transcriptRevealFrameScheduler } from "@/browser/hooks/useBoundedTranscriptReveal";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import { TRANSCRIPT_REVEAL_TAIL_ROWS } from "@/common/constants/ui";
import { createMuxMessage } from "@/common/types/message";
import * as mockAiStreamAdapter from "@/node/services/mock/mockAiStreamAdapter";

const SEEDED_ROWS = 300;
const seedText = (index: number) => `Seed row ${index} of the bounded reveal`;
const seedId = (index: number) => `seed-${index % 2 === 0 ? "user" : "assistant"}-${index}`;

// Each reveal step preempts React transitions in the app, so while the backfill runs a transition
// may never commit. happy-dom still runs them, so hold them explicitly to reproduce that. The real
// hook still runs (hook order unchanged); only the start callback is deferred. Only Streamdown's
// streaming mode uses useTransition in the renderer.
const realUseTransition = React.useTransition;
const heldTransitions: (() => void)[] = [];
function useHeldTransition(): ReturnType<typeof React.useTransition> {
  const [isPending, startTransition] = realUseTransition();
  return [isPending, (callback) => heldTransitions.push(() => startTransition(callback))];
}

function mountedRowIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-message-id]")).map(
    (element) => element.getAttribute("data-message-id") ?? ""
  );
}

describe("Tail-first transcript reveal (mock AI router)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("mounts the tail first, keeps the UI live, and reveals the rest in chunks", async () => {
    const app = await createAppHarness({ branchPrefix: "bounded-reveal" });
    const heldFrames: (() => void)[] = [];
    const originalSchedule = transcriptRevealFrameScheduler.schedule;
    const scrolledTo: string[] = [];
    // eslint-disable-next-line @typescript-eslint/unbound-method -- saved only to restore the prototype method afterwards
    const originalScrollIntoView = Element.prototype.scrollIntoView;

    try {
      // A completed turn plus a compaction give the replay a since-cursor and a boundary, so
      // the seeded rows arrive as one since-replay and "Load older messages" has a page to offer.
      await app.chat.send("Seed before the compaction");
      await app.chat.expectTranscriptContains("Mock response: Seed before the compaction");
      await app.chat.expectStreamComplete();
      await app.chat.send("/compact -t 500");
      await app.chat.expectTranscriptContains("Mock compaction summary:", 60_000);
      await app.chat.expectStreamComplete();

      const historyService = app.env.services.toORPCContext().historyService;
      for (let index = 0; index < SEEDED_ROWS; index++) {
        const appended = await historyService.appendToHistory(
          app.workspaceId,
          createMuxMessage(seedId(index), index % 2 === 0 ? "user" : "assistant", seedText(index))
        );
        if (!appended.success) throw new Error(appended.error);
      }

      // Hold the reveal's frames so each step is explicit, and record navigation scrolls.
      transcriptRevealFrameScheduler.schedule = (callback) => {
        heldFrames.push(callback);
        return () => {
          const held = heldFrames.indexOf(callback);
          if (held !== -1) heldFrames.splice(held, 1);
        };
      };
      Element.prototype.scrollIntoView = function (this: Element) {
        scrolledTo.push(this.getAttribute("data-message-id") ?? "?");
      };

      // Leave and re-enter: the since-replay lands all seeded rows at once (bulk arrival).
      workspaceStore.setActiveWorkspaceId(null);
      workspaceStore.setActiveWorkspaceId(app.workspaceId);

      await app.chat.expectTranscriptContains(seedText(SEEDED_ROWS - 1), 30_000);
      const transcript = () => app.view.container.textContent ?? "";
      // Newest rows are in the DOM before the oldest; the mounted range is a bounded tail.
      expect(transcript()).not.toContain(seedText(0));
      const tailIds = mountedRowIds(app.view.container);
      expect(tailIds).toContain(seedId(SEEDED_ROWS - 1));
      expect(tailIds).not.toContain(seedId(0));
      expect(tailIds.length).toBeLessThan(SEEDED_ROWS);
      expect(tailIds.length).toBeGreaterThanOrEqual(TRANSCRIPT_REVEAL_TAIL_ROWS);
      expect(heldFrames.length).toBe(1);
      // Older pages prepend above unmounted rows: not offered until fully revealed.
      expect(transcript()).not.toContain("Load older messages");

      // The composer accepts input during the reveal.
      const draft = "Typed while older rows are still mounting";
      await app.chat.typeWithoutSending(draft);
      await app.chat.expectInputValue(draft);

      // Navigation to a row below the reveal boundary waits for its chunk instead of no-op'ing.
      const earliestMountedUserIndex = tailIds
        .map((id) => Number(id.split("-").at(-1)))
        .filter((index) => Number.isInteger(index) && index % 2 === 0)
        .sort((a, b) => a - b)[0];
      expect(earliestMountedUserIndex).toBeGreaterThan(1);
      const targetId = seedId(earliestMountedUserIndex - 2);
      const previousButtons = Array.from(
        app.view.container.querySelectorAll<HTMLButtonElement>(
          'button[aria-label="Previous message"]'
        )
      ).filter((button) => !button.disabled);
      expect(previousButtons.length).toBeGreaterThan(0);
      fireEvent.click(previousButtons[0]);
      await act(async () => {
        await Promise.resolve();
      });
      expect(scrolledTo).toEqual([]);

      // The target sits in the next chunk up: releasing one frame mounts it and the pending
      // navigation fires then, not before.
      let steps = 0;
      const mountedBefore = mountedRowIds(app.view.container).length;
      const releaseFrame = () => {
        if (++steps > 50) throw new Error("reveal did not finish within 50 steps");
        const frame = heldFrames.shift()!;
        act(() => frame());
        expect(mountedRowIds(app.view.container).length).toBeGreaterThan(mountedBefore);
      };
      expect(heldFrames.length).toBeGreaterThan(0);
      releaseFrame();
      expect(mountedRowIds(app.view.container)).toContain(targetId);
      await waitFor(() => expect(scrolledTo).toEqual([targetId]));

      // A stream started mid-reveal renders at the tail while the oldest rows are still unmounted.
      expect(heldFrames.length).toBeGreaterThan(0);
      const midReveal = "Sent while older rows are still mounting";
      await app.chat.send(midReveal);
      await app.chat.expectTranscriptContains(`Mock response: ${midReveal}`);
      expect(transcript()).not.toContain(seedText(0));
      expect(mountedRowIds(app.view.container)).not.toContain(seedId(0));

      // A navigation still waiting for its chunk is superseded by a send: returning to the live
      // tail must not be undone once that chunk mounts.
      const earliestMountedAfterSend = Array.from(
        app.view.container.querySelectorAll<HTMLButtonElement>(
          'button[aria-label="Previous message"]'
        )
      ).find((button) => !button.disabled)!;
      fireEvent.click(earliestMountedAfterSend);
      await act(async () => {
        await Promise.resolve();
      });
      const cancelled = "Sent while a navigation was still pending";
      await app.chat.send(cancelled);
      await app.chat.expectTranscriptContains(`Mock response: ${cancelled}`);

      // A reply streaming during the backfill paints its text even though transitions are
      // starved (ChatPane marks the transcript as backfilling). Its next chunk is seconds away,
      // so the text visible here is the first chunk of a still-active stream.
      await app.chat.expectStreamComplete();
      expect(heldFrames.length).toBeGreaterThan(0);
      const slowMarker = "Streamed slowly while older rows are still mounting";
      const realBuildEvents = mockAiStreamAdapter.buildMockStreamEventsFromReply;
      let slowStream: { messageId: string; firstChunk: string } | null = null;
      const buildEventsSpy = jest
        .spyOn(mockAiStreamAdapter, "buildMockStreamEventsFromReply")
        .mockImplementation((reply, options) => {
          if (!reply.assistantText.includes(slowMarker)) return realBuildEvents(reply, options);
          const events = realBuildEvents(reply, { ...options, chunkDelayMs: 5_000 });
          const firstDelta = events.find((event) => event.kind === "stream-delta");
          if (firstDelta?.kind !== "stream-delta") throw new Error("slow reply has no text");
          slowStream = { messageId: options.messageId, firstChunk: firstDelta.text.trim() };
          return events;
        });
      const useTransitionSpy = jest
        .spyOn(React, "useTransition")
        .mockImplementation(useHeldTransition);
      try {
        await app.chat.send(slowMarker);
        const inFlightRow = () =>
          app.view.container.querySelector(`[data-message-id="${slowStream?.messageId}"]`);
        await waitFor(
          () => {
            expect(slowStream).not.toBeNull();
            expect(inFlightRow()).not.toBeNull();
            expect(inFlightRow()!.textContent).toContain(slowStream!.firstChunk);
          },
          { timeout: 4_000 }
        );
        // Guards against a vacuous pass if Streamdown ever stops reading useTransition through
        // the React module object this spy patches.
        expect(useTransitionSpy).toHaveBeenCalled();
        expect(workspaceStore.getWorkspaceSidebarState(app.workspaceId).canInterrupt).toBe(true);
        expect(inFlightRow()!.textContent).not.toContain(slowMarker);
        const interrupted = await app.env.orpc.workspace.interruptStream({
          workspaceId: app.workspaceId,
        });
        expect(interrupted.success).toBe(true);
        await app.chat.expectStreamComplete();
      } finally {
        buildEventsSpy.mockRestore();
        useTransitionSpy.mockRestore();
        act(() => {
          for (const release of heldTransitions.splice(0)) release();
        });
      }

      // Release the remaining frames one at a time; each step mounts one more chunk.
      while (heldFrames.length > 0) releaseFrame();
      expect(steps).toBeGreaterThan(1);
      await app.chat.expectTranscriptContains(seedText(0));
      expect(mountedRowIds(app.view.container)).toContain(seedId(0));
      await waitFor(() => expect(transcript()).toContain("Load older messages"));
      // Only the navigation that mounted before the send scrolled; the superseded one never did.
      await act(async () => {
        await Promise.resolve();
      });
      expect(scrolledTo).toEqual([targetId]);
    } finally {
      transcriptRevealFrameScheduler.schedule = originalSchedule;
      Element.prototype.scrollIntoView = originalScrollIntoView;
      await app.dispose();
    }
  }, 120_000);
});
