import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

// patches/ai-tokenizer@<version>.patch replaces ai-tokenizer's FIFO merge-cache eviction, which
// cost ~50 us per insert once the cache was full and dominated token stats on huge chats
// (#4653). bun 1.3.5 silently skips a patchedDependencies entry whose version no longer matches
// the installed package (no warning, exit 0), so an ai-tokenizer bump would drop the patch
// unnoticed. This guards that the installed dist still carries it; remove it once upstream fixes
// the eviction and the patch is gone.
describe("ai-tokenizer merge-cache patch", () => {
  const distDir = path.dirname(createRequire(import.meta.url).resolve("ai-tokenizer"));

  for (const file of ["index.cjs", "index.js"]) {
    test(`${file} does not evict the first merge-cache key`, () => {
      const source = readFileSync(path.join(distDir, file), "utf8");
      const method = /addToMergeCache\(key, value\) \{[\s\S]*?\n\t\}/.exec(source)?.[0];
      expect(method).toBeDefined();
      expect(method).not.toContain("keys().next()");
    });
  }
});
