import { describe, expect, test } from "bun:test";
import { backup, BackupPluginManifestSchema } from "./backup";

const SHA = "a".repeat(40);

function entry(overrides: Record<string, unknown> = {}) {
  return {
    name: "pstack",
    source: {
      type: "git",
      url: "https://github.com/example/pstack.git",
      ref: "main",
      refType: "branch",
    },
    lockedSha: SHA,
    ...overrides,
  };
}

function manifest(...plugins: unknown[]) {
  return { schemaVersion: 1, plugins };
}

describe("BackupPluginManifestSchema", () => {
  test("keeps the source, pin, method and imports of an entry", () => {
    const parsed = BackupPluginManifestSchema.parse(
      manifest(
        entry({
          source: {
            type: "git",
            url: "https://github.com/example/mono.git",
            ref: "v1.2.0",
            refType: "tag",
            subpath: "packages/plugin",
          },
          method: { kind: "claude-marketplace", entry: "plugin-a" },
          importedComponents: { skills: ["review"], mcpServers: [] },
        })
      )
    );
    expect(parsed.plugins[0]).toMatchObject({
      source: { ref: "v1.2.0", refType: "tag", subpath: "packages/plugin" },
      method: { kind: "claude-marketplace", entry: "plugin-a" },
      importedComponents: { skills: ["review"], mcpServers: [] },
    });
  });

  test("drops local trust state a hand-edited list carries", () => {
    const parsed = BackupPluginManifestSchema.parse(
      manifest(
        entry({
          installedAt: "2026-01-01T00:00:00.000Z",
          autoUpdate: true,
          componentConsent: { skills: { review: "abc" }, mcpServers: {} },
        })
      )
    );
    expect(Object.keys(parsed.plugins[0] ?? {}).sort()).toEqual(["lockedSha", "name", "source"]);
  });

  test.each([
    ["a short commit id", entry({ lockedSha: "abc1234" })],
    ["an uppercase commit id", entry({ lockedSha: "A".repeat(40) })],
    ["a 64-character commit id", entry({ lockedSha: "a".repeat(64) })],
    ["a name with a path separator", entry({ name: "../evil" })],
    ["a reserved device name", entry({ name: "con" })],
    [
      "a url git would read as an option",
      entry({
        source: {
          type: "git",
          url: "--upload-pack=touch /tmp/pwned",
          ref: "main",
          refType: "branch",
        },
      }),
    ],
    [
      "a url that is an option after the preview trims it",
      entry({
        source: { type: "git", url: " -ux:touch", ref: "main", refType: "branch" },
      }),
    ],
    ["a non-git source", entry({ source: { type: "path", url: "/tmp/x" } })],
    [
      "an oversized url",
      entry({
        source: {
          type: "git",
          url: `https://h/${"a".repeat(3000)}`,
          ref: "main",
          refType: "branch",
        },
      }),
    ],
  ])("refuses %s", (_label, row) => {
    expect(BackupPluginManifestSchema.safeParse(manifest(row)).success).toBe(false);
  });

  test("refuses a list that names a plugin twice and an unknown version", () => {
    expect(BackupPluginManifestSchema.safeParse(manifest(entry(), entry())).success).toBe(false);
    expect(BackupPluginManifestSchema.safeParse({ schemaVersion: 2, plugins: [] }).success).toBe(
      false
    );
  });
});

describe("backup output schemas", () => {
  // oRPC strips output keys the schema does not list, so a field missing here never reaches the UI.
  const pluginFields = {
    pluginInstalls: [{ ...entry(), status: "missing" }],
    pluginListWarnings: ["Left out row 2"],
  };

  test("preview keeps the plugin list fields", () => {
    const parsed = backup.preview.output.parse({
      success: true,
      data: {
        pushChanges: [],
        restoreChanges: [],
        localOnlyFiles: [],
        redactions: [],
        commandApprovals: [],
        projectImports: [],
        projectBundleSkipped: false,
        pushError: null,
        ...pluginFields,
      },
    });
    if (!parsed.success) throw new Error("expected success");
    expect(parsed.data).toMatchObject(pluginFields);
  });

  test("restore keeps the plugin list fields", () => {
    const parsed = backup.restore.output.parse({
      success: true,
      data: {
        commit: SHA,
        snapshotPath: "/tmp/snapshot",
        changedFiles: [],
        localOnlyFiles: [],
        projectImportResults: [],
        projectBundleSkipped: false,
        unapprovedProjectImports: [],
        ...pluginFields,
      },
    });
    if (!parsed.success) throw new Error("expected success");
    expect(parsed.data).toMatchObject(pluginFields);
  });
});
