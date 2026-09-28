import { describe, expect, it } from "bun:test";
import type { AgentPluginInstallEntry } from "@/common/config/schemas/agentPluginInstalls";
import type { BackupPluginRecipe } from "@/common/config/schemas/settingsBackup";
import { pendingBackupPlugins, projectBackupPlugins, readBackupPlugins } from "./pluginsProjection";

const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
const OTHER_SHA = "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1";

function installEntry(
  name: string,
  overrides: Partial<AgentPluginInstallEntry> = {}
): AgentPluginInstallEntry {
  return {
    name,
    scope: "global",
    source: {
      type: "git",
      url: `https://github.com/example/${name}.git`,
      ref: "main",
      refType: "branch",
    },
    lockedSha: SHA,
    installedAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
}

function recipe(name: string, overrides: Partial<BackupPluginRecipe> = {}): BackupPluginRecipe {
  return {
    name,
    source: {
      type: "git",
      url: `https://github.com/example/${name}.git`,
      ref: "main",
      refType: "branch",
    },
    lockedSha: SHA,
    ...overrides,
  };
}

describe("projectBackupPlugins", () => {
  it("exports the pinned source and component allowlist of each managed install, nothing else", () => {
    const recipes = projectBackupPlugins([
      installEntry("grill", {
        updatedAt: "2026-08-02T12:00:00.000Z",
        manifest: { version: "1.2.0", description: "Grills plans." },
        importedComponents: { skills: ["grill"], mcpServers: [] },
        autoUpdate: false,
      }),
      installEntry("pinned", {
        source: {
          type: "git",
          url: "git@github.com:example/pinned.git",
          ref: OTHER_SHA,
          refType: "commit",
        },
        lockedSha: OTHER_SHA,
      }),
    ]);

    expect(recipes).toEqual([
      {
        name: "grill",
        source: {
          type: "git",
          url: "https://github.com/example/grill.git",
          ref: "main",
          refType: "branch",
        },
        lockedSha: SHA,
        importedComponents: { skills: ["grill"], mcpServers: [] },
      },
      {
        name: "pinned",
        source: {
          type: "git",
          url: "git@github.com:example/pinned.git",
          ref: OTHER_SHA,
          refType: "commit",
        },
        lockedSha: OTHER_SHA,
      },
    ]);
    const published = JSON.stringify(recipes);
    for (const local of ["installedAt", "updatedAt", "manifest", "autoUpdate", "scope"]) {
      expect(published).not.toContain(local);
    }
  });

  it("keeps sources that are unsafe to publish out of the backup", () => {
    const unsafeUrls = [
      "https://octocat:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/example/leaky.git",
      "https://github.com/example/leaky.git?access_token=abcdef",
      "/Users/me/plugins/local",
      "file:///Users/me/plugins/local",
      "ext::sh -c touch% /tmp/pwned",
      "git://github.com/example/plain.git",
    ];
    const recipes = projectBackupPlugins([
      ...unsafeUrls.map((url, index) =>
        installEntry(`unsafe-${index}`, {
          source: { type: "git", url, ref: "main", refType: "branch" },
        })
      ),
      installEntry("safe"),
    ]);
    expect(recipes.map((entry) => entry.name)).toEqual(["safe"]);
  });

  it("skips rows the registry itself would not load and keeps the first of a duplicated name", () => {
    const recipes = projectBackupPlugins([
      { name: "../escape", scope: "global" },
      "not an entry",
      installEntry("grill"),
      installEntry("grill", { lockedSha: OTHER_SHA }),
    ]);
    expect(recipes.map((entry) => [entry.name, entry.lockedSha])).toEqual([["grill", SHA]]);
  });
});

describe("readBackupPlugins", () => {
  it("offers nothing for a backup written before plugins were backed up", () => {
    expect(readBackupPlugins({ appearance: {} })).toEqual({ recipes: [], unsupported: [] });
  });

  it("skips tampered recipes by name and keeps the rest", () => {
    const read = readBackupPlugins({
      plugins: [
        recipe("grill"),
        recipe("helper", {
          source: { type: "git", url: "ext::sh -c id", ref: "main", refType: "branch" },
        }),
        recipe("creds", {
          source: {
            type: "git",
            url: "https://user:secret@github.com/example/creds.git",
            ref: "main",
            refType: "branch",
          },
        }),
        recipe("badsha", { lockedSha: "abc123" }),
        recipe("floating", {
          source: {
            type: "git",
            url: "https://github.com/example/floating.git",
            ref: "main",
            refType: "commit",
          },
        }),
        { ...recipe("x"), name: "../../escape" },
        recipe("grill", { lockedSha: OTHER_SHA }),
        { ...recipe("newer"), fieldFromANewerBuild: true },
      ],
    });
    expect(read.recipes.map((entry) => entry.name)).toEqual(["grill", "newer"]);
    expect(read.recipes[1]).not.toHaveProperty("fieldFromANewerBuild");
    expect(read.unsupported).toEqual([
      "plugins.helper",
      "plugins.creds",
      "plugins.badsha",
      "plugins.floating",
      "plugins[5]",
      "plugins.grill",
    ]);
  });

  it("reports a block that is not a list", () => {
    expect(readBackupPlugins({ plugins: { grill: recipe("grill") } })).toEqual({
      recipes: [],
      unsupported: ["plugins (not an array)"],
    });
  });
});

describe("pendingBackupPlugins", () => {
  it("offers what is not installed and lists a same-name install from elsewhere as a conflict", () => {
    const pending = pendingBackupPlugins(
      [
        recipe("missing"),
        recipe("installed"),
        recipe("moved-on"),
        recipe("forked"),
        recipe("monorepo", {
          source: {
            type: "git",
            url: "https://github.com/example/monorepo.git",
            ref: "main",
            refType: "branch",
            subpath: "plugins/monorepo",
          },
        }),
        recipe("unreadable"),
      ],
      [
        installEntry("installed"),
        // A different commit of the same source is an update, not a reinstall.
        installEntry("moved-on", { lockedSha: OTHER_SHA }),
        installEntry("forked", {
          source: {
            type: "git",
            url: "https://github.com/someone-else/forked.git",
            ref: "main",
            refType: "branch",
          },
        }),
        installEntry("monorepo"),
        // A row this build cannot read still owns its name.
        { name: "unreadable", source: { type: "archive" } },
      ]
    );
    expect(pending.map((entry) => [entry.recipe.name, entry.conflict])).toEqual([
      ["missing", false],
      ["forked", true],
      ["monorepo", true],
      ["unreadable", true],
    ]);
  });
});
