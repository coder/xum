import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";
import type {
  AgentPluginMarketplaceBuild,
  AgentPluginMarketplaceEntry,
  AgentPluginMarketplaceListing,
} from "@/common/orpc/schemas/agentPlugins";
import { MarketplaceListing, type MarketplaceEntrySelector } from "./PluginMarketplaceListing";

let cleanupDom: (() => void) | null = null;
beforeEach(() => {
  cleanupDom = installDom();
});
afterEach(() => {
  cleanup();
  cleanupDom?.();
});

const NPM_REASON = "Xum does not install npm packages. Only git sources install.";

function build(
  file: AgentPluginMarketplaceBuild["file"],
  fields: Partial<AgentPluginMarketplaceBuild> = {}
): AgentPluginMarketplaceBuild {
  return { file, sourceKind: "relative", source: `./${file}`, installable: true, ...fields };
}

function listingOf(entries: AgentPluginMarketplaceEntry[]): AgentPluginMarketplaceListing {
  return {
    name: "acme-market",
    source: {
      type: "git",
      url: "https://github.com/acme/market.git",
      ref: "main",
      refType: "branch",
    },
    lockedSha: "a".repeat(40),
    entries,
    methods: [],
    warnings: [],
  };
}

function renderListing(listing: AgentPluginMarketplaceListing) {
  const previewed: MarketplaceEntrySelector[] = [];
  const view = render(
    <MarketplaceListing
      listing={listing}
      busy={false}
      error={null}
      onBack={() => undefined}
      onPickEntry={() => undefined}
      onPreviewEntry={(selector) => previewed.push(selector)}
      onPickMethod={() => undefined}
    />
  );
  return { view, previewed };
}

test("a repeated entry name never makes two checked radios", () => {
  const { view, previewed } = renderListing(
    listingOf([
      { name: "other", builds: [build("claude", { source: "./other" })] },
      { name: "docs", builds: [build("claude", { source: "./docs" })] },
      // The backend keeps a repeated name and refuses the later row.
      {
        name: "docs",
        builds: [
          build("claude", {
            source: "./again",
            installable: false,
            reason: "'docs' is listed more than once.",
          }),
        ],
      },
    ])
  );
  const radios = view.getAllByRole("radio");
  fireEvent.click(radios[1]);

  expect(radios.map((radio) => (radio as HTMLInputElement).checked)).toEqual([false, true, false]);
  fireEvent.click(view.getByRole("button", { name: "Preview docs" }));
  expect(previewed).toEqual([{ kind: "claude-marketplace", entry: "docs" }]);
});

test("a name in both marketplace files has one row whose two actions preview their own build", () => {
  const { view, previewed } = renderListing(
    listingOf([{ name: "pstack", builds: [build("cursor"), build("claude")] }])
  );

  expect(view.getAllByRole("radio")).toHaveLength(1);
  expect(view.queryByRole("button", { name: "Preview pstack" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Preview Cursor build" }));
  fireEvent.click(view.getByRole("button", { name: "Preview Claude build" }));
  expect(previewed).toEqual([
    { kind: "cursor-marketplace", entry: "pstack" },
    { kind: "claude-marketplace", entry: "pstack" },
  ]);
});

test("a refused build's action is disabled and its reason shows, while the other build previews", () => {
  const { view, previewed } = renderListing(
    listingOf([
      {
        name: "pstack",
        builds: [
          build("cursor", { sourceKind: "npm", installable: false, reason: NPM_REASON }),
          build("claude"),
        ],
      },
    ])
  );

  view.getByText(NPM_REASON);
  const cursor = view.getByRole("button", { name: "Preview Cursor build" });
  expect((cursor as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(cursor);
  fireEvent.click(view.getByRole("button", { name: "Preview Claude build" }));
  expect(previewed).toEqual([{ kind: "claude-marketplace", entry: "pstack" }]);
});

test("a row whose only installable build is the Claude one is picked first", () => {
  const { view } = renderListing(
    listingOf([
      {
        name: "pstack",
        builds: [
          build("cursor", { sourceKind: "npm", installable: false, reason: NPM_REASON }),
          build("claude"),
        ],
      },
      { name: "other", builds: [build("cursor")] },
    ])
  );

  const radios = view.getAllByRole("radio") as HTMLInputElement[];
  expect(radios.map((radio) => radio.checked)).toEqual([true, false]);
  expect(radios[0].disabled).toBe(false);
});

test("a name in all three marketplace files has an action per build; the Agent Plugins one selects its own file", () => {
  const { view, previewed } = renderListing(
    listingOf([{ name: "e2e", builds: [build("cursor"), build("claude"), build("agents")] }])
  );

  expect(view.queryByRole("button", { name: "Preview e2e" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Preview Agent Plugins build" }));
  expect(previewed).toEqual([{ kind: "agents-marketplace", entry: "e2e" }]);
});

test("a refused Agent Plugins build is disabled with its reason while the other builds preview", () => {
  const reason = "The marketplace marks this plugin policy.installation NOT_AVAILABLE.";
  const { view, previewed } = renderListing(
    listingOf([
      {
        name: "e2e",
        builds: [build("cursor"), build("agents", { installable: false, reason })],
      },
    ])
  );

  view.getByText(reason);
  const agents = view.getByRole("button", { name: "Preview Agent Plugins build" });
  expect((agents as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(agents);
  fireEvent.click(view.getByRole("button", { name: "Preview Cursor build" }));
  expect(previewed).toEqual([{ kind: "cursor-marketplace", entry: "e2e" }]);
});

test("the header names every marketplace file the rows come from, in build order", () => {
  const header = (entries: AgentPluginMarketplaceEntry[]) => {
    const { view } = renderListing(listingOf(entries));
    const text = view.getByText(/[Mm]arketplaces? ·/).textContent;
    view.unmount();
    return text;
  };

  expect(header([{ name: "a", builds: [build("agents")] }])).toBe(
    "Agent Plugins marketplace · 1 plugin"
  );
  expect(header([{ name: "a", builds: [build("claude"), build("cursor")] }])).toBe(
    "Cursor and Claude Code marketplaces · 1 plugin"
  );
  // The files come from all rows, not the first: a row of the last file alone does not hide Cursor.
  expect(
    header([
      { name: "a", builds: [build("agents")] },
      { name: "b", builds: [build("claude")] },
      { name: "c", builds: [build("cursor")] },
    ])
  ).toBe("Cursor, Claude Code and Agent Plugins marketplaces · 3 plugins");
  // A marketplace that lists nothing names no file.
  expect(header([])).toBe("Marketplace · 0 plugins");
});
