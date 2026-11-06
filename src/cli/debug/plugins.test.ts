import { describe, expect, test } from "bun:test";
import { installedAsLine } from "./plugins";

describe("installedAsLine", () => {
  test("names the saved method and the manifest that loaded", () => {
    expect(
      installedAsLine({
        installMethod: "claude-plugin",
        manifestPath: ".claude-plugin/plugin.json",
      })
    ).toBe("install method: Claude Code plugin; manifest: .claude-plugin/plugin.json");
  });

  test("says that the fixed order loaded a plugin without a saved method", () => {
    expect(installedAsLine({ manifestPath: ".codex-plugin/plugin.json" })).toBe(
      "install method: none saved (fixed order); manifest: .codex-plugin/plugin.json"
    );
  });
});
