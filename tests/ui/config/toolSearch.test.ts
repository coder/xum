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

  test("a stale failed write does not roll back a later selection", async () => {
    const app = await createAppHarness({ branchPrefix: "tool-search-race", aiMode: "none" });
    try {
      const canvas = await openSettingsDialog(app.view.container);
      fireEvent.click(await canvas.findByRole("button", { name: "MCP" }));
      const toggle = await canvas.findByRole("switch", { name: "Toggle MCP tool search" });
      await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));

      const config = app.env.config;
      const original = config.updateToolSearchEnabled.bind(config);
      const events: string[] = [];
      let calls = 0;
      let rejectSecond: ((error: Error) => void) | undefined;
      const spy = jest.spyOn(config, "updateToolSearchEnabled").mockImplementation((enabled) => {
        const call = ++calls;
        events.push(`write ${call}`);
        if (call !== 2) return original(enabled);
        return new Promise<void>((_resolve, reject) => {
          rejectSecond = reject;
        });
      });

      // off, on (fails after the later clicks), off, on
      for (let i = 0; i < 4; i++) fireEvent.click(toggle);
      await waitFor(() => expect(rejectSecond).toBeDefined());
      events.push("reject 2");
      rejectSecond?.(new Error("stale write failed"));
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(4));
      await spy.mock.results[3]?.value;

      // Writes reach the backend in click order, so the last selection is the persisted one.
      expect(events).toEqual(["write 1", "write 2", "reject 2", "write 3", "write 4"]);
      await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
      expect(config.loadConfigOrDefault().toolSearchEnabled).toBeUndefined();
      expect(canvas.queryByText("stale write failed")).toBeNull();
    } finally {
      await app.dispose();
    }
  }, 120_000);
});
