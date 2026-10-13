/**
 * MCP Apps end to end: `make mcp-apps-e2e` (builds the app, runs e2e.mcpapps.config.ts).
 *
 * The agent does each flow from what the screen shows (agent.act); exact checks pin the
 * outcome right after it, so a passing act is cached and replays without model calls.
 * The seed (mcpapps/seed.ts) holds four demo-app calls: 4d6 (with its stored result),
 * 2d20 (stored result removed), a failed 50d6, and get_server_time (no view). Views open in
 * their own right-sidebar tabs ("Open in tab"); at phone width that tab shows in the full-screen
 * sidebar.
 */
import { describe, test } from "@e2e-dev/web";
import { expect, type Screen } from "e2e";
import { openPlayground } from "../repros/helpers";

/** The dice view of the one expanded card. Its frame title is "<tool> (<server>)". */
const DICE_FRAME = 'iframe[title="demo_app_show_dice_board (demo-app)"]';
/** The seeded 4d6 call (mcpapps/seed.ts). */
const DICE_4D6_CALL_ID = "call-dice-4d6";

describe("MCP Apps views", { tags: ["mcp-apps"] }, () => {
  test("an expanded app call shows its view; the toggle adds the raw JSON below it", async ({
    app,
    agent,
    screen,
    browser,
  }) => {
    await app.open();
    await agent.act(
      "open the 'Bug bash playground' workspace and expand the demo_app_show_dice_board tool card of the 4d6 roll"
    );
    const view = browser.frameLocator(DICE_FRAME);
    await expect(view.getByText("4d6 = 15")).toBeVisible({ timeout: 15_000 });
    await expect(screen.getByText("Arguments")).toBeHidden();

    await agent.act("show the input and output of that expanded tool card");
    await expect(screen.getByText("Arguments")).toBeVisible();
    // The view stayed loaded: it still shows the stored result.
    await expect(view.getByText("4d6 = 15")).toBeVisible();
  });

  test("the view re-rolls through its app-only tool without asking", async ({
    app,
    agent,
    screen,
    browser,
  }) => {
    await app.open();
    await agent.act(
      "open the 'Bug bash playground' workspace, expand the demo_app_show_dice_board tool card of the 4d6 roll, and press Re-roll in its dice view"
    );
    const view = browser.frameLocator(DICE_FRAME);
    // The agent may press Re-roll more than once; any roll counts.
    await expect(view.getByText(/roll_dice -> \d+/).first()).toBeVisible({ timeout: 15_000 });
    await expect(screen.getByRole("button", "Allow")).toBeHidden();
  });

  test("a model-visible tool asks first, on screen, and runs after Allow", async ({
    app,
    agent,
    browser,
  }) => {
    await app.open();
    await agent.act(
      "open the 'Bug bash playground' workspace, expand the demo_app_show_dice_board tool card of the 4d6 roll, scroll the chat until the dice view's buttons are at the top of the chat area, and press 'Server time (asks you)'"
    );
    await agent.assert(
      "a prompt asking whether to allow get_server_time from demo-app, with Allow and Deny buttons, is visible on screen",
      { vision: "only" }
    );
    await agent.act("allow the get_server_time call");
    await expect(browser.frameLocator(DICE_FRAME).getByText(/server time \d{4}-/)).toBeVisible({
      timeout: 15_000,
    });
  });

  test("a failed app call shows its error when expanded", async ({ app, agent, screen }) => {
    await app.open();
    await agent.act(
      "open the 'Bug bash playground' workspace and expand the demo_app_show_dice_board tool card marked failed"
    );
    await expect(screen.getByText(/count must be 1\.\.20/)).toBeVisible({ timeout: 15_000 });
  });

  // Exact steps, no agent (#6096): while focus is inside the cross-origin view, e2e's screen
  // tree marks no node focused, so an explorer read its own Tabs as doing nothing and stopped.
  test("the card buttons show keyboard focus", async ({ app, screen, browser }) => {
    await openPlayground(app, screen, browser);
    const card = browser.locator(`[data-tool-call-id="${DICE_4D6_CALL_ID}"]`);
    await card.getByText("demo_app_show_dice_board").tap();
    // The Tab count below needs the view's buttons in place.
    await expect(browser.frameLocator(DICE_FRAME).getByText("4d6 = 15")).toBeVisible({
      timeout: 15_000,
    });
    await card.getByRole("button", "Open in Artifacts").focus();
    // Measured at 1440x900 and 390x844: Tabs 1-4 cross the view's four buttons, Tab 5 leaves it.
    for (let tab = 0; tab < 5; tab++) await browser.keyboard.press("Tab");
    // Scoped to the 4d6 card: every tool card has its own "Show input/output" button.
    const toggle = card.getByRole("button", "Show input/output");
    await expect(toggle).toBeFocused();
    // globals.css removes the browser outline: the button must draw its own focus style.
    const focus = await browser.evaluate(() => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement)) throw new Error("nothing focused");
      const style = getComputedStyle(el);
      return {
        focusVisible: el.matches(":focus-visible"),
        boxShadow: style.boxShadow,
        outline: style.outlineStyle,
      };
    });
    expect(focus.focusVisible, JSON.stringify(focus)).toBe(true);
    expect(focus.boxShadow !== "none" || focus.outline !== "none", JSON.stringify(focus)).toBe(
      true
    );
  });
});

