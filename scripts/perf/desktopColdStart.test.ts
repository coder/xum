import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

// The runner runs under Node (see its header), so these tests spawn it the way the workflow does.
const SCRIPT = path.join(import.meta.dir, "desktopColdStart.ts");

function node(args: string[]) {
  return spawnSync("node", ["--import", "tsx", ...args], { encoding: "utf8", timeout: 60_000 });
}

describe("desktopColdStart", () => {
  test("a head tree that is not built fails before the base tree's Electron is required", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cold-start-runner-"));
    try {
      const [base, head] = [path.join(tmp, "base"), path.join(tmp, "head")];
      const marker = path.join(tmp, "electron-required");
      const write = (file: string, text: string) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      };
      write(path.join(base, "package.json"), JSON.stringify({ main: "main.js" }));
      write(path.join(base, "main.js"), "");
      write(path.join(base, "dist", "index.html"), "");
      // Requiring the real package downloads the binary when it is missing; this stand-in records it.
      write(path.join(base, "node_modules", "electron", "package.json"), "{}");
      write(
        path.join(base, "node_modules", "electron", "index.js"),
        `require("fs").writeFileSync(${JSON.stringify(marker)}, ""); module.exports = "electron";`
      );
      write(path.join(head, "package.json"), JSON.stringify({ main: "main.js" }));

      const result = node([SCRIPT, "--base", base, "--head", head]);
      expect(result.stderr).toContain(`${head}: missing main.js (make build)`);
      expect(result.status).toBe(2);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("importing the module without a script path does not run or throw", () => {
    const url = pathToFileURL(SCRIPT).href;
    const result = node(["--input-type=module", "-e", `await import(${JSON.stringify(url)});`]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
