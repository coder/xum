import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { installDom } from "../../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider } from "@/browser/contexts/API";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type {
  AgentPluginInstallPreview,
  AgentPluginMarketplaceListing,
} from "@/common/orpc/schemas/agentPlugins";
import { PluginsSettingsSection } from "./PluginsSettingsSection";

let cleanupDom: (() => void) | null = null;
beforeEach(() => {
  cleanupDom = installDom();
});
afterEach(() => {
  cleanup();
  cleanupDom?.();
});

const source = {
  type: "git" as const,
  url: "https://github.com/acme/market.git",
  ref: "main",
  refType: "branch" as const,
};

const listing: AgentPluginMarketplaceListing = {
  name: "acme-market",
  source,
  lockedSha: "a".repeat(40),
  entries: [
    {
      name: "first",
      builds: [{ file: "claude", sourceKind: "relative", source: "./first", installable: true }],
    },
    {
      name: "remote",
      builds: [{ file: "claude", sourceKind: "github", source: "acme/tools", installable: true }],
    },
  ],
  methods: [],
  warnings: [],
};

/** An entry whose plugin is another repository: its preview lists skills the CLI could take. */
const remotePreview: AgentPluginInstallPreview = {
  source: { ...source, url: "https://github.com/acme/tools.git" },
  method: { kind: "skills" },
  methods: [{ kind: "skills" }],
  skillsCliSkills: ["pdf"],
  lockedSha: "b".repeat(40),
  manifest: { name: "tools", description: "Tools from another repository" },
  targetPath: "~/.mux/plugins/tools",
  skills: [{ name: "pdf", description: "The pdf skill." }],
  mcpServers: [],
  agents: [],
  readonlyAgents: [],
  workflows: [],
  slashCommands: [],
  reviewedComponents: [],
  codexHooks: [],
  warnings: [],
  notApplied: [],
  consentDigest: "c".repeat(64),
};

test("an entry preview focuses Back and offers no Skills CLI; Back focuses the previewed entry", async () => {
  const api = createMockORPCClient({
    agentPlugins: {
      items: [],
      marketplace: listing,
      previewsByEntry: { remote: remotePreview },
    },
  });
  const view = render(
    <APIProvider client={api}>
      <TooltipProvider>
        <PluginsSettingsSection />
      </TooltipProvider>
    </APIProvider>
  );
  fireEvent.click(await view.findByRole("button", { name: /Add plugin/ }));
  await userEvent.type(await view.findByLabelText(/Git URL or owner\/repo/), "acme/market");
  fireEvent.click(view.getByRole("button", { name: "Preview" }));
  fireEvent.click(await view.findByRole("radio", { name: /remote/ }));
  fireEvent.click(view.getByRole("button", { name: "Preview remote" }));

  await view.findByText("Tools from another repository");
  // The Preview button unmounted with the list: Back takes the focus, not the dialog.
  await waitFor(() =>
    expect(document.activeElement).toBe(view.getByRole("button", { name: /Back/ }))
  );
  // The CLI would install from acme/market, not from the entry's repository.
  expect(view.queryByRole("radio", { name: "Skills CLI" })).toBeNull();

  fireEvent.click(view.getByRole("button", { name: /Back/ }));
  const remote = await view.findByRole("radio", { name: /remote/ });
  expect((remote as HTMLInputElement).checked).toBe(true);
  await waitFor(() => expect(document.activeElement).toBe(remote));
});

test("Back from a Cursor build preview picks the same row; the preview offers no Skills CLI", async () => {
  const api = createMockORPCClient({
    agentPlugins: {
      items: [],
      marketplace: {
        ...listing,
        entries: [
          listing.entries[0],
          {
            name: "pstack",
            builds: [
              { file: "cursor", sourceKind: "relative", source: "pstack", installable: true },
              { file: "claude", sourceKind: "relative", source: "./claude", installable: true },
            ],
          },
        ],
      },
      // The mock answers a cursor-marketplace selector by its kind, a Claude entry by its name.
      previewsByMethod: {
        "cursor-marketplace": {
          ...remotePreview,
          source: { ...source, subpath: "pstack" },
          method: { kind: "cursor-plugin" },
          methods: [{ kind: "cursor-plugin" }],
          manifest: { name: "pstack", description: "The Cursor build of pstack" },
        },
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
  fireEvent.click(await view.findByRole("button", { name: /Add plugin/ }));
  await userEvent.type(await view.findByLabelText(/Git URL or owner\/repo/), "acme/market");
  fireEvent.click(view.getByRole("button", { name: "Preview" }));
  fireEvent.click(await view.findByRole("radio", { name: /pstack/ }));
  fireEvent.click(view.getByRole("button", { name: "Preview Cursor build" }));

  await view.findByText("The Cursor build of pstack");
  expect(view.queryByRole("radio", { name: "Skills CLI" })).toBeNull();

  fireEvent.click(view.getByRole("button", { name: /Back/ }));
  const pstack = await view.findByRole("radio", { name: /pstack/ });
  expect((pstack as HTMLInputElement).checked).toBe(true);
});
