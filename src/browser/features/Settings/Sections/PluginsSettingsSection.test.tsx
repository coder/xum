import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { createTestApiClient, type TestApiOverrides } from "@/browser/testUtils";
import type { BackupPluginRecipe } from "@/common/config/schemas/settingsBackup";
import type { BackupPendingPlugin } from "@/common/orpc/schemas/backup";
import type { AgentPluginInstallPreview } from "@/common/orpc/schemas/agentPlugins";
import { installDom } from "../../../../../tests/ui/dom";

import { PluginsSettingsSection } from "./PluginsSettingsSection";
import { publishPluginsSectionIntent } from "./pluginsSectionIntents";

const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

const GRILL: BackupPluginRecipe = {
  name: "grill",
  source: {
    type: "git",
    url: "https://github.com/example/grill.git",
    ref: "main",
    refType: "branch",
  },
  lockedSha: SHA,
  importedComponents: { skills: ["grill"], mcpServers: [] },
};

const FORK: BackupPluginRecipe = {
  name: "forked",
  source: {
    type: "git",
    url: "https://github.com/someone-else/forked.git",
    ref: "v1",
    refType: "tag",
  },
  lockedSha: "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1",
};

function previewFor(input: { ref?: string | null }): AgentPluginInstallPreview {
  const pinned = input.ref === SHA;
  return {
    source: {
      type: "git",
      url: GRILL.source.url,
      ref: pinned ? SHA : "main",
      refType: pinned ? "commit" : "branch",
    },
    lockedSha: pinned ? SHA : "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2",
    manifest: { name: "grill" },
    skills: [
      { name: "grill", description: "Stress-test a plan." },
      { name: "grill-lite", description: "A gentler grilling." },
    ],
    mcpServers: [{ serverName: "grill-db", transport: "stdio", summary: "node server.js" }],
    agents: [],
    workflows: [],
    slashCommands: [],
    warnings: [],
    targetPath: "~/.xum/plugins/grill",
  };
}

function renderSection(options: { pending: BackupPendingPlugin[] }) {
  let pending = options.pending;
  const preview = mock((input: { input: string; ref?: string | null; subpath?: string | null }) =>
    Promise.resolve({ success: true as const, data: previewFor(input) })
  );
  const install = mock((input: Parameters<APIClient["agentPlugins"]["install"]>[0]) => {
    pending = [];
    return Promise.resolve({
      success: true as const,
      data: {
        name: "grill",
        scope: "global" as const,
        source: input.source,
        lockedSha: input.expectedSha,
        installedAt: "2026-09-28T00:00:00.000Z",
      },
    });
  });
  const api = {
    agentPlugins: {
      list: () => Promise.resolve({ success: true as const, data: [] }),
      checkUpdates: () => Promise.resolve({ success: true as const, data: [] }),
      containerLocation: () => Promise.resolve("~/.xum/plugins"),
      preview,
      install,
    },
    backup: {
      getPluginRecipes: () => Promise.resolve({ success: true as const, data: pending }),
    },
  } satisfies TestApiOverrides<APIClient>;

  const view = render(
    <APIProvider client={createTestApiClient(api)}>
      <PluginsSettingsSection />
    </APIProvider>
  );
  return { view, preview, install };
}

function inputValue(element: HTMLElement): string {
  return (element as HTMLInputElement).value;
}

describe("PluginsSettingsSection settings-backup recipes", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("installs a recipe at its recorded commit and selection only after the consent preview", async () => {
    const { view, preview, install } = renderSection({
      pending: [
        { recipe: GRILL, conflict: false },
        { recipe: FORK, conflict: true },
      ],
    });

    await view.findByText("From your settings backup");
    expect(view.getByText("conflict")).toBeTruthy();
    // A conflicting name would be refused by the installer, so it is never offered.
    expect(view.queryByRole("button", { name: "Review and install forked" })).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Review and install grill" }));
    expect(inputValue(view.getByLabelText("Git URL or owner/repo"))).toBe(GRILL.source.url);
    expect(inputValue(view.getByLabelText(/Branch, tag, or commit SHA/))).toBe(SHA);
    expect(preview).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("button", { name: "Preview" }));
    await view.findByRole("group", { name: "Skills" });
    expect(preview).toHaveBeenCalledWith({ input: GRILL.source.url, ref: SHA });
    expect(view.getByRole("checkbox", { name: "grill" }).getAttribute("aria-checked")).toBe("true");
    expect(view.getByRole("checkbox", { name: "grill-lite" }).getAttribute("aria-checked")).toBe(
      "false"
    );
    expect(view.getByRole("checkbox", { name: "grill-db" }).getAttribute("aria-checked")).toBe(
      "false"
    );
    expect(install).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    expect(install.mock.calls[0]?.[0]).toEqual({
      source: previewFor({ ref: SHA }).source,
      expectedSha: SHA,
      importedComponents: { skills: ["grill"], mcpServers: [] },
    });
    await waitFor(() => expect(view.queryByText("From your settings backup")).toBeNull());
  });

  test("drops the recorded selection once the form names a different commit", async () => {
    const { view, preview } = renderSection({ pending: [{ recipe: GRILL, conflict: false }] });

    fireEvent.click(await view.findByRole("button", { name: "Review and install grill" }));
    const refInput = view.getByLabelText(/Branch, tag, or commit SHA/);
    const user = userEvent.setup({ document: refInput.ownerDocument });
    await user.clear(refInput);
    await user.type(refInput, "main");
    fireEvent.click(view.getByRole("button", { name: "Preview" }));
    await view.findByRole("group", { name: "Skills" });

    expect(preview).toHaveBeenCalledWith({ input: GRILL.source.url, ref: "main" });
    expect(view.getByRole("checkbox", { name: "grill-lite" }).getAttribute("aria-checked")).toBe(
      "true"
    );
    expect(view.getByRole("checkbox", { name: "grill-db" }).getAttribute("aria-checked")).toBe(
      "true"
    );
  });

  test("opens the prefilled form from a palette intent published before the section mounts", async () => {
    publishPluginsSectionIntent({ type: "install-from-backup", recipe: GRILL });
    const { view, preview } = renderSection({ pending: [{ recipe: GRILL, conflict: false }] });

    expect(inputValue(await view.findByLabelText("Git URL or owner/repo"))).toBe(GRILL.source.url);
    expect(inputValue(view.getByLabelText(/Branch, tag, or commit SHA/))).toBe(SHA);
    expect(preview).not.toHaveBeenCalled();
  });
});
