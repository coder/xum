// #5681, #5687, #5688, #5693: keyboard focus, labels and shortcut feedback. Each test fails on
// the old code.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { disableTutorials, openPlayground } from "./helpers";

test(
  "Ctrl+I focuses the composer on the new-workspace screen",
  { tags: ["bugbash", "5687"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await disableTutorials(app);
    await app.open();
    const composer = screen.getByRole("textbox", "Message");
    await expect(composer).toBeVisible({ timeout: 15_000 });
    // The screen opens with the composer focused, so move focus away first.
    await browser.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      return null;
    });
    await expect(composer).not.toBeFocused();

    await browser.keyboard.press("Control+i");
    await expect(composer).toBeFocused();

    // With the command palette open, Ctrl+I leaves focus in the palette.
    await browser.keyboard.press("Control+Shift+P");
    const palette = screen.getByRole("combobox", "Command palette");
    await expect(palette).toBeFocused();
    await browser.keyboard.press("Control+i");
    await expect(palette).toBeFocused();
  }
);

test(
  "The right sidebar's collapse button shows a focus ring",
  { tags: ["bugbash", "5688"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    const collapse = screen
      .getByRole("complementary", "Workspace insights")
      .getByRole("button", "Collapse sidebar");
    await expect(collapse).toBeVisible();
    // A key press first, so the browser treats the next focus as keyboard focus (:focus-visible).
    await browser.keyboard.press("Shift");
    await collapse.focus();

    await expect
      .poll(() =>
        browser.evaluate(() => {
          const el = document.activeElement;
          if (!(el instanceof HTMLElement) || !el.matches(":focus-visible"))
            return "no focus-visible";
          return getComputedStyle(el).boxShadow;
        })
      )
      .not.toMatch(/^(none|no focus-visible)$/);
  }
);

test(
  "The workspace actions tooltip uses the button's accessible name",
  { tags: ["bugbash", "5681"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    await screen.getByRole("button", "Workspace actions").hover();

    await expect(screen.getByRole("tooltip")).toHaveText("Workspace actions");
  }
);

test(
  "The fast mode shortcut explains why fast mode is unavailable",
  { tags: ["bugbash", "5693"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    // The seeded Anthropic provider uses a loopback base URL, so fast mode is unavailable.
    await openPlayground(app, screen, browser);
    await screen.getByRole("textbox", "Message").tap();

    await browser.keyboard.press("Control+Shift+F");
    await expect(screen.getByText(/^Fast mode is not available/)).toBeVisible();
  }
);

test(
  "Ctrl+I in the workspace view leaves focus in the command palette",
  { tags: ["bugbash", "5752"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    await screen.getByRole("textbox", "Message").tap();

    await browser.keyboard.press("Control+Shift+P");
    const palette = screen.getByRole("combobox", "Command palette");
    await expect(palette).toBeFocused();
    await browser.keyboard.press("Control+i");
    await expect(palette).toBeFocused();
  }
);

test(
  "The fast mode shortcut says when the model has no fast mode",
  // mock-only: the test switches the shared workspace's model and must put it back. With mock AI
  // the workspace starts on Opus 5.5. Real mode starts it on BUGBASH_APP_MODEL, which can be any
  // model, and the model search matches ids, not the labels the test can read.
  { tags: ["bugbash", "5753", "mock-only"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    const composer = screen.getByRole("textbox", "Message");
    const search = screen.getByRole("textbox", "Search [provider:model-name]");
    const pickModel = async (from: string, model: string, label: string) => {
      await screen.getByRole("combobox").filter({ hasText: from }).tap();
      await search.fill(model);
      await browser.keyboard.press("Enter");
      await expect(search).toBeHidden();
      await expect(screen.getByRole("combobox").filter({ hasText: label })).toBeVisible();
    };
    try {
      // Haiku 4.5 has no fast mode on any route, so the toast must name the model, not the route.
      await pickModel("Opus 5.5", "anthropic:claude-haiku-4-5", "Haiku 4.5");
      await composer.tap();
      await browser.keyboard.press("Control+Shift+F");
      await expect(screen.getByText(/this model has no fast mode/)).toBeVisible();
    } finally {
      // Every repro in a run shares this workspace: put its model back, also after a failure.
      // The first switch can fail before it changes the model, so restore only when it did.
      const onOpus = await screen.getByRole("combobox").filter({ hasText: "Opus 5.5" }).isVisible();
      if (!onOpus) {
        await pickModel("Haiku 4.5", "anthropic:claude-opus-5-5", "Opus 5.5");
      }
    }
  }
);
