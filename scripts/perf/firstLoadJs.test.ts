import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const SCRIPT = path.join(import.meta.dir, "firstLoadJs.ts");
const FIXTURE = path.join(import.meta.dir, "fixtures", "firstLoadJs");

async function runScript(args: string[]) {
  const proc = Bun.spawn([process.execPath, SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("firstLoadJs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "first-load-js-"));
    await fs.cp(FIXTURE, dir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("counts only statically reachable chunks, with served sizes from precompressed siblings", async () => {
    // The script only stats sibling sizes, so the content need not be valid brotli.
    await fs.writeFile(path.join(dir, "main-AAAAAAAA.js.br"), "x".repeat(7));
    const size = async (file: string) => (await fs.stat(path.join(dir, file))).size;
    const [main, shared, deep, html] = await Promise.all(
      ["main-AAAAAAAA.js", "shared-BBBBBBBB.js", "deep-EEEEEEEE.js", "index.html"].map(size)
    );
    const { exitCode, stdout, stderr } = await runScript([dir, "--json"]);
    expect(exitCode, stderr).toBe(0);
    const report = JSON.parse(stdout) as { files: unknown[]; totals: unknown };
    // Sorted by raw size; index.html itself counts. Only shared's `export * from` reaches the unpreloaded deep chunk. The
    // `import()` and __vite__mapDeps string keep the lazy chunk out; the stylesheet is not JS.
    const raw = (file: string, bytes: number) => ({
      file,
      rawBytes: bytes,
      brBytes: bytes,
      gzipBytes: bytes,
      precompressed: { br: false, gzip: false },
    });
    expect(report.files).toEqual(
      [
        { ...raw("main-AAAAAAAA.js", main), brBytes: 7, precompressed: { br: true, gzip: false } },
        raw("shared-BBBBBBBB.js", shared),
        raw("deep-EEEEEEEE.js", deep),
        raw("index.html", html),
      ].sort((a, b) => b.rawBytes - a.rawBytes || a.file.localeCompare(b.file))
    );
    expect(report.totals).toEqual({
      files: 4,
      rawBytes: main + shared + deep + html,
      brBytes: 7 + shared + deep + html,
      gzipBytes: main + shared + deep + html,
    });
  });

  test("forbidden sources fail when a first-load chunk has them or has no source map", async () => {
    const lazyOnly = await runScript([dir, "--forbid", "node_modules/lazy-only/"]);
    expect(lazyOnly.exitCode, lazyOnly.stderr).toBe(0);
    const firstLoad = await runScript([dir, "--forbid", "node_modules/shared-dep/"]);
    expect(firstLoad.exitCode).toBe(1);
    expect(firstLoad.stderr).toContain("shared-BBBBBBBB.js has ../node_modules/shared-dep/");
    // A flag is never a pattern, so `--json` cannot be swallowed silently.
    expect((await runScript([dir, "--forbid", "--json"])).exitCode).toBe(2);
    // Skipping a chunk without a map would let a forbidden module back on unnoticed.
    await fs.rm(path.join(dir, "deep-EEEEEEEE.js.map"));
    const noMap = await runScript([dir, "--forbid", "node_modules/lazy-only/"]);
    expect(noMap.exitCode).toBe(2);
    expect(noMap.stderr).toContain("deep-EEEEEEEE.js has no source map");
  });

  test("a classic external script exits 2, because the graph does not measure it", async () => {
    const html = path.join(dir, "index.html");
    await fs.writeFile(path.join(dir, "classic.js"), "window.__classic = true;");
    const original = await fs.readFile(html, "utf-8");
    const classicTag = '<script src="./classic.js"></script>';
    await fs.writeFile(html, original.replace("</head>", `${classicTag}</head>`));
    const classic = await runScript([dir]);
    expect(classic.exitCode).toBe(2);
    expect(classic.stderr).toContain("./classic.js");
    await fs.writeFile(html, original);
  });

  describe("--budget", () => {
    const BUDGET_FILE = path.join(import.meta.dir, "firstLoadBudget.json");

    async function totals() {
      const { exitCode, stdout, stderr } = await runScript([dir, "--json"]);
      expect(exitCode, stderr).toBe(0);
      return (JSON.parse(stdout) as { totals: { rawBytes: number; brBytes: number } }).totals;
    }

    async function writeBudget(budget: unknown) {
      const file = path.join(dir, "budget.json");
      await fs.writeFile(file, typeof budget === "string" ? budget : JSON.stringify(budget));
      return file;
    }

    test("passes at or under the recorded values and fails on brotli growth over 2%", async () => {
      const { rawBytes, brBytes } = await totals();
      const exact = await runScript([dir, "--budget", await writeBudget({ rawBytes, brBytes })]);
      expect(exact.exitCode, exact.stderr).toBe(0);
      // A smaller first load never fails, so shrinking needs no budget update.
      const shrunk = { rawBytes: rawBytes * 2, brBytes: brBytes * 2 };
      expect((await runScript([dir, "--budget", await writeBudget(shrunk)])).exitCode).toBe(0);
      // The committed budget file must stay valid; this fixture is far under it.
      const committed = await runScript([dir, "--budget", BUDGET_FILE]);
      expect(committed.exitCode, committed.stderr).toBe(0);

      const budgetFile = await writeBudget({ rawBytes, brBytes: Math.floor(brBytes / 1.03) });
      const grown = await runScript([dir, "--budget", budgetFile]);
      expect(grown.exitCode).toBe(1);
      expect(grown.stderr).toContain(budgetFile);
      // The message names the new value, the budget key and the budget file.
      expect(grown.stderr).toContain(String(brBytes));
      expect(grown.stderr).toContain("brBytes");
      expect(grown.stderr).not.toContain("rawBytes");
    });

    test("fails when raw grows more than 100 KiB, even with brotli unchanged", async () => {
      // main has a .br sibling, so padding it grows raw bytes only.
      await fs.writeFile(path.join(dir, "main-AAAAAAAA.js.br"), "x".repeat(7));
      const before = await totals();
      const padded = 100 * 1024 + 1;
      await fs.appendFile(path.join(dir, "main-AAAAAAAA.js"), `\n/*${"x".repeat(padded - 5)}*/`);
      const after = await totals();
      expect(after.rawBytes - before.rawBytes).toBe(padded);

      const recorded = { rawBytes: before.rawBytes, brBytes: after.brBytes };
      const grown = await runScript([dir, "--budget", await writeBudget(recorded)]);
      expect(grown.exitCode).toBe(1);
      expect(grown.stderr).toContain(String(after.rawBytes));
      expect(grown.stderr).toContain("rawBytes");
      expect(grown.stderr).not.toContain("brBytes");
      // Exactly 100 KiB of growth is still within budget.
      const edge = { rawBytes: after.rawBytes - 100 * 1024, brBytes: after.brBytes };
      expect((await runScript([dir, "--budget", await writeBudget(edge)])).exitCode).toBe(0);
    });

    test("fails when the inline boot script in index.html grows more than 100 KiB", async () => {
      // index.html counts as one entry, so inline JS (and other markup) growth is measured.
      const recorded = await totals();
      const html = path.join(dir, "index.html");
      const grownScript = `window.__boot = "${"x".repeat(101 * 1024)}";`;
      await fs.writeFile(
        html,
        (await fs.readFile(html, "utf-8")).replace("window.__boot = true;", grownScript)
      );
      const grown = await runScript([dir, "--budget", await writeBudget(recorded)]);
      expect(grown.exitCode).toBe(1);
      expect(grown.stderr).toContain("rawBytes");
    });

    test("a forbidden module fails even when the bytes are under budget", async () => {
      const budgetFile = await writeBudget(await totals());
      const result = await runScript([
        dir,
        "--budget",
        budgetFile,
        "--forbid",
        "node_modules/shared-dep/",
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("forbidden on first load");
    });

    test("an unusable budget file exits 2", async () => {
      const { rawBytes, brBytes } = await totals();
      for (const budget of [
        "{ not json",
        "null",
        { rawBytes },
        { rawBytes, brBytes: -1 },
        { rawBytes: "1000", brBytes },
        { rawBytes: 1.5, brBytes },
      ]) {
        const result = await runScript([dir, "--budget", await writeBudget(budget)]);
        expect(result.exitCode, JSON.stringify(budget)).toBe(2);
      }
      expect((await runScript([dir, "--budget", path.join(dir, "missing.json")])).exitCode).toBe(2);
      expect((await runScript([dir, "--budget"])).exitCode).toBe(2);
    });
  });
});
