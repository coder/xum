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

import { createAppHarness } from "../harness";

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

      // Find the Start Here button on the assistant message and click it.
      const startHereButton = await waitFor(
        () => {
          const buttons = Array.from(
            app.view.container.querySelectorAll('button[aria-label="Start Here"]')
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

      // Confirm the modal (the OK button inside the StartHereModal dialog).
      const okButton = await waitFor(
        () => {
          // StartHereModal renders via Radix Dialog which portals to document.body.
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
      fireEvent.click(okButton);

      // A compaction boundary row should appear in the transcript.
      await app.chat.expectTranscriptContains("Compaction boundary", 10_000);

      // Pre-boundary content must still be visible (not destroyed).
      await app.chat.expectTranscriptContains(seedMessage);
      await app.chat.expectTranscriptContains(`Mock response: ${seedMessage}`);
    } finally {
      await app.dispose();
    }
  }, 60_000);
});
