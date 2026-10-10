import "../../../../tests/ui/dom";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { installDom } from "../../../../tests/ui/dom";

let cleanupDom: (() => void) | null = null;

beforeEach(() => {
  cleanupDom = installDom();
});

afterEach(() => {
  cleanupDom?.();
  cleanupDom = null;
});

// #6017: the static boot loader is what users (and screen readers) see before the bundle runs,
// so it needs the page's one main landmark too. Query by role so copy changes don't matter.
test("index.html's static boot loader sits in exactly one main landmark", async () => {
  const html = await readFile(path.join(process.cwd(), "index.html"), "utf8");
  const page = new window.DOMParser().parseFromString(html, "text/html");

  const mains = page.body.querySelectorAll("main");
  expect(mains.length).toBe(1);
  expect(mains[0].querySelector('[role="status"]')).not.toBeNull();
});
