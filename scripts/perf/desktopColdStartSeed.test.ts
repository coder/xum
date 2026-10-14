import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Config } from "../../src/node/config";
import { prepareColdStartSeed } from "./desktopColdStartSeed";

describe("prepareColdStartSeed", () => {
  test("a launch's first workspace list writes nothing to config.json", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cold-start-seed-"));
    try {
      await prepareColdStartSeed(root);
      const configPath = path.join(root, "config.json");
      const before = fs.readFileSync(configPath, "utf8");
      // The same read the app's startup does (WorkspaceService.initialize), from a fresh process.
      const metadata = await new Config(root).getAllWorkspaceMetadata({ probeCheckouts: false });
      expect(metadata).toHaveLength(1);
      expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
