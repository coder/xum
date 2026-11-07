import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { installDom } from "../../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIContext, APIProvider, type UseAPIResult } from "@/browser/contexts/API";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { AgentPluginInstallPreview } from "@/common/orpc/schemas/agentPlugins";
import type { BackupPluginEntry } from "@/common/orpc/schemas/backup";
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

function backedUp(name: string, overrides: Partial<BackupPluginEntry> = {}): BackupPluginEntry {
  return {
    name,
    source: {
      type: "git",
      url: `https://github.com/example/${name}.git`,
      ref: "main",
      refType: "branch",
    },
    lockedSha: PINNED,
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

/** A repository's preview, or one that depends on the ref the user asked for. */
type PreviewOf =
  | AgentPluginInstallPreview
  | ((ref: string | null | undefined) => AgentPluginInstallPreview);

/** A client whose preview answers from `previews` by repository name, and the spies on it. */
function previewingClient(previews: Record<string, PreviewOf>) {
  const api = createMockORPCClient({ agentPlugins: { items: [] } });
  const previewSpy = spyOn(api.agentPlugins, "preview").mockImplementation((input) => {
    const found = Object.entries(previews).find(([name]) => input.input.includes(`/${name}.git`));
    return Promise.resolve(
      found
        ? {
            success: true as const,
            data: {
              kind: "plugin" as const,
              preview: typeof found[1] === "function" ? found[1](input.ref) : found[1],
            },
          }
        : { success: false as const, error: `Could not fetch ${input.input}` }
    );
  });
  const installSpy = spyOn(api.agentPlugins, "install");
  const listSpy = spyOn(api.agentPlugins, "listForSettings");
  return { api, previewSpy, installSpy, listSpy };
}

/** The section with a backup reinstall waiting for it, as the Backup section leaves it. */
function renderWithBackup(plugins: BackupPluginEntry[], previews: Record<string, PreviewOf>) {
  const { api, previewSpy, installSpy, listSpy } = previewingClient(previews);
  publishPluginsSectionIntent({ type: "install-from-backup", entries: plugins });
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

test("keeps tracking the backup's branch when the user fixed the URL and the preview resolved the pinned commit", async () => {
  const { view, installSpy } = renderWithBackup(
    [
      backedUp("alpha", {
        source: {
          type: "git",
          url: "git@github.com:example/alpha.git",
          ref: "main",
          refType: "branch",
        },
      }),
    ],
    { alpha: previewOf("alpha") }
  );
  await waitFor(() => view.getByRole("button", { name: /^Install$/ }));

  await clickButton(view, /^Install$/);

  await waitFor(() => expect(installSpy).toHaveBeenCalledTimes(1));
  expect(installSpy.mock.calls[0]?.[0]).toMatchObject({
    source: { url: "https://github.com/example/alpha.git", ref: "main", refType: "branch" },
    expectedSha: PINNED,
  });
});

const ALPHA_URL = "https://github.com/example/alpha.git";

test.each([
  {
    label: "another commit than the pinned one",
    typed: LATEST,
    resolved: {
      source: { type: "git", url: ALPHA_URL, ref: LATEST, refType: "commit" },
      lockedSha: LATEST,
    },
  },
  {
    label: "another branch",
    typed: "develop",
    resolved: {
      source: { type: "git", url: ALPHA_URL, ref: "develop", refType: "branch" },
      lockedSha: LATEST,
    },
  },
  {
    label: "a branch whose tip is the pinned commit",
    typed: "develop",
    resolved: {
      source: { type: "git", url: ALPHA_URL, ref: "develop", refType: "branch" },
      lockedSha: PINNED,
    },
  },
] as const)(
  "records what the user previewed, not the backup's branch, after editing the ref to $label",
  async ({ typed, resolved }) => {
    // The pinned commit until the user asks for another ref, then what that ref resolves to here.
    const resolve = (ref: string | null | undefined) =>
      ref === typed ? previewOf("alpha", resolved) : previewOf("alpha");
    const { view, installSpy } = renderWithBackup([backedUp("alpha")], { alpha: resolve });
    await waitFor(() => view.getByRole("button", { name: /^Install$/ }));
    await clickButton(view, /^Back$/);
    const refField = await view.findByLabelText(/Branch, tag, or commit SHA/);
    // Replaces the pinned commit the form was filled with.
    await userEvent.type(refField, typed, {
      initialSelectionStart: 0,
      initialSelectionEnd: PINNED.length,
    });
    await clickButton(view, /^Preview$/);
    await waitFor(() => view.getByRole("button", { name: /^Install$/ }));

    await clickButton(view, /^Install$/);

    await waitFor(() => expect(installSpy).toHaveBeenCalledTimes(1));
    expect(installSpy.mock.calls[0]?.[0]).toMatchObject({
      source: { ref: resolved.source.ref, refType: resolved.source.refType },
      expectedSha: resolved.lockedSha,
    });
  }
);

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

test("a plugin Xum generated a plugin.json for is previewed with that method", async () => {
  const entry = backedUp("skills-repo", { method: { kind: "skills" } });
  const { view, previewSpy } = renderWithBackup([entry], {
    "skills-repo": previewOf("skills-repo", { method: { kind: "skills" } }),
  });

  await waitFor(() =>
    expect(previewSpy).toHaveBeenCalledWith({
      input: "https://github.com/example/skills-repo.git",
      ref: PINNED,
      subpath: null,
      method: { kind: "skills" },
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

test("previews the first plugin once, when the API arrives after the panel mounted", async () => {
  const { api, previewSpy } = previewingClient({ alpha: previewOf("alpha") });
  const apiState = (state: "connecting" | "connected"): UseAPIResult =>
    state === "connecting"
      ? {
          status: "connecting",
          api: null,
          error: null,
          authenticate: () => undefined,
          retry: () => undefined,
        }
      : {
          status: "connected",
          api,
          error: null,
          authenticate: () => undefined,
          retry: () => undefined,
        };
  const tree = (state: "connecting" | "connected") => (
    <APIContext.Provider value={apiState(state)}>
      <TooltipProvider>
        <PluginsSettingsSection />
      </TooltipProvider>
    </APIContext.Provider>
  );
  publishPluginsSectionIntent({ type: "install-from-backup", entries: [backedUp("alpha")] });

  const view = render(tree("connecting"));
  await waitFor(() => expect(header(view)).toContain("From backup: 1 of 1"));
  expect(previewSpy).not.toHaveBeenCalled();
  view.rerender(tree("connected"));

  await waitFor(() => view.getByRole("button", { name: /^Install$/ }));
  expect(previewSpy).toHaveBeenCalledTimes(1);
  expect(previewSpy.mock.calls[0]?.[0]).toMatchObject({ ref: PINNED });
});

test("under StrictMode, the result of the discarded first mount is not shown", async () => {
  const { api, previewSpy } = previewingClient({ alpha: previewOf("alpha") });
  // StrictMode mounts the panel, unmounts it and mounts it again: two requests, the first of
  // which belongs to a mount that is gone.
  previewSpy.mockResolvedValueOnce({ success: false, error: "answer of the discarded mount" });
  publishPluginsSectionIntent({ type: "install-from-backup", entries: [backedUp("alpha")] });

  const view = render(
    <React.StrictMode>
      <APIProvider client={api}>
        <TooltipProvider>
          <PluginsSettingsSection />
        </TooltipProvider>
      </APIProvider>
    </React.StrictMode>
  );

  await waitFor(() => view.getByRole("button", { name: /^Install$/ }));
  expect(header(view)).not.toContain("answer of the discarded mount");
  expect(previewSpy).toHaveBeenCalledTimes(2);
});

test.each([
  { refType: "branch", ref: "main", recorded: { ref: "main", refType: "branch" } },
  { refType: "tag", ref: "v1.2.0", recorded: { ref: "v1.2.0", refType: "tag" } },
  // A row that pins a commit has no branch or tag to track, whatever its `ref` says.
  { refType: "commit", ref: "main", recorded: { ref: PINNED, refType: "commit" } },
] as const)(
  "records $recorded.refType for a backed-up $refType row",
  async ({ refType, ref, recorded }) => {
    const { view, installSpy } = renderWithBackup(
      [
        backedUp("alpha", {
          source: { type: "git", url: ALPHA_URL, ref, refType },
        }),
      ],
      { alpha: previewOf("alpha") }
    );
    await waitFor(() => view.getByRole("button", { name: /^Install$/ }));

    await clickButton(view, /^Install$/);

    await waitFor(() => expect(installSpy).toHaveBeenCalledTimes(1));
    expect(installSpy.mock.calls[0]?.[0].source).toMatchObject(recorded);
  }
);

test("the backup's component choice applies to the pinned commit only, not to another preview", async () => {
  const offered = {
    skills: [{ name: "keep" }, { name: "other" }],
  };
  const resolve = (ref: string | null | undefined) =>
    ref === "develop"
      ? previewOf("alpha", {
          ...offered,
          source: { type: "git", url: ALPHA_URL, ref: "develop", refType: "branch" },
          lockedSha: LATEST,
        })
      : previewOf("alpha", offered);
  const { view, installSpy } = renderWithBackup(
    [backedUp("alpha", { importedComponents: { skills: ["keep"], mcpServers: [] } })],
    { alpha: resolve }
  );
  await waitFor(() => view.getByRole("button", { name: /^Install$/ }));
  await clickButton(view, /^Back$/);
  await userEvent.type(await view.findByLabelText(/Branch, tag, or commit SHA/), "develop", {
    initialSelectionStart: 0,
    initialSelectionEnd: PINNED.length,
  });
  await clickButton(view, /^Preview$/);
  await waitFor(() => view.getByRole("button", { name: /^Install$/ }));

  await clickButton(view, /^Install$/);

  await waitFor(() => expect(installSpy).toHaveBeenCalledTimes(1));
  expect(installSpy.mock.calls[0]?.[0].importedComponents).toEqual({
    skills: ["keep", "other"],
    mcpServers: [],
  });
});

test("cancelling after an install still reports it", async () => {
  const { view, installSpy } = renderWithBackup([backedUp("alpha"), backedUp("gone")], {
    alpha: previewOf("alpha"),
  });
  await waitFor(() => view.getByRole("button", { name: /^Install$/ }));
  await clickButton(view, /^Install$/);
  await waitFor(() => expect(header(view)).toContain("From backup: 2 of 2"));
  await waitFor(() =>
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("Could not fetch")
  );

  await clickButton(view, /^Cancel$/);

  await waitFor(() => expect(header(view)).not.toContain("From backup"));
  expect(installSpy).toHaveBeenCalledTimes(1);
  expect(header(view)).toContain("Plugin installed.");
});

test("cancelling before any install closes the queue without an install notice", async () => {
  const { view, installSpy } = renderWithBackup([backedUp("gone"), backedUp("alpha")], {
    alpha: previewOf("alpha"),
  });
  await waitFor(() =>
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("Could not fetch")
  );

  await clickButton(view, /^Cancel$/);

  await waitFor(() => expect(header(view)).not.toContain("From backup"));
  expect(installSpy).not.toHaveBeenCalled();
  expect(header(view)).not.toContain("Plugin installed.");
});

test("a backup reinstall replaces the plain Add plugin panel that is already open", async () => {
  const { api, previewSpy } = previewingClient({ alpha: previewOf("alpha") });
  const view = render(
    <APIProvider client={api}>
      <TooltipProvider>
        <PluginsSettingsSection />
      </TooltipProvider>
    </APIProvider>
  );
  fireEvent.click(await view.findByRole("button", { name: /Add plugin/ }));
  await view.findByLabelText(/Git URL or owner\/repo/);
  expect(header(view)).not.toContain("From backup");

  act(() => {
    publishPluginsSectionIntent({ type: "install-from-backup", entries: [backedUp("alpha")] });
  });

  await waitFor(() => expect(header(view)).toContain("From backup: 1 of 1"));
  await waitFor(() => view.getByRole("button", { name: /^Install$/ }));
  expect(previewSpy).toHaveBeenCalledTimes(1);
});

test("a second backup reinstall starts again from its own first plugin", async () => {
  const { api } = previewingClient({ alpha: previewOf("alpha"), beta: previewOf("beta") });
  const view = render(
    <APIProvider client={api}>
      <TooltipProvider>
        <PluginsSettingsSection />
      </TooltipProvider>
    </APIProvider>
  );
  await view.findByRole("button", { name: /Add plugin/ });
  act(() => {
    publishPluginsSectionIntent({
      type: "install-from-backup",
      entries: [backedUp("alpha"), backedUp("beta")],
    });
  });
  await waitFor(() => view.getByRole("button", { name: /^Install$/ }));
  await clickButton(view, /^Skip$/);
  await waitFor(() => expect(header(view)).toContain("From backup: 2 of 2"));

  act(() => {
    publishPluginsSectionIntent({ type: "install-from-backup", entries: [backedUp("alpha")] });
  });

  await waitFor(() => expect(header(view)).toContain("From backup: 1 of 1"));
  await waitFor(() => view.getByRole("button", { name: /^Install$/ }));
});
