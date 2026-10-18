import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// Guards the root `playwright-core` devDependency pin (#6319). Bun 1.4.3 hoisted the
// playwright-core of @e2e-dev/web to the root, so package.json pins the root copy to the version
// that `playwright` uses. Nothing else ties the pin to `playwright`: a Playwright bump that leaves
// it behind makes @coder/pixel-storybook load a playwright-core whose Chromium CI does not install
// (CI installs browsers with `bun x playwright install`). This test reads the real bun.lock.
const lockText = fs.readFileSync(path.join(import.meta.dir, "../../../bun.lock"), "utf8");

/** Resolved versions of package `name` under the bun.lock `packages` key `key`. */
function lockVersions(name: string, key = name): string[] {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const pattern = new RegExp(`^    "${escape(key)}": \\["${escape(name)}@([^"]+)"`, "gm");
  return [...lockText.matchAll(pattern)].map((match) => match[1]);
}

test("the root playwright-core pin moves with playwright and @playwright/test", () => {
  const [playwright] = lockVersions("playwright");
  expect(playwright).toMatch(/^\d+\.\d+\.\d+$/);
  // Bump all three in package.json together: playwright, @playwright/test and playwright-core.
  expect({
    "@playwright/test": lockVersions("@playwright/test"),
    "playwright-core": lockVersions("playwright-core"),
  }).toEqual({ "@playwright/test": [playwright], "playwright-core": [playwright] });
});

test("@e2e-dev/web keeps its own playwright-core entry for the sandbox inputs key", () => {
  // tests/bugbash/sandbox/build.sh reads this entry for the sandbox inputs key. A root
  // playwright-core of the same version dedupes it away, and build.sh then refuses. Choose a
  // Playwright version other than the one @e2e-dev/web pins.
  const e2eWebEntries = lockVersions("playwright-core", "@e2e-dev/web/playwright-core");
  expect(e2eWebEntries).toHaveLength(1);
  const [e2eWeb] = e2eWebEntries;
  expect(e2eWeb).toMatch(/^\d+\.\d+\.\d+$/);
  expect(lockVersions("playwright-core")).not.toContain(e2eWeb);
});
