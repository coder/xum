/**
 * MCP Apps end to end: `make mcp-apps-e2e` (builds the app, runs e2e.mcpapps.config.ts).
 *
 * The agent does each flow from what the screen shows (agent.act); exact checks pin the
 * outcome right after it, so a passing act is cached and replays without model calls.
 * The seed (mcpapps/seed.ts) holds four demo-app calls: 4d6 (with its stored result),
 * 2d20 (stored result removed), a failed 50d6, and get_server_time (no view).
 */
import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

/** The dice view of the one expanded card. Its frame title is "<tool> (<server>)". */
const DICE_FRAME = 'iframe[title="demo_app_show_dice_board (demo-app)"]';

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

  test("the card buttons show keyboard focus", async ({ app, agent, screen, browser }) => {
    await app.open();
    await agent.act(
      "open the 'Bug bash playground' workspace and expand the demo_app_show_dice_board tool card of the 4d6 roll"
    );
    await agent.act("move keyboard focus to that card's 'Show input/output' button with Tab");
    const toggle = screen.getByRole("button", "Show input/output");
    await expect(toggle).toBeFocused();
    await expect(browser).toHaveClass(toggle, /focus-visible:ring/);
  });
});

describe("App views in the Artifacts picker", { tags: ["mcp-apps"] }, () => {
  test("every settled app call is listed, with labels that tell them apart", async ({
    app,
    agent,
    screen,
  }) => {
    await app.open();
    await agent.act(
      "open the 'Bug bash playground' workspace, open the Artifacts tab in the right sidebar without using any tool card button, and open the artifact picker"
    );
    const options = screen.getByRole("option").filter({ hasText: "demo_app_show_dice_board" });
    await expect(options).toHaveCount(3);
    const labels = await options.allTextContents();
    expect(new Set(labels).size, `labels: ${JSON.stringify(labels)}`).toBe(3);
    expect(
      labels.some((label) => label.includes("failed")),
      "one entry says failed"
    ).toBe(true);
  });

  test("Close returns to the files and keeps the view in the picker, across a reload", async ({
    app,
    agent,
    screen,
    browser,
  }) => {
    await app.open();
    await agent.act(
      "open the 'Bug bash playground' workspace, open the Artifacts tab, and pick the app view of the 4d6 roll in the artifact picker"
    );
    const view = browser.frameLocator(DICE_FRAME);
    await expect(view.getByText("4d6 = 15")).toBeVisible({ timeout: 15_000 });

    await agent.act("close the app view in the Artifacts tab");
    await expect(screen.getByRole("button", "Close view")).toBeHidden();

    await browser.reload();
    await agent.act("open the artifact picker in the Artifacts tab");
    await expect(
      screen.getByRole("option").filter({ hasText: "demo_app_show_dice_board" })
    ).toHaveCount(3);
  });
});
