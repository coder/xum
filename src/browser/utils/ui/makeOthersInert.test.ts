import "../../../../tests/ui/dom";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { makeOthersInert } from "./makeOthersInert";

let cleanupDom: (() => void) | null = null;

beforeEach(() => {
  cleanupDom = installDom();
});

afterEach(() => {
  cleanupDom?.();
  cleanupDom = null;
});

// <body> > [left, shell > [chat, sidebar > [strip, panel]]]
function buildPage() {
  const left = document.createElement("div");
  const shell = document.createElement("div");
  const chat = document.createElement("div");
  const sidebar = document.createElement("div");
  const strip = document.createElement("div");
  const panel = document.createElement("div");
  sidebar.append(strip, panel);
  shell.append(chat, sidebar);
  document.body.append(left, shell);
  return { left, chat, sidebar, strip, panel };
}

// The full-screen sidebar (outer) can end first while Artifacts fullscreen (inner) stays open,
// or the other way round. Either way the page stays inert until the last view closes.
for (const firstToClose of ["outer", "inner"] as const) {
  test(`nested views: the page stays inert until both close (${firstToClose} closes first)`, () => {
    const page = buildPage();
    const restoreOuter = makeOthersInert(page.sidebar);
    const restoreInner = makeOthersInert(page.panel);
    expect([page.left.inert, page.chat.inert, page.strip.inert]).toEqual([true, true, true]);

    if (firstToClose === "outer") {
      restoreOuter();
      // Only the inner view is open: everything outside its panel is still inert.
      expect([page.left.inert, page.chat.inert, page.strip.inert]).toEqual([true, true, true]);
      restoreInner();
    } else {
      restoreInner();
      // Only the outer view is open: its own strip is interactive again, the page is not.
      expect([page.left.inert, page.chat.inert, page.strip.inert]).toEqual([true, true, false]);
      restoreOuter();
    }
    expect([page.left.inert, page.chat.inert, page.strip.inert]).toEqual([false, false, false]);
  });
}

test("leaves alone what someone else made inert, before or meanwhile", async () => {
  const page = buildPage();
  page.left.inert = true;
  const restore = makeOthersInert(page.sidebar);
  // Another component takes over the chat's inert state (ChatPane does under immersive review).
  page.chat.inert = false;
  page.chat.inert = true;
  await Promise.resolve();
  restore();
  expect(page.left.inert).toBe(true);
  expect(page.chat.inert).toBe(true);
});
