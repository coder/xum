import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const SCRIPT = path.join(import.meta.dir, "firstLoadJs.ts");
const FIXTURE = path.join(import.meta.dir, "fixtures", "firstLoadJs");

async function runScript(
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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
    const size = async (name: string) => (await fs.stat(path.join(dir, name))).size;
    const mainRaw = await size("main-AAAAAAAA.js");
    const sharedRaw = await size("shared-BBBBBBBB.js");

    const { exitCode, stdout, stderr } = await runScript([dir, "--json"]);
    expect(exitCode, stderr).toBe(0);
    const report = JSON.parse(stdout) as {
      files: Array<{
        file: string;
        rawBytes: number;
        brBytes: number;
        gzipBytes: number;
        precompressed: { br: boolean; gzip: boolean };
      }>;
      totals: { files: number; rawBytes: number; brBytes: number; gzipBytes: number };
    };

    // The dynamic import and the __vite__mapDeps string keep the lazy chunk off the first load.
    expect(report.files.map((entry) => entry.file).sort()).toEqual([
      "main-AAAAAAAA.js",
      "shared-BBBBBBBB.js",
    ]);
    const byName = new Map(report.files.map((entry) => [entry.file, entry]));
    expect(byName.get("main-AAAAAAAA.js")).toEqual({
      file: "main-AAAAAAAA.js",
      rawBytes: mainRaw,
      brBytes: 7,
      gzipBytes: mainRaw,
      precompressed: { br: true, gzip: false },
    });
    expect(byName.get("shared-BBBBBBBB.js")).toEqual({
      file: "shared-BBBBBBBB.js",
      rawBytes: sharedRaw,
      brBytes: sharedRaw,
      gzipBytes: sharedRaw,
      precompressed: { br: false, gzip: false },
    });
    expect(report.totals).toEqual({
      files: 2,
      rawBytes: mainRaw + sharedRaw,
      brBytes: 7 + sharedRaw,
      gzipBytes: mainRaw + sharedRaw,
    });
  });

  test("a forbidden source that only a lazy chunk contains passes", async () => {
    const { exitCode, stderr } = await runScript([dir, "--forbid", "node_modules/lazy-only/"]);
    expect(exitCode, stderr).toBe(0);
  });

  test("a forbidden source in a first-load chunk fails and names the chunk and source", async () => {
    const { exitCode, stderr } = await runScript([dir, "--forbid", "node_modules/shared-dep/"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("shared-BBBBBBBB.js");
    expect(stderr).toContain("../node_modules/shared-dep/index.js");
  });
});
