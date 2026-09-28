import "./dom";
import { waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { shouldRunIntegrationTests } from "../testUtils";
import { preloadTestModules } from "../ipc/setup";
import { createAppHarness } from "./harness";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { LEFT_SIDEBAR_COLLAPSED_KEY } from "@/common/constants/storage";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Settings modal shortcuts", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("the settings shortcut replaces the palette, and page shortcuts stay inert under the modal", async () => {
    const app = await createAppHarness({ branchPrefix: "settings-shortcuts", aiMode: "none" });
    try {
      const body = within(app.view.container.ownerDocument.body);
      const user = userEvent.setup({ document: app.view.container.ownerDocument });
      const paletteIsClosed = () => body.queryByLabelText("Command palette") === null;

      await user.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
      await body.findByLabelText("Command palette");

      // A palette left open behind settings would swallow the modal's first Escape.
      await user.keyboard("{Control>},{/Control}");
      await body.findByRole("dialog", { name: "Settings" });
      await waitFor(() => expect(paletteIsClosed()).toBe(true));

      const sidebarCollapsed = readPersistedState(LEFT_SIDEBAR_COLLAPSED_KEY, false);
      await user.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
      await user.keyboard("{Control>}p{/Control}");
      expect(paletteIsClosed()).toBe(true);
      expect(readPersistedState(LEFT_SIDEBAR_COLLAPSED_KEY, false)).toBe(sidebarCollapsed);
    } finally {
      await app.dispose();
    }
  }, 60_000);
});
