import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { installDom } from "../../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider } from "@/browser/contexts/API";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { AgentPluginInstallPreview } from "@/common/orpc/schemas/agentPlugins";
import type { BackupPluginInstall } from "@/common/orpc/schemas/backup";
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

const PINNED = "1".repeat(40);
const LATEST = "2".repeat(40);

function backedUp(name: string, overrides: Partial<BackupPluginInstall> = {}): BackupPluginInstall {
  return {
    name,
    source: {
      type: "git",
      url: `https://github.com/example/${name}.git`,
      ref: "main",
      refType: "branch",
    },
    lockedSha: PINNED,
    status: "missing",
    ...overrides,
  };
}

/** The preview of a repository at the commit that was asked for, as the backend resolves it. */
function previewOf(
  name: string,
  overrides: Partial<AgentPluginInstallPreview> = {}
): AgentPluginInstallPreview {
  return {
    source: {
      type: "git",
      url: `https://github.com/example/${name}.git`,
      ref: PINNED,
      refType: "commit",
    },
    method: { kind: "agent-plugin" },
    methods: [{ kind: "agent-plugin" }],
    skillsCliSkills: [],
    lockedSha: PINNED,
    manifest: { name },
    skills: [],
    mcpServers: [],
    agents: [],
    readonlyAgents: [],
    shellRemovedAgents: [],
    workflows: [],
    slashCommands: [],
    reviewedComponents: [],
    codexHooks: [],
    fileChanges: [],
    warnings: [],
    notApplied: [],
    targetPath: `~/.mux/plugins/${name}`,
    consentDigest: `digest-${name}`,
    ...overrides,
  };
}

/** The section with a backup reinstall waiting for it, as the Backup section leaves it. */
function renderWithBackup(
  plugins: BackupPluginInstall[],
  previews: Record<string, AgentPluginInstallPreview>
) {
  const api = createMockORPCClient({ agentPlugins: { items: [] } });
  const previewSpy = spyOn(api.agentPlugins, "preview").mockImplementation((input) => {
    const found = Object.entries(previews).find(([name]) => input.input.includes(`/${name}.git`));
    return Promise.resolve(
      found
        ? { success: true as const, data: { kind: "plugin" as const, preview: found[1] } }
        : { success: false as const, error: `Could not fetch ${input.input}` }
    );
  });
  const installSpy = spyOn(api.agentPlugins, "install");
  const listSpy = spyOn(api.agentPlugins, "listForSettings");
  publishPluginsSectionIntent({ type: "install-from-backup", plugins });
  const view = render(
    <APIProvider client={api}>
      <TooltipProvider>
        <PluginsSettingsSection />
      </TooltipProvider>
    </APIProvider>
  );
  return { api, view, previewSpy, installSpy, listSpy };
}

const header = (view: RenderResult) => view.container.textContent ?? "";

async function clickButton(view: RenderResult, name: RegExp) {
  fireEvent.click(await view.findByRole("button", { name }));
}

test("previews the pinned commit of the first backed-up plugin and installs it tracking its branch", async () => {
  const { view, previewSpy, installSpy } = renderWithBackup([backedUp("alpha"), backedUp("beta")], {
    alpha: previewOf("alpha", { consentDigest: "digest-alpha" }),
    beta: previewOf("beta"),
  });

  await waitFor(() => expect(header(view)).toContain("From backup: 1 of 2"));
  expect(header(view)).toContain("alpha");
  await waitFor(() =>
    expect(previewSpy).toHaveBeenCalledWith({
      input: "https://github.com/example/alpha.git",
      // The commit the plugin was pinned to, not the branch it tracks.
      ref: PINNED,
      subpath: null,
      method: null,
    })
  );
  await clickButton(view, /^Install$/);

  await waitFor(() => expect(installSpy).toHaveBeenCalledTimes(1));
  expect(installSpy.mock.calls[0]?.[0]).toMatchObject({
    // Sits at the pinned commit, still tracking the branch it came from.
    source: {
      url: "https://github.com/example/alpha.git",
      ref: "main",
      refType: "branch",
    },
    expectedSha: PINNED,
    expectedConsentDigest: "digest-alpha",
  });
});

test("moves to the next plugin after an install, and closes after the last with the list refreshed", async () => {
  const { view, previewSpy, listSpy } = renderWithBackup([backedUp("alpha"), backedUp("beta")], {
    alpha: previewOf("alpha"),
    beta: previewOf("beta"),
  });
  await waitFor(() => expect(header(view)).toContain("From backup: 1 of 2"));
  await waitFor(() => view.getByRole("button", { name: /^Install$/ }));
  const listCallsBefore = listSpy.mock.calls.length;

  await clickButton(view, /^Install$/);
  await waitFor(() => expect(header(view)).toContain("From backup: 2 of 2"));
  await waitFor(() =>
    expect(previewSpy).toHaveBeenCalledWith(
      expect.objectContaining({ input: "https://github.com/example/beta.git", ref: PINNED })
    )
  );
  await waitFor(() => view.getByRole("button", { name: /^Install$/ }));
  await clickButton(view, /^Install$/);

  await waitFor(() => expect(header(view)).not.toContain("From backup"));
  expect(view.queryByRole("button", { name: /^Install$/ })).toBeNull();
  expect(header(view)).toContain("Plugin installed.");
  expect(listSpy.mock.calls.length).toBeGreaterThan(listCallsBefore);
});

