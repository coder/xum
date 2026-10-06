// N10 (#5670): on reload the right sidebar dropped the saved Artifacts tab while experiments loaded,
// then re-added it at the end. Proves the saved tab order is the same after a reload.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground, WORKSPACE_TITLE } from "./helpers";

test(
  "the right sidebar keeps its saved tab order across a reload",
  { tags: ["bugbash", "N10"] },
  async ({ app, screen, browser }) => {
    await openPlayground(app, screen, browser);
    const tablist = screen.getByRole("tablist", "Sidebar views");
    const artifactsTab = tablist.getByRole("tab", /^Artifacts/);
    await expect(artifactsTab).toBeVisible({ timeout: 15_000 });
    // The seeded order has Goal after Artifacts, so moving Artifacts to the end shows.
    const saved = await tablist.getByRole("tab").allTextContents();
    expect(saved.findIndex((tab) => tab.startsWith("Artifacts"))).toBeLessThan(saved.length - 1);

    await browser.reload();
    await expect(screen.getByText(WORKSPACE_TITLE).first()).toBeVisible({ timeout: 15_000 });
    await expect(artifactsTab).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => tablist.getByRole("tab").allTextContents()).toEqual(saved);
  }
);
