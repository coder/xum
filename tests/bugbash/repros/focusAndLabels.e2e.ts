// #5681, #5687, #5688, #5693: keyboard focus, labels and shortcut feedback. Each test fails on
// the old code.
import type { Browser } from "@e2e-dev/web";
import { test } from "@e2e-dev/web";
import type { Screen } from "e2e";
import { expect } from "e2e";
import { KNOWN_MODELS } from "../../../src/common/constants/knownModels";
import { formatModelDisplayName } from "../../../src/common/utils/ai/modelDisplay";
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
  "The right sidebar's toggle shows a focus ring",
  { tags: ["bugbash", "5688"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    // This test exercises the expanded sidebar; fresh profiles start collapsed.
    await screen.getByRole("button", "Expand right sidebar").tap();
    const collapse = screen.getByRole("button", "Collapse right sidebar");
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

/** What has keyboard focus: "terminal", or the focused control's label or tag. */
function focusOwner(browser: Browser) {
  return browser.evaluate(() => {
    const el = document.activeElement;
    if (el?.closest(".terminal-view")) return "terminal";
    return el?.getAttribute("aria-label") ?? el?.tagName ?? "none";
  });
}

/**
 * Runs `body`, then closes the terminal session it opened, also after a failure. Every repro in a
 * run shares one backend: a later repro whose sidebar opens onto a leftover terminal can lose its
 * menu, since the terminal takes focus after it mounts and the focus move closes the menu (#7099).
 */
async function closingTheTerminal(screen: Screen, body: () => Promise<void>) {
  const closeTerminal = async () => {
    const expand = screen.getByRole("button", "Expand right sidebar");
    if (await expand.isVisible()) await expand.tap();
    const close = screen.getByRole("button", "Close terminal");
    await close.tap();
    await expect(close).toBeHidden();
  };
  try {
    await body();
  } catch (error) {
    // Report the test's own error, not a cleanup error it caused.
    await closeTerminal().catch((cleanupError: unknown) => {
      console.error("Could not close the terminal after the test failed:", cleanupError);
    });
    throw error;
  }
  await closeTerminal();
}

// A command typed right after the toggle expands the sidebar onto a terminal runs in the
// terminal. Left on the toggle, its `a` hit the chat's plain-key focus shortcut and the rest of
// the line was sent as a chat message.
// mock-only: real AI mode turns terminals off (XUM_DISABLE_TERMINALS, startApp.ts).
test(
  "Expanding the right sidebar onto a terminal hands it the keyboard",
  { tags: ["bugbash", "right-sidebar-toggle", "mock-only"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1600, height: 900 });
    await openPlayground(app, screen, browser);
    const expand = screen.getByRole("button", "Expand right sidebar");
    await expand.tap();
    await screen.getByRole("button", "New terminal").tap();
    await closingTheTerminal(screen, async () => {
      await expect.poll(() => focusOwner(browser), { timeout: 15_000 }).toBe("terminal");

      await screen.getByRole("button", "Collapse right sidebar").tap();
      // Closed: the slide is over and the terminal unmounted with the panel.
      await expect
        .poll(() => browser.evaluate(() => document.querySelector(".terminal-view") === null))
        .toBe(true);
      await expand.tap();
      await expect.poll(() => focusOwner(browser), { timeout: 15_000 }).toBe("terminal");
      await browser.keyboard.type("cat README.md");

      expect(await focusOwner(browser)).toBe("terminal");
    });
  }
);

// The toggle sits outside the lazy-loaded sidebar, so it can expand the sidebar while the
// sidebar's code still loads. The sidebar then mounted expanded, saw no expand, and left the
// keyboard on the toggle.
// mock-only: real AI mode turns terminals off (XUM_DISABLE_TERMINALS, startApp.ts).
test(
  "Expanding the right sidebar while its code loads still hands a terminal the keyboard",
  { tags: ["bugbash", "right-sidebar-toggle", "mock-only"] },
  async ({ app, screen, browser }) => {
    // A service worker fetches the sidebar's code itself, past the route that holds it below.
    await browser.addInitScript(() => Reflect.deleteProperty(Navigator.prototype, "serviceWorker"));
    await browser.setViewport({ width: 1600, height: 900 });
    await openPlayground(app, screen, browser);
    const expand = screen.getByRole("button", "Expand right sidebar");
    await expand.tap();
    await screen.getByRole("button", "New terminal").tap();
    await closingTheTerminal(screen, async () => {
      await expect.poll(() => focusOwner(browser), { timeout: 15_000 }).toBe("terminal");
      await screen.getByRole("button", "Collapse right sidebar").tap();
      await expect(expand).toBeVisible();
      let held = false;
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      await browser.route(/\/RightSidebar-[\w-]+\.js$/, async (route) => {
        held = true;
        await released;
        await route.continue();
      });
      try {
        // Not `load`: the held code may delay it.
        await browser.goto(await browser.url(), { waitUntil: "domcontentloaded" });
        await expect.poll(() => held, { timeout: 15_000 }).toBe(true);

        await expand.tap();
      } finally {
        // Also after a failure: closing the terminal needs the sidebar.
        release();
      }

      await expect.poll(() => focusOwner(browser), { timeout: 15_000 }).toBe("terminal");
    });
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
    // Haiku has no fast mode on any route, so the toast must name the model, not the route. Use
    // the curated `haiku` model: the picker only offers listed models, so a retired Haiku id
    // stops matching once the alias moves.
    const haiku = KNOWN_MODELS.HAIKU;
    const haikuLabel = formatModelDisplayName(haiku.providerModelId);
    try {
      await pickModel("Opus 5.5", haiku.id, haikuLabel);
      await composer.tap();
      await browser.keyboard.press("Control+Shift+F");
      await expect(screen.getByText(/this model has no fast mode/)).toBeVisible();
    } finally {
      // Every repro in a run shares this workspace: put its model back, also after a failure.
      // The first switch can fail before it changes the model, so restore only when it did.
      const onOpus = await screen.getByRole("combobox").filter({ hasText: "Opus 5.5" }).isVisible();
      if (!onOpus) {
        await pickModel(haikuLabel, "anthropic:claude-opus-5-5", "Opus 5.5");
      }
    }
  }
);
