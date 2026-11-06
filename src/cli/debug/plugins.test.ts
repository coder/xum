import { describe, expect, spyOn, test } from "bun:test";
import { installedAsLine, printPlugins } from "./plugins";

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

describe("printPlugins", () => {
  test("prints each plugin with its method and manifest under its root path", () => {
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      printPlugins([
        {
          name: "egm",
          scope: "global",
          rootPath: "/home/me/.xum/plugins/egm",
          version: "0.1.0",
          components: ["skills", "agents"],
          installMethod: "claude-plugin",
          manifestPath: ".claude-plugin/plugin.json",
        },
        {
          name: "bare",
          scope: "project",
          rootPath: "/work/.xum/plugins/bare",
          components: [],
          manifestPath: "plugin.json",
        },
      ]);
      expect(log.mock.calls.map((call) => String(call[0]))).toEqual([
        "Plugins (2):",
        "  - egm (global)  v0.1.0  [skills, agents]",
        "      /home/me/.xum/plugins/egm",
        "      install method: Claude Code plugin; manifest: .claude-plugin/plugin.json",
        "  - bare (project)  [no components]",
        "      /work/.xum/plugins/bare",
        "      install method: none saved (fixed order); manifest: plugin.json",
      ]);
    } finally {
      log.mockRestore();
    }
  });
});
