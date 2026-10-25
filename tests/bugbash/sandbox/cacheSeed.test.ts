import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkSeed, MAX_SEED_BYTES, seedCacheDir } from "./cacheSeed";

let tmp = "";
let seed = "";
let dir = "";
const ENTRY = `${"a".repeat(64)}.json`;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-seed-"));
  seed = path.join(tmp, "seed");
  dir = path.join(tmp, "out/run/cache");
  fs.mkdirSync(seed);
  fs.writeFileSync(path.join(seed, ENTRY), "recorded");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("the main process seeds the cache once; a worker that loads later keeps what e2e wrote", () => {
  expect(seedCacheDir(seed, dir)).toBe(1);
  expect(fs.readFileSync(path.join(dir, ENTRY), "utf8")).toBe("recorded");
  // e2e replaces the entry during the run, then a worker loads the config again.
  fs.writeFileSync(path.join(dir, ENTRY), "recorded again");
  expect(seedCacheDir(seed, dir)).toBeNull();
  expect(fs.readFileSync(path.join(dir, ENTRY), "utf8")).toBe("recorded again");
  // No partial copy stays beside the cache: it would come back with the output.
  expect(fs.readdirSync(path.dirname(dir))).toEqual(["cache"]);
});

test("no seed folder gives an empty cache dir (a cold run)", () => {
  expect(seedCacheDir(path.join(tmp, "missing"), dir)).toBe(0);
  expect(fs.readdirSync(dir)).toEqual([]);
});

test("a seed with a file that is not an entry throws and leaves no cache dir", () => {
  fs.writeFileSync(path.join(seed, "notes.txt"), "x");
  expect(() => seedCacheDir(seed, dir)).toThrow("not an e2e cache entry");
  expect(fs.existsSync(dir)).toBe(false);
});

test("a seed over the total byte cap is refused, so the export keeps room for the run", () => {
  const entry = 1 << 20; // the largest entry e2e reads
  for (let i = 0; i * entry <= MAX_SEED_BYTES; i++)
    fs.writeFileSync(
      path.join(seed, `${i.toString(16).padStart(64, "0")}.json`),
      Buffer.alloc(entry)
    );
  expect(() => checkSeed(seed, (reason) => new Error(reason))).toThrow("bytes, more than");
});