describe("App views in their own tabs", { tags: ["mcp-apps"] }, () => {
  /** App tabs: "<tool> <server>", then the call's detail while several calls share a name. */
  const appTabs = (screen: Screen) => screen.getByRole("tab", /demo_app_show_dice_board/);

  test("Open in tab moves the view to its tab; closing the tab brings it back", async ({
    app,
    agent,
    screen,
    browser,
  }) => {
    await app.open();
    await agent.act(
      "open the 'Bug bash playground' workspace, expand the demo_app_show_dice_board tool card of the 4d6 roll, and press that card's 'Open in tab' button"
    );
    const tab = appTabs(screen).filter({ hasText: "4d6 roll" });
    await expect(tab).toBeVisible({ timeout: 15_000 });
    const view = browser.frameLocator(DICE_FRAME);
    await expect(view.getByText("4d6 = 15")).toBeVisible({ timeout: 15_000 });
    // One live instance: the card shows a placeholder instead of a second frame.
    await expect(screen.getByRole("button", "Go to tab")).toBeVisible();
    expect(
      await browser.evaluate(
        (selector: string) => document.querySelectorAll(selector).length,
        DICE_FRAME
      )
    ).toBe(1);

    await agent.act("close the demo_app_show_dice_board tab in the right sidebar");
    await expect(appTabs(screen)).toHaveCount(0);
    await expect(screen.getByRole("button", "Go to tab")).toBeHidden();
    await expect(view.getByText("4d6 = 15")).toBeVisible({ timeout: 15_000 });
  });

  test("tabs of two calls of one tool have different names and survive a reload", async ({
    app,
    agent,
    screen,
    browser,
  }) => {
    await app.open();
    await agent.act(
      "open the 'Bug bash playground' workspace, then use 'Open in tab' on the demo_app_show_dice_board tool card of the 4d6 roll and on the one of the 2d20 roll"
    );
    await expect(appTabs(screen)).toHaveCount(2, { timeout: 15_000 });
    const names = await appTabs(screen).allTextContents();
    expect(new Set(names).size, `tab names: ${JSON.stringify(names)}`).toBe(2);

    await browser.reload();
    await expect(appTabs(screen)).toHaveCount(2, { timeout: 15_000 });
  });

  test("on a phone, Open in tab shows the view's tab in the full-screen sidebar", async ({
    app,
    agent,
    screen,
    browser,
  }) => {
    // Phone width on every target: the right sidebar is hidden there, so it opens full-screen.
    await browser.setViewport({ width: 390, height: 844 });
    await app.open();
    await agent.act(
      "open the 'Bug bash playground' workspace, expand the demo_app_show_dice_board tool card of the 4d6 roll, and press that card's 'Open in tab' button (an app window icon on narrow screens)"
    );
    await expect(screen.getByRole("button", "Close sidebar")).toBeVisible({ timeout: 15_000 });
    await expect(appTabs(screen)).toHaveCount(1);
    const view = browser.frameLocator(DICE_FRAME);
    await expect(view.getByText("4d6 = 15")).toBeVisible({ timeout: 15_000 });

    await screen.getByRole("button", "Close sidebar").tap();
    await expect(screen.getByRole("button", "Close sidebar")).toBeHidden();
    // The tab stays open in the hidden sidebar, so the card points to it instead of a second view.
    await expect(screen.getByRole("button", "Go to tab")).toBeVisible({ timeout: 15_000 });
  });
});
