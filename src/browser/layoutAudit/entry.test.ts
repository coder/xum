import { describe, expect, test } from "bun:test";
import { auditWindow } from "./entry";
import { createFakeBrowserWindow } from "./fakeLayoutPage.testHarness";

describe("auditWindow", () => {
  test("a page with nothing wrong audits complete and clean", async () => {
    using fake = createFakeBrowserWindow({ width: 390, bodyHtml: "<p>hello world</p>" });
    expect(await auditWindow(fake.win)).toEqual({
      complete: true,
      viewportWidth: 390,
      href: "about:blank",
      findings: [],
    });
  });

  test("says which page it measured, a finished pass and a crashed one alike", async () => {
    const url = "file:///tmp/artifacts/page.html#top";
    using fake = createFakeBrowserWindow({ width: 390, bodyHtml: "<p>hello world</p>", url });
    expect((await auditWindow(fake.win)).href).toBe(url);
    fake.win.getComputedStyle = () => {
      throw new Error("style broke");
    };
    expect((await auditWindow(fake.win)).href).toBe(url);
  });

  test("a crash while waiting gives an incomplete pass with no findings, never a rejection", async () => {
    using fake = createFakeBrowserWindow({ width: 390, bodyHtml: "<p>hello world</p>" });
    Object.defineProperty(fake.win.document, "fonts", {
      get() {
        throw new Error("fonts broke");
      },
      configurable: true,
    });
    expect(await auditWindow(fake.win)).toEqual({
      complete: false,
      viewportWidth: 390,
      href: "about:blank",
      findings: [],
    });
  });

  test("a crash while measuring does too, and an unreadable width reads as 0", async () => {
    using fake = createFakeBrowserWindow({ width: 390, bodyHtml: "<p>hello world</p>" });
    fake.win.getComputedStyle = () => {
      throw new Error("style broke");
    };
    Object.defineProperty(fake.win, "innerWidth", { value: 0, configurable: true });
    expect(await auditWindow(fake.win)).toEqual({
      complete: false,
      viewportWidth: 0,
      href: "about:blank",
      findings: [],
    });
  });
});
