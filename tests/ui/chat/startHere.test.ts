/**
 * UI integration test for Start Here behavior.
 *
 * Verifies that clicking Start Here inserts a durable compaction boundary
 * while preserving the pre-boundary conversation in the UI.
 *
 * Uses the mock AI router via createAppHarness().
 */

import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";

import { preloadTestModules } from "../../ipc/setup";

import { createAppHarness, type AppHarness } from "../harness";

async function clickStartHere(app: AppHarness): Promise<void> {
  const startHereButton = await waitFor(
    () => {
      const buttons = Array.from(
        app.view.container.querySelectorAll<HTMLButtonElement>('button[aria-label="Start Here"]')
      );
      const enabled = buttons.find((b) => !b.disabled);
      if (!enabled) {
        throw new Error("Start Here button not found or disabled");
      }
      return enabled;
    },
    { timeout: 10_000 }
  );
  fireEvent.click(startHereButton);
}

/** The OK button of the StartHereModal dialog (Radix portals it to document.body). */
async function findEnabledOkButton(): Promise<HTMLButtonElement> {
  return waitFor(
    () => {
      // In happy-dom, Radix portals are unreliable, but the modal's OK button
      // uses the text "OK" and lives somewhere in the document.
      const buttons = Array.from(document.querySelectorAll("button"));
      const ok = buttons.find((b) => b.textContent?.trim().startsWith("OK") && !b.disabled);
      if (!ok) {
        throw new Error("OK button not found in Start Here modal");
      }
      return ok;
    },
    { timeout: 5_000 }
  );
}

describe("Start Here (mock AI router)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("inserts a compaction boundary and preserves earlier history", async () => {
    const app = await createAppHarness({ branchPrefix: "start-here" });

    try {
      const seedMessage = "Seed conversation for start-here test";
      await app.chat.send(seedMessage);
      await app.chat.expectTranscriptContains(`Mock response: ${seedMessage}`);

      // Click Start Here on the assistant message, then confirm the modal.
      await clickStartHere(app);
      fireEvent.click(await findEnabledOkButton());

      // A compaction boundary row should appear in the transcript.
      await app.chat.expectTranscriptContains("Compaction boundary", 10_000);

      // Pre-boundary content must still be visible (not destroyed).
      await app.chat.expectTranscriptContains(seedMessage);
      await app.chat.expectTranscriptContains(`Mock response: ${seedMessage}`);
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("shows a refused Start Here in the dialog and keeps it open until a retry succeeds", async () => {
    const app = await createAppHarness({ branchPrefix: "start-here-refused" });
    const savedReplayTapes = process.env.XUM_REPLAY_TAPES;

    try {
      const seedMessage = "Seed conversation for refused start-here test";
      await app.chat.send(seedMessage);
      await app.chat.expectTranscriptContains(`Mock response: ${seedMessage}`);

      // The in-process backend is now in session tape replay mode and refuses history changes.
      // The already open transcript subscription is unaffected.
      process.env.XUM_REPLAY_TAPES = JSON.stringify({ [app.workspaceId]: "/nonexistent.jsonl" });
      await clickStartHere(app);
      fireEvent.click(await findEnabledOkButton());

      const alert = await waitFor(
        () => {
          const node = document.querySelector('[role="alert"]');
          if (!node?.textContent?.includes("XUM_REPLAY_TAPES")) {
            throw new Error("refusal not shown in the Start Here dialog");
          }
          return node;
        },
        { timeout: 5_000 }
      );
      expect(alert.textContent).toContain("read-only");

      // The dialog stayed open; once the backend accepts, the same OK succeeds and closes it.
      if (savedReplayTapes === undefined) delete process.env.XUM_REPLAY_TAPES;
      else process.env.XUM_REPLAY_TAPES = savedReplayTapes;
      fireEvent.click(await findEnabledOkButton());
      await app.chat.expectTranscriptContains("Compaction boundary", 10_000);
      await waitFor(() => {
        if (document.querySelector('[role="alert"]')) throw new Error("refusal still shown");
      });
    } finally {
      if (savedReplayTapes === undefined) delete process.env.XUM_REPLAY_TAPES;
      else process.env.XUM_REPLAY_TAPES = savedReplayTapes;
      await app.dispose();
    }
  }, 60_000);
});
