import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";
import type { AgentPluginMarketplaceListing } from "@/common/orpc/schemas/agentPlugins";
import { MarketplaceListing } from "./PluginMarketplaceListing";

let cleanupDom: (() => void) | null = null;
beforeEach(() => {
  cleanupDom = installDom();
});
afterEach(() => {
  cleanup();
  cleanupDom?.();
});

const listing: AgentPluginMarketplaceListing = {
  name: "acme-market",
  source: {
    type: "git",
    url: "https://github.com/acme/market.git",
    ref: "main",
    refType: "branch",
  },
  lockedSha: "a".repeat(40),
  entries: [
    { name: "other", sourceKind: "relative", source: "./other", installable: true },
    { name: "docs", sourceKind: "relative", source: "./docs", installable: true },
    // The backend keeps a repeated name and refuses the later row.
    {
      name: "docs",
      sourceKind: "relative",
      source: "./again",
      installable: false,
      reason: "'docs' is listed more than once.",
    },
  ],
  methods: [],
  warnings: [],
};

test("a repeated entry name never makes two checked radios", () => {
  const previewed: string[] = [];
  const view = render(
    <MarketplaceListing
      listing={listing}
      busy={false}
      error={null}
      onBack={() => undefined}
      onPickEntry={() => undefined}
      onPreviewEntry={(entry) => previewed.push(entry)}
      onPickMethod={() => undefined}
    />
  );
  const radios = view.getAllByRole("radio");
  fireEvent.click(radios[1]);

  expect(radios.map((radio) => (radio as HTMLInputElement).checked)).toEqual([false, true, false]);
  fireEvent.click(view.getByRole("button", { name: "Preview docs" }));
  expect(previewed).toEqual(["docs"]);
});
