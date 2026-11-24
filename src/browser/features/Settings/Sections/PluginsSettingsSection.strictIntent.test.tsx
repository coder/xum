import { afterEach, beforeEach, expect, test } from "bun:test";
import { StrictMode, useRef } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider } from "@/browser/contexts/API";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { PluginsSettingsSection } from "./PluginsSettingsSection";
import {
  consumePendingPluginsSectionIntent,
  publishPluginsSectionIntent,
  type PluginsSectionIntent,
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

/** Publishes while the tree renders: after the section above it has read the buffer, before any effect runs. */
function PublishDuringRender(props: { intent: PluginsSectionIntent }) {
  const published = useRef(false);
  if (!published.current) {
    published.current = true;
    publishPluginsSectionIntent(props.intent);
  }
  return null;
}

test("an intent published after the section read the buffer still opens the add panel", async () => {
  const api = createMockORPCClient({ agentPlugins: { items: [] } });
  const view = render(
    <APIProvider client={api}>
      <TooltipProvider>
        <PluginsSettingsSection />
        <PublishDuringRender intent={{ type: "open-add-panel" }} />
      </TooltipProvider>
    </APIProvider>
  );
  await waitFor(() => expect(view.container.querySelector("#plugin-source")).not.toBeNull());
});
