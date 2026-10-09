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
    const [main, shared, deep] = await Promise.all(
      ["main-AAAAAAAA.js", "shared-BBBBBBBB.js", "deep-EEEEEEEE.js"].map(size)
    );
    const { exitCode, stdout, stderr } = await runScript([dir, "--json"]);
    expect(exitCode, stderr).toBe(0);
    const report = JSON.parse(stdout) as { files: unknown[]; totals: unknown };
    // Sorted by raw size. Only shared's `export * from` reaches the unpreloaded deep chunk. The
    // `import()` and __vite__mapDeps string keep the lazy chunk out; the stylesheet is not JS.
    const raw = (file: string, bytes: number) => ({
      file,
      rawBytes: bytes,
      brBytes: bytes,
      gzipBytes: bytes,
      precompressed: { br: false, gzip: false },
    });
    expect(report.files).toEqual([
      { ...raw("main-AAAAAAAA.js", main), brBytes: 7, precompressed: { br: true, gzip: false } },
      raw("shared-BBBBBBBB.js", shared),
      raw("deep-EEEEEEEE.js", deep),
    ]);
    expect(report.totals).toEqual({
      files: 3,
      rawBytes: main + shared + deep,
      brBytes: 7 + shared + deep,
      gzipBytes: main + shared + deep,
    });
  });

  test("forbidden sources fail when a first-load chunk has them or has no source map", async () => {
    const lazyOnly = await runScript([dir, "--forbid", "node_modules/lazy-only/"]);
    expect(lazyOnly.exitCode, lazyOnly.stderr).toBe(0);
    const firstLoad = await runScript([dir, "--forbid", "node_modules/shared-dep/"]);
    expect(firstLoad.exitCode).toBe(1);
    expect(firstLoad.stderr).toContain(
      "shared-BBBBBBBB.js has ../node_modules/shared-dep/index.js"
    );
    // Skipping a chunk without a map would let a forbidden module back on unnoticed.
    await fs.rm(path.join(dir, "deep-EEEEEEEE.js.map"));
    const noMap = await runScript([dir, "--forbid", "node_modules/lazy-only/"]);
    expect(noMap.exitCode).toBe(2);
    expect(noMap.stderr).toContain("deep-EEEEEEEE.js has no source map");
  });
});
