import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { openPlayground } from "./helpers";

test("scratch focus trace", { tags: ["bugbash", "scratch"] }, async ({ app, screen, browser }) => {
  await browser.setViewport({ width: 1440, height: 900 });
  await openPlayground(app, screen, browser);
  const input = screen.getByRole("textbox", "Message");
  const panel = screen.getByTestId("artifacts-panel");
  await input.tap();
  await browser.keyboard.press("Control+Shift+K");
  await expect(panel).toBeFocused();
  await input.tap();
  await browser.keyboard.press("Control+Shift+K");
  await expect(panel).toBeFocused();
  await expect(screen.getByRole("button", "Collapse right sidebar")).toBeVisible();
  await browser.evaluate(() => {
    const w = window as unknown as { __log: string[] };
    w.__log = [];
    const d = (el: Element | null) =>
      el
        ? `${el.tagName}#${el.id}[${el.getAttribute("data-testid")}][${el.getAttribute("aria-label")}]`
        : "null";
    document.addEventListener(
      "focusin",
      (e) => w.__log.push(`${performance.now().toFixed(0)} focusin ${d(e.target as Element)}`),
      true
    );
    document.addEventListener(
      "focusout",
      (e) =>
        w.__log.push(
          `${performance.now().toFixed(0)} focusout ${d(e.target as Element)} -> ${d(e.relatedTarget as Element)}`
        ),
      true
    );
    const orig = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (this: HTMLElement, ...args: [FocusOptions?]) {
      w.__log.push(
        `${performance.now().toFixed(0)} .focus() on ${d(this)} stack=${(new Error().stack ?? "")
          .split("\n")
          .slice(2, 7)
          .map((l) => l.trim())
          .join(" | ")}`
      );
      return orig.apply(this, args);
    };
    window.addEventListener(
      "keydown",
      (e) =>
        w.__log.push(
          `${performance.now().toFixed(0)} keydown ${e.key} target=${d(e.target as Element)} active=${d(document.activeElement)}`
        ),
      true
    );
  });
  await browser.keyboard.press("Control+Shift+K");
  const snap: string[] = [];
  for (const ms of [0, 50, 200, 1000, 3000]) {
    await new Promise((r) => setTimeout(r, ms));
    snap.push(
      `${ms}: ${await browser.evaluate(() => `${document.activeElement?.tagName}[${document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.getAttribute("data-testid")}]`)}`
    );
  }
  console.log("FOCUSSNAP " + snap.join(" ; "));
  const log = await browser.evaluate(
    () =>
      (window as unknown as { __log: string[] }).__log.join("\n") +
      `\nFINAL active=${document.activeElement?.tagName}[${document.activeElement?.getAttribute("aria-label")}]`
  );
  console.log("FOCUSLOG\n" + log);
});
