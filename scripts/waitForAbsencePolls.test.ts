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

// Matches one absence check. `[^;]` spans line breaks but cannot run past the end of a statement.
const SLOW_ABSENCE_CHECK =
  /expect\([^;]*?query[A-Za-z]*\([^;]*?\)\s*\)\s*\.(?:toBeNull|toBeFalsy)\(\)/g;

// Returns each `waitFor(...)` call: the callback in any form (expression body, block body, async)
// plus its options. Counts parentheses only, so an unbalanced parenthesis inside a string or regex
// literal can cut a call short. No test source has one today.
function waitForCalls(source: string): Array<{ start: number; text: string }> {
  const calls: Array<{ start: number; text: string }> = [];
  for (const match of source.matchAll(/\bwaitFor\(/g)) {
    let depth = 0;
    for (let i = match.index + "waitFor".length; i < source.length; i++) {
      if (source[i] === "(") {
        depth++;
      } else if (source[i] === ")" && --depth === 0) {
        calls.push({ start: match.index, text: source.slice(match.index, i + 1) });
        break;
      }
    }
  }
  return calls;
}

test("no waitFor polls an element query with toBeNull or toBeFalsy (#7505)", () => {
  const offenders: string[] = [];
  const glob = new Bun.Glob("{src,tests}/**/*.test.{ts,tsx}");
  for (const file of glob.scanSync({ cwd: repoRoot })) {
    const relative = file.split(path.sep).join("/");
    if (ALLOWED.has(relative)) {
      continue;
    }
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    for (const call of waitForCalls(source)) {
      for (const match of call.text.matchAll(SLOW_ABSENCE_CHECK)) {
        const line = source.slice(0, call.start + match.index).split("\n").length;
        offenders.push(`${relative}:${line}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
