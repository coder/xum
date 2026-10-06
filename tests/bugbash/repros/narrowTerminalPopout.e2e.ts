// B2 (#5670): at phone width with a mouse, the header "New terminal" button added a tab to the
// hidden right sidebar. Proves the button opens the terminal popup window instead.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground } from "./helpers";

// The browser fixture does not follow new tabs, so a spy records every window.open URL and
// opens nothing. Run with `--target phone`: at 1440px the terminal opens in the sidebar.
const OPENED_URLS_KEY = "__bugbashOpenedUrls";

test(
  "New terminal at phone width opens the terminal popup",
  { tags: ["bugbash", "B2"] },
  async ({ app, screen, browser }) => {
    await browser.addInitScript((key: string) => {
      const opened: string[] = [];
      Reflect.set(window, key, opened);
      window.open = (url?: string | URL) => {
        opened.push(String(url ?? ""));
        return null;
      };
    }, OPENED_URLS_KEY);
    await openPlayground(app, screen, browser);

    await screen.getByRole("button", "New terminal").tap();
    await expect
      .poll(() =>
        browser.evaluate(
          (key: string) => (Reflect.get(window, key) as string[]).join("\n"),
          OPENED_URLS_KEY
        )
      )
      .toMatch(/terminal\.html\?/);
  }
);
