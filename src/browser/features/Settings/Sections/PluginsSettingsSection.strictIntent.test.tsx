import { afterEach, beforeEach, expect, test } from "bun:test";
import { StrictMode } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider } from "@/browser/contexts/API";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { PluginsSettingsSection } from "./PluginsSettingsSection";
import {
  consumePendingPluginsSectionIntent,
  publishPluginsSectionIntent,
} from "./pluginsSectionIntents";

let cleanupDom: (() => void) | null = null;
beforeEach(() => {
  cleanupDom = installDom();
  consumePendingPluginsSectionIntent();
});
afterEach(() => {
  cleanup();
  cleanupDom?.();
  consumePendingPluginsSectionIntent();
});

// The dev app renders in StrictMode, which runs state initializers twice. An intent published
// before the section mounts (palette command, Settings → Backup "Review and install") must
// survive that, or the section opens without the panel the intent asked for.
test("an intent published before mount opens the add panel under StrictMode", async () => {
  const api = createMockORPCClient({ agentPlugins: { items: [] } });
  publishPluginsSectionIntent({ type: "open-add-panel" });
  const view = render(
    <StrictMode>
      <APIProvider client={api}>
        <TooltipProvider>
          <PluginsSettingsSection />
        </TooltipProvider>
      </APIProvider>
    </StrictMode>
  );
  await waitFor(() => expect(view.container.querySelector("#plugin-source")).not.toBeNull());
});

test("a consumed intent does not reopen the panel on the next mount", async () => {
  const api = createMockORPCClient({ agentPlugins: { items: [] } });
  publishPluginsSectionIntent({ type: "open-add-panel" });
  const tree = () => (
    <StrictMode>
      <APIProvider client={api}>
        <TooltipProvider>
          <PluginsSettingsSection />
        </TooltipProvider>
      </APIProvider>
    </StrictMode>
  );
  const first = render(tree());
  await waitFor(() => expect(first.container.querySelector("#plugin-source")).not.toBeNull());
  first.unmount();
  const second = render(tree());
  await waitFor(() => expect(second.getByRole("button", { name: /add plugin/i })).toBeTruthy());
  expect(second.container.querySelector("#plugin-source")).toBeNull();
});
