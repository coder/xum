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
    const mainRaw = (await fs.stat(path.join(dir, "main-AAAAAAAA.js"))).size;
    const sharedRaw = (await fs.stat(path.join(dir, "shared-BBBBBBBB.js"))).size;

    const { exitCode, stdout, stderr } = await runScript([dir, "--json"]);
    expect(exitCode, stderr).toBe(0);
    const report = JSON.parse(stdout) as { files: unknown[]; totals: unknown };
    // Sorted by raw size. The dynamic import and the __vite__mapDeps string keep the lazy chunk
    // off the first load; the stylesheet link is not JS.
    expect(report.files).toEqual([
      {
        file: "main-AAAAAAAA.js",
        rawBytes: mainRaw,
        brBytes: 7,
        gzipBytes: mainRaw,
        precompressed: { br: true, gzip: false },
      },
      {
        file: "shared-BBBBBBBB.js",
        rawBytes: sharedRaw,
        brBytes: sharedRaw,
        gzipBytes: sharedRaw,
        precompressed: { br: false, gzip: false },
      },
    ]);
    expect(report.totals).toEqual({
      files: 2,
      rawBytes: mainRaw + sharedRaw,
      brBytes: 7 + sharedRaw,
      gzipBytes: mainRaw + sharedRaw,
    });
  });

  test("forbidden sources fail only when a first-load chunk contains them", async () => {
    const lazyOnly = await runScript([dir, "--forbid", "node_modules/lazy-only/"]);
    expect(lazyOnly.exitCode, lazyOnly.stderr).toBe(0);

    const firstLoad = await runScript([dir, "--forbid", "node_modules/shared-dep/"]);
    expect(firstLoad.exitCode).toBe(1);
    expect(firstLoad.stderr).toContain(
      "shared-BBBBBBBB.js has ../node_modules/shared-dep/index.js"
    );
  });
});
