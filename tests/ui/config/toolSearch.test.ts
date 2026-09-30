import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";
import { shouldRunIntegrationTests } from "../../testUtils";
import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness } from "../harness";
import { openSettingsDialog } from "../helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Tool search setting", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("defaults on and persists the opt-out to the backend config", async () => {
    const app = await createAppHarness({ branchPrefix: "tool-search-setting", aiMode: "none" });
    try {
      const canvas = await openSettingsDialog(app.view.container);
      const openMcp = async () => {
        fireEvent.click(await canvas.findByRole("button", { name: "General" }));
        fireEvent.click(await canvas.findByRole("button", { name: "MCP" }));
        const toggle = await canvas.findByRole("switch", { name: "Toggle MCP tool search" });
        await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
        return toggle;
      };
      const persisted = () => app.env.config.loadConfigOrDefault().toolSearchEnabled;

      const toggle = await openMcp();
      expect(toggle.getAttribute("aria-checked")).toBe("true");

      fireEvent.click(toggle);
      await waitFor(() => expect(persisted()).toBe(false));
      // A remount reads the persisted value back instead of the default.
      expect((await openMcp()).getAttribute("aria-checked")).toBe("false");

      fireEvent.click(await openMcp());
      await waitFor(() => expect(persisted()).toBeUndefined());
      expect((await openMcp()).getAttribute("aria-checked")).toBe("true");
    } finally {
      await app.dispose();
    }
  }, 120_000);
});
