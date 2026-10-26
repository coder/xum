// #7505: `waitFor(() => expect(query(...)).toBeNull())` is slow when it fails. Each failed check
// while the element is still present makes Bun format the happy-dom element into the error message
// (#7494: one failure took about 2.2 s of CPU and built a 200-million-character message), so a
// test that fails the check once or twice can reach its timeout on a loaded host. Poll a boolean
// instead: `waitFor(() => expect(query(...) === null).toBe(true))`, or wait on a positive signal
// (`findBy...`, `waitForElementToBeRemoved`) and then assert the absence once.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

// Files that keep the slow form for now, with the reason.
const ALLOWED = new Set([
  // #7563 (test-audit/p3-4-browser-dead-code) rewrites this file. Convert it there or after it lands.
  "src/browser/features/RightSidebar/ArtifactsTab/ArtifactInteractions.test.tsx",
]);

// `[^;]` spans line breaks, so the multi-line form `waitFor(() =>\n  expect(...).toBeNull()\n)` matches
// too. It cannot run past the end of the statement.
const SLOW_ABSENCE_POLL =
  /waitFor\(\s*\(\)\s*=>\s*expect\([^;]*?query[A-Za-z]*\([^;]*?\)\)\.(?:toBeNull|toBeFalsy)\(\)/g;

test("no waitFor polls an element query with toBeNull or toBeFalsy (#7505)", () => {
  const offenders: string[] = [];
  const glob = new Bun.Glob("{src,tests}/**/*.test.{ts,tsx}");
  for (const file of glob.scanSync({ cwd: repoRoot })) {
    const relative = file.split(path.sep).join("/");
    if (ALLOWED.has(relative)) {
      continue;
    }
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    for (const match of source.matchAll(SLOW_ABSENCE_POLL)) {
      const line = source.slice(0, match.index).split("\n").length;
      offenders.push(`${relative}:${line}`);
    }
  }
  expect(offenders).toEqual([]);
});
