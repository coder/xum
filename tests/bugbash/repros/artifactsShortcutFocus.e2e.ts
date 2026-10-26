// B3 (#5670): Ctrl+Shift+K opened the Artifacts tab but left focus in the chat, with no focus ring.
// Proves the shortcut moves focus to the panel and the panel marks its ring (data-shortcut-focus).
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground } from "./helpers";

test(
  "Ctrl+Shift+K focuses the Artifacts panel and shows its focus ring",
  { tags: ["bugbash", "B3"] },
  async ({ app, screen, browser }) => {
    // The web target's size, set here so the repro runs the same on every target: the narrow
    // layout hides the right sidebar.
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    // The bug showed when the shortcut came from the chat input.
    await screen.getByRole("textbox", "Message").tap();
    await browser.keyboard.press("Control+Shift+K");

    const panel = screen.getByTestId("artifacts-panel");
    await expect(panel).toBeFocused();
    await expect(panel).toHaveAttribute("data-shortcut-focus", "true");
  }
);

// User request (2026-10-26): while the Artifacts tab shows and focus is elsewhere, Ctrl+Shift+K
// moves focus into the tab instead of hiding the sidebar. Only a press from inside the tab hides it.
test(
  "Ctrl+Shift+K focuses the showing Artifacts tab first, and hides the sidebar from inside it",
  { tags: ["bugbash", "artifacts-key-focus-first"] },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    await openPlayground(app, screen, browser);
    const input = screen.getByRole("textbox", "Message");
    const panel = screen.getByTestId("artifacts-panel");
    // TEMP diagnostics (remove before merge).
    await browser.evaluate(() => {
      const w = window as unknown as { __log: string[] };
      w.__log = [];
      const d = (el: Element | null) =>
        el
          ? `${el.tagName}[${el.getAttribute("data-testid") ?? el.getAttribute("aria-label") ?? el.getAttribute("role")}]`
          : "null";
      const t0 = performance.now();
      const ts = () => (performance.now() - t0).toFixed(0);
      document.addEventListener(
        "focusin",
        (e) => w.__log.push(`${ts()} focusin ${d(e.target as Element)}`),
        true
      );
      window.addEventListener(
        "keydown",
        (e) => {
          if (e.key === "K")
            w.__log.push(
              `${ts()} keydown K target=${d(e.target as Element)} trusted=${e.isTrusted}`
            );
        },
        true
      );
      const orig = HTMLElement.prototype.focus;
      HTMLElement.prototype.focus = function (this: HTMLElement, ...args: [FocusOptions?]) {
        w.__log.push(
          `${ts()} .focus() ${d(this)} ${(new Error().stack ?? "")
            .split("\n")
            .slice(2, 7)
            .map((l) => l.trim().replace(/https?:\/\/[^/]+\//, ""))
            .join(" | ")}`
        );
        return orig.apply(this, args);
      };
    });
    await input.tap();
    await browser.keyboard.press("Control+Shift+K");
    await expect(panel).toBeFocused();

    // The tab shows, focus is back in the chat: the key only moves focus.
    await input.tap();
    await browser.keyboard.press("Control+Shift+K");
    await expect(panel).toBeFocused();
    await expect(screen.getByRole("button", "Collapse right sidebar")).toBeVisible();

    // Focus is in the tab: the key hides the sidebar, and focus moves to the header toggle.
    await browser.keyboard.press("Control+Shift+K");
    try {
      await expect
        .poll(() =>
          browser.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null)
        )
        .toBe("Expand right sidebar");
    } finally {
      const log = await browser.evaluate(() => {
        const a = document.activeElement;
        const toggle = document.querySelector('[data-testid="right-sidebar-toggle-bar"] button');
        return `${(window as unknown as { __log: string[] }).__log.join("\n")}\nFINAL active=${a?.tagName}[${a?.getAttribute("data-testid") ?? a?.getAttribute("aria-label")}] toggle=${toggle?.getAttribute("aria-label")} hasFocus=${document.hasFocus()}`;
      });
      console.log(`DIAGLOG\n${log}\nENDDIAG`);
    }
  }
);