test("skip leaves a plugin out without installing it", async () => {
  const { view, installSpy } = renderWithBackup([backedUp("alpha"), backedUp("beta")], {
    alpha: previewOf("alpha"),
    beta: previewOf("beta"),
  });
  await waitFor(() => view.getByRole("button", { name: /^Install$/ }));

  await clickButton(view, /^Skip$/);
  await waitFor(() => expect(header(view)).toContain("From backup: 2 of 2"));
  await waitFor(() => view.getByRole("button", { name: /^Install$/ }));
  await clickButton(view, /^Skip$/);

  await waitFor(() => expect(header(view)).not.toContain("From backup"));
  expect(installSpy).not.toHaveBeenCalled();
  // Nothing was installed, so there is no install notice.
  expect(header(view)).not.toContain("Plugin installed.");
});

test("a failed preview shows its error and lets the user skip to the next plugin", async () => {
  const { view } = renderWithBackup([backedUp("gone"), backedUp("beta")], {
    beta: previewOf("beta"),
  });

  await waitFor(() =>
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("Could not fetch")
  );
  expect(header(view)).toContain("From backup: 1 of 2");

  await clickButton(view, /^Skip$/);
  await waitFor(() => view.getByRole("button", { name: /^Install$/ }));
  expect(header(view)).toContain("From backup: 2 of 2");
});

test("preselects only the components the backup kept that the preview still offers", async () => {
  const { view, installSpy } = renderWithBackup(
    [
      backedUp("alpha", {
        importedComponents: { skills: ["keep", "removed-upstream"], mcpServers: [] },
      }),
    ],
    {
      alpha: previewOf("alpha", {
        skills: [{ name: "keep" }, { name: "dropped-by-user" }, { name: "new-upstream" }],
        mcpServers: [{ serverName: "docs", transport: "http", summary: "https://docs.example" }],
      }),
    }
  );
  await waitFor(() => view.getByRole("button", { name: /^Install$/ }));

  await clickButton(view, /^Install$/);

  await waitFor(() => expect(installSpy).toHaveBeenCalledTimes(1));
  expect(installSpy.mock.calls[0]?.[0].importedComponents).toEqual({
    skills: ["keep"],
    mcpServers: [],
  });
});

test("a plugin without a recorded choice starts with everything the preview offers selected", async () => {
  const { view, installSpy } = renderWithBackup([backedUp("alpha")], {
    alpha: previewOf("alpha", { skills: [{ name: "one" }, { name: "two" }] }),
  });
  await waitFor(() => view.getByRole("button", { name: /^Install$/ }));

  await clickButton(view, /^Install$/);

  await waitFor(() => expect(installSpy).toHaveBeenCalledTimes(1));
  expect(installSpy.mock.calls[0]?.[0].importedComponents).toEqual({
    skills: ["one", "two"],
    mcpServers: [],
  });
});

test("a marketplace entry is previewed by its entry, not by a folder inside the marketplace", async () => {
  const entry = backedUp("market-plugin", {
    source: {
      type: "git",
      url: "https://github.com/example/market-plugin.git",
      ref: "main",
      refType: "branch",
      subpath: "plugins/market-plugin",
    },
    method: { kind: "claude-marketplace", entry: "Market-Plugin" },
  });
  const { view, previewSpy } = renderWithBackup([entry], {
    "market-plugin": previewOf("market-plugin", {
      method: { kind: "claude-marketplace", entry: "Market-Plugin" },
    }),
  });

  await waitFor(() =>
    expect(previewSpy).toHaveBeenCalledWith({
      input: "https://github.com/example/market-plugin.git",
      ref: PINNED,
      subpath: null,
      method: { kind: "claude-marketplace", entry: "Market-Plugin" },
    })
  );
  await waitFor(() => view.getByRole("button", { name: /^Install$/ }));
});

test("a monorepo plugin keeps its folder in the preview", async () => {
  const entry = backedUp("mono", {
    source: {
      type: "git",
      url: "https://github.com/example/mono.git",
      ref: "v1.0.0",
      refType: "tag",
      subpath: "packages/mono",
    },
  });
  const { previewSpy } = renderWithBackup([entry], {});

  await waitFor(() =>
    expect(previewSpy).toHaveBeenCalledWith(
      expect.objectContaining({ subpath: "packages/mono", ref: PINNED })
    )
  );
});

test("the ordinary add flow installs the source its own preview resolved", async () => {
  const api = createMockORPCClient({
    agentPlugins: { items: [], preview: previewOf("alpha", { lockedSha: LATEST }) },
  });
  const installSpy = spyOn(api.agentPlugins, "install");
  const view = render(
    <APIProvider client={api}>
      <TooltipProvider>
        <PluginsSettingsSection />
      </TooltipProvider>
    </APIProvider>
  );

  fireEvent.click(await view.findByRole("button", { name: /Add plugin/ }));
  expect(header(view)).not.toContain("From backup");
  await userEvent.type(
    await view.findByLabelText(/Git URL or owner\/repo/),
    "https://github.com/example/alpha.git"
  );
  await clickButton(view, /^Preview$/);
  await clickButton(view, /^Install$/);

  await waitFor(() => expect(installSpy).toHaveBeenCalledTimes(1));
  expect(installSpy.mock.calls[0]?.[0]).toMatchObject({
    source: { ref: PINNED, refType: "commit" },
    expectedSha: LATEST,
  });
  await waitFor(() => expect(header(view)).toContain("Plugin installed."));
});
