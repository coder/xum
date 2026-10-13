import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diffSeed, snapshotSeed, writeNeutralSeed } from "./neutralSeed";

const parents: string[] = [];
afterEach(() =>
  parents.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }))
);
function freshSeed() {
  parents.push(fs.mkdtempSync(path.join(os.tmpdir(), "neutral-seed-")));
  const out = path.join(parents[parents.length - 1], "seed");
  return { out, ...writeNeutralSeed(out) };
}

test("the seed generator imports only node: modules, so neither measured build can shape it", () => {
  const source = fs.readFileSync(path.join(import.meta.dir, "neutralSeed.ts"), "utf8");
  const specifiers = [...source.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)].map(
    (m) => m[1]
  );
  expect(specifiers.length).toBeGreaterThan(0);
  expect(specifiers.filter((s) => !s.startsWith("node:"))).toEqual([]);
});

test("the seed has the same bytes every time at the same path", () => {
  const seed = freshSeed();
  const before = snapshotSeed(seed.out);
  expect(before.has(path.join("root", "config.json"))).toBe(true);
  fs.rmSync(seed.out, { recursive: true });
  writeNeutralSeed(seed.out);
  expect(diffSeed(before, seed.out)).toEqual({ changed: [], missing: [], added: [], ok: true });
});

test("a rewritten or removed seed file fails the run, while new files are only listed", () => {
  const seed = freshSeed();
  const before = snapshotSeed(seed.out);
  fs.writeFileSync(path.join(seed.root, "server.lock"), "1234");
  fs.writeFileSync(path.join(seed.project, ".git", "index"), "rewritten by git status");
  expect(diffSeed(before, seed.out)).toMatchObject({
    ok: true,
    added: [path.join("root", "server.lock")],
  });
  const usage = path.join("root", "sessions", seed.workspaceId, "session-usage.json");
  fs.rmSync(path.join(seed.out, usage));
  expect(diffSeed(before, seed.out)).toMatchObject({ ok: false, changed: [], missing: [usage] });
  fs.writeFileSync(path.join(seed.out, usage), before.get(usage)!);
  // One changed byte in config.json, at the same length, must still fail: the check compares raw bytes.
  const config = path.join(seed.root, "config.json");
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace(/\n$/, " "));
  expect(diffSeed(before, seed.out)).toMatchObject({
    ok: false,
    changed: [path.join("root", "config.json")],
  });
});
