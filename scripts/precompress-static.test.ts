import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { brotliDecompressSync, gunzipSync } from "zlib";

const SCRIPT = path.join(import.meta.dir, "precompress-static.ts");

async function runScript(dir: string): Promise<void> {
  const proc = Bun.spawn([process.execPath, SCRIPT, dir], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  expect(exitCode, stderr).toBe(0);
}

describe("precompress-static", () => {
  let dir: string;

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("compresses only large hashed top-level assets and skips existing outputs", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "precompress-static-"));
    const large = "export const value = 'compressible';\n".repeat(100);
    const files: Record<string, string> = {
      "main-AbCd1234.js": large,
      "style-Ab_d-234.css": large,
      "tiny-AbCd1234.js": "export {};",
      "main-AbCd1234.js.map": large,
      "font-AbCd1234.woff2": large,
      "service-worker.js": large,
      "index.html": large,
      "cli/nested-AbCd1234.js": large,
    };
    for (const [name, contents] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await fs.writeFile(path.join(dir, name), contents);
    }

    await runScript(dir);

    const compressed = ["main-AbCd1234.js", "style-Ab_d-234.css"];
    const expectedTopLevel = [
      ...Object.keys(files).filter((name) => !name.includes("/")),
      "cli",
      ...compressed.flatMap((name) => [`${name}.br`, `${name}.gz`]),
    ].sort();
    // Also proves no temp files are left behind.
    expect((await fs.readdir(dir)).sort()).toEqual(expectedTopLevel);
    expect(await fs.readdir(path.join(dir, "cli"))).toEqual(["nested-AbCd1234.js"]);
    for (const name of compressed) {
      const br = await fs.readFile(path.join(dir, `${name}.br`));
      const gz = await fs.readFile(path.join(dir, `${name}.gz`));
      expect(brotliDecompressSync(br).toString()).toBe(large);
      expect(gunzipSync(gz).toString()).toBe(large);
    }

    // Content-hashed names never change content, so a rerun keeps existing outputs untouched.
    await fs.writeFile(path.join(dir, "main-AbCd1234.js.br"), "kept br");
    await fs.writeFile(path.join(dir, "main-AbCd1234.js.gz"), "kept gz");
    await runScript(dir);
    expect(await fs.readFile(path.join(dir, "main-AbCd1234.js.br"), "utf-8")).toBe("kept br");
    expect(await fs.readFile(path.join(dir, "main-AbCd1234.js.gz"), "utf-8")).toBe("kept gz");
  });
});
