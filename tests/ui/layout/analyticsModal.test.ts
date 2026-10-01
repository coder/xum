/**
 * UI integration test: analytics is a modal over the current page.
 *
 * The chat underneath stays mounted (keeping its draft and scroll), Escape inside a text field or
 * an open inner menu stays there, and an unclaimed Escape (including on a select) closes analytics.
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

  test("opens over the mounted chat; inner Escape stays open, unclaimed Escape closes", async () => {
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

      // Escape in the open Sample Queries menu closes only that menu, not the whole modal.
      const sampleQueriesButton = within(dialog).getByRole("button", { name: /Sample Queries/ });
      fireEvent.click(sampleQueriesButton);
      const sampleItem = await body.findByRole("button", { name: "Top Models by Cost" });
      fireEvent.keyDown(sampleItem, { key: "Escape" });
      await waitFor(() => {
        expect(body.queryByRole("button", { name: "Top Models by Cost" })).toBeNull();
      });
      expect(body.queryByRole("dialog", { name: "Analytics" })).toBe(dialog);

      // A click on the dimmed overlay while the (named) menu is open closes only the menu, like
      // Settings stacked over analytics; it used to close both layers and drop unsaved SQL.
      fireEvent.click(sampleQueriesButton);
      const sampleMenu = await body.findByRole("dialog", { name: "Sample queries" });
      const overlay = dialog.previousElementSibling;
      expect(overlay).not.toBeNull();
      fireEvent.pointerDown(overlay!);
      await waitFor(() => {
        expect(sampleMenu.isConnected).toBe(false);
      });
      expect(body.queryByRole("dialog", { name: "Analytics" })).toBe(dialog);

      // With Settings stacked over analytics, the analytics toggle returns to analytics.
      fireEvent.keyDown(window, { key: ",", ctrlKey: true });
      await body.findByRole("dialog", { name: "Settings" }, { timeout: 10_000 });
      fireEvent.keyDown(window, { key: "Y", ctrlKey: true, shiftKey: true });
      await waitFor(() => {
        expect(body.queryByRole("dialog", { name: "Settings" })).toBeNull();
      });
      const analyticsAgain = await body.findByRole("dialog", { name: "Analytics" });

      // The project filter gets initial focus; Escape on a closed <select> must close analytics
      // (it used to count as an editable target and keep the dialog open).
      const projectFilter = within(analyticsAgain).getByLabelText("Project");
      expect(projectFilter.tagName).toBe("SELECT");
      fireEvent.keyDown(projectFilter, { key: "Escape" });
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
