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
