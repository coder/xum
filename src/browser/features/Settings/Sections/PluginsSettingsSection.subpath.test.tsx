import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { installDom } from "../../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider } from "@/browser/contexts/API";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { AgentPluginGitSource } from "@/common/config/schemas/agentPluginInstalls";
import { PluginsSettingsSection } from "./PluginsSettingsSection";

let cleanupDom: (() => void) | null = null;
beforeEach(() => {
  cleanupDom = installDom();
});
afterEach(() => {
  cleanup();
  cleanupDom?.();
});

const monorepoSource: AgentPluginGitSource = {
  type: "git",
  url: "https://github.com/cursor/plugins.git",
  ref: "main",
  refType: "branch",
  subpath: "pstack",
};

// Several plugins can come from one monorepo: the installed row and the
// consent preview must name the folder, not only the repository.
test("the installed row and the consent preview show the monorepo plugin folder", async () => {
  const api = createMockORPCClient({
    agentPlugins: {
      items: [
        {
          name: "pstack",
          managed: true,
          present: true,
          location: "~/.mux/plugins/pstack",
          source: monorepoSource,
          lockedSha: "a".repeat(40),
          skillCount: 0,
          mcpServerCount: 0,
        },
      ],
      preview: {
        source: monorepoSource,
        method: { kind: "agent-plugin" },
        methods: [{ kind: "agent-plugin" }],
        lockedSha: "b".repeat(40),
        manifest: { name: "pstack-next" },
        skills: [],
        mcpServers: [],
        agents: [],
        workflows: [],
        slashCommands: [],
        reviewedComponents: [],
        codexHooks: [],
        warnings: [],
        targetPath: "~/.mux/plugins/pstack-next",
        consentDigest: "c".repeat(64),
      },
    },
  });

  const view = render(
    <APIProvider client={api}>
      <TooltipProvider>
        <PluginsSettingsSection />
      </TooltipProvider>
    </APIProvider>
  );
  await waitFor(() =>
    expect(view.container.textContent).toContain("github.com/cursor/plugins/pstack @ main")
  );

  const previewSpy = spyOn(api.agentPlugins, "preview");
  fireEvent.click(await view.findByRole("button", { name: /Add plugin/ }));
  // happy-dom misses React onChange for fireEvent.change, so type for real.
  // A full URL cannot carry a folder, so the folder field must reach the API.
  await userEvent.type(
    await view.findByLabelText(/Git URL or owner\/repo/),
    "https://gitlab.com/acme/mono.git"
  );
  await userEvent.type(await view.findByLabelText(/Plugin folder/), " packages/pstack ");
  fireEvent.click(await view.findByRole("button", { name: /Preview/ }));
  await waitFor(() =>
    expect(previewSpy).toHaveBeenCalledWith({
      input: "https://gitlab.com/acme/mono.git",
      ref: null,
      subpath: "packages/pstack",
    })
  );
  await waitFor(() =>
    // The arrow to the target path appears only on the preview card's source line.
    expect(view.container.textContent).toContain("github.com/cursor/plugins/pstack @ main →")
  );
});
