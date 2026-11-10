import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// #7146: the Docker server bundle is one minified file with no source map (Makefile
// ESBUILD_SERVER_FLAGS), so the logger cannot find its own frames by path or function name.
// Node runs that bundle, so the check runs in a node child process, not under bun.
describe("log caller location in a minified bundle", () => {
  let tempDir: string;
  let bundlePath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mux-log-bundle-"));
    bundlePath = join(tempDir, "log.bundle.js");
    const bundleResult = spawnSync(
      "bun",
      [
        "x",
        "esbuild",
        resolve("src/node/services/log.ts"),
        "--bundle",
        "--platform=node",
        "--target=node22",
        "--format=cjs",
        "--minify",
        `--outfile=${bundlePath}`,
      ],
      { encoding: "utf8" }
    );
    expect(bundleResult.status, bundleResult.stderr).toBe(0);
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("names the caller's line, not a logger line", () => {
    const callerPath = join(tempDir, "caller.cjs");
    writeFileSync(
      callerPath,
      [
        `const { log } = require(${JSON.stringify(bundlePath)});`,
        "// The call below is on line 3.",
        'log.error("caller location probe");',
        "",
      ].join("\n")
    );
    const result = spawnSync("node", [callerPath], {
      cwd: tempDir,
      encoding: "utf8",
      env: { ...process.env, XUM_ROOT: tempDir, MUX_ROOT: tempDir, NO_COLOR: "1" },
    });
    expect(result.status, result.stderr).toBe(0);
    const line = `${result.stdout}${result.stderr}`
      .split("\n")
      .find((text) => text.includes("caller location probe"));
    expect(line?.split(" ")[1]).toBe("caller.cjs:3");
  }, 30_000);
});
