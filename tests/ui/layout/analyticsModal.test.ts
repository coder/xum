/**
 * UI integration test: analytics is a modal over the current page.
 *
 * The chat underneath stays mounted (keeping its draft and scroll), Escape inside an editable
 * field stays with that field, and an unclaimed Escape closes analytics.
 */

import "../dom";
import { fireEvent, waitFor, within } from "@testing-library/react";

import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness } from "../harness";
import { openAnalyticsDialog } from "../helpers";

describe("Analytics modal", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("opens over the mounted chat; editable Escape stays open, unclaimed Escape closes", async () => {
    const app = await createAppHarness({ branchPrefix: "analytics-modal" });

    try {
      const draft = "draft kept under analytics";
      await app.chat.typeWithoutSending(draft);
      const composers = app.view.container.querySelectorAll<HTMLTextAreaElement>(
        'textarea[aria-label="Message Claude"]'
      );
      const composer = composers[composers.length - 1];
      expect(composer).toBeDefined();

      const dialog = await openAnalyticsDialog(app.view.container);
      const body = within(app.view.container.ownerDocument.body);
      // A remounted chat would be a different element: the same node proves it stayed mounted.
      expect(composer.isConnected).toBe(true);

      // Escape in the SQL editor must not close analytics and unmount the unsaved query.
      const sqlEditor = within(dialog).getByPlaceholderText("SELECT * FROM events LIMIT 10;");
      fireEvent.change(sqlEditor, { target: { value: "SELECT 1" } });
      fireEvent.keyDown(sqlEditor, { key: "Escape" });
      expect(body.queryByRole("dialog", { name: "Analytics" })).toBe(dialog);

      fireEvent.keyDown(dialog, { key: "Escape" });
      await waitFor(
        () => {
          expect(body.queryByRole("dialog", { name: "Analytics" })).toBeNull();
        },
        { timeout: 30_000 }
      );
      expect(composer.isConnected).toBe(true);
      expect(composer.value).toBe(draft);
    } finally {
      await app.dispose();
    }
    // 120s total (like focus/undo): CI runners under merge-queue load inflate wall
    // clock enough that the 60s budget covering harness setup + interactions was
    // exceeded at 66s (merge-queue run 32719185534) on a PR that never touched this area.
  }, 120_000);
});
