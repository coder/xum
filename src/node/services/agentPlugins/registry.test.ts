import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import { DisposableTempDir } from "@/node/services/tempDir";
import type { MCPServerPluginProvenance } from "@/common/types/mcp";
import { log } from "@/node/services/log";
import {
  installMethodMoved,
  installMethodShaFor,
  isPluginMcpServerAllowed,
  readPluginComponentImports,
  readPluginMcpPolicy,
  readStoredInstallMethod,
  resetUnknownInstallMethodWarningForTests,
} from "./registry";
import { createRawPluginInstallRow, createTestPluginInstallEntry } from "./testFixtures";

const legacy = createTestPluginInstallEntry("demo");
const selective = createTestPluginInstallEntry("demo", { skills: ["selected"], mcpServers: [] });

async function readRows(registryPath: string, plugins: unknown[]) {
  const content = JSON.stringify({ plugins });
  await fs.writeFile(registryPath, content);
  const result = await readPluginComponentImports(registryPath);
  expect(await fs.readFile(registryPath, "utf8")).toBe(content);
  if (result === null) throw new Error("Readable registry rows must be recovered individually");
  return result;
}

describe("readPluginComponentImports", () => {
  test.each([
    { name: "demo" },
    { ...legacy, source: { ...legacy.source, ref: "" } },
    { ...legacy, source: { ...legacy.source, ref: 42 } },
    { ...legacy, source: { ...legacy.source, refType: "invalid" } },
    { ...legacy, scope: "project" },
    { ...legacy, lockedSha: null },
    { ...legacy, installedAt: null },
    { ...legacy, importedComponents: { skills: [] } },
    { ...legacy, source: { type: "unknown" } },
  ])(
    "denies malformed named rows without suppressing healthy sibling mappings: %j",
    async (malformed) => {
      using tmp = new DisposableTempDir("plugin-registry-invalid-row");
      const registryPath = path.join(tmp.path, "plugins.json");
      const result = await readRows(registryPath, [
        malformed,
        createTestPluginInstallEntry("healthy", { skills: [], mcpServers: ["allowed"] }),
        createTestPluginInstallEntry("legacy"),
      ]);
      expect(result.hasUnidentifiedEntries).toBe(false);
      expect(result.byName.get("demo")).toEqual({ skills: [], mcpServers: [] });
      expect(result.byName.get("healthy")).toEqual({ skills: [], mcpServers: ["allowed"] });
      expect(result.byName.has("legacy")).toBe(true);
      expect(result.byName.get("legacy")).toBeUndefined();
      expect(result.byName.has("unregistered")).toBe(false);

      const repaired = await readRows(registryPath, [legacy]);
      expect(repaired.byName.has("demo")).toBe(true);
      expect(repaired.byName.get("demo")).toBeUndefined();
    }
  );

  test.each([
    [legacy, selective],
    [selective, legacy],
    [legacy, { name: "demo" }],
    [{ name: "demo" }, legacy],
    [selective, { name: "demo" }],
    [{ name: "demo" }, selective],
    [legacy, selective, legacy],
  ])("duplicate names stay denied regardless of row order: %j", async (...duplicates) => {
    using tmp = new DisposableTempDir("plugin-registry-duplicates");
    const result = await readRows(path.join(tmp.path, "plugins.json"), duplicates);
    expect(result.hasUnidentifiedEntries).toBe(false);
    expect(result.byName.get("demo")).toEqual({ skills: [], mcpServers: [] });
  });

  test("missing registry allows unmanaged directories; corrupt or unreadable documents deny until repaired", async () => {
    using tmp = new DisposableTempDir("plugin-registry-document-recovery");
    const registryPath = path.join(tmp.path, "plugins.json");
    const missing = await readPluginComponentImports(registryPath);
    expect(missing?.hasUnidentifiedEntries).toBe(false);
    expect(missing?.byName.size).toBe(0);
    for (const corrupt of ["{", "[]", "{}", '{"plugins":null}']) {
      await fs.writeFile(registryPath, corrupt);
      expect(await readPluginComponentImports(registryPath)).toBeNull();
      expect(await fs.readFile(registryPath, "utf8")).toBe(corrupt);
    }
    await fs.unlink(registryPath);
    await fs.mkdir(registryPath);
    expect(await readPluginComponentImports(registryPath)).toBeNull();
    await fs.rmdir(registryPath);
    const recovered = await readRows(registryPath, [selective]);
    expect(recovered.hasUnidentifiedEntries).toBe(false);
    expect(recovered.byName.get("demo")).toEqual(selective.importedComponents);
  });
});

describe("readStoredInstallMethod", () => {
  test("reads each saved manifest method from a raw row", () => {
    for (const method of ["agent-plugin", "claude-plugin", "cursor-plugin"] as const) {
      expect(
        readStoredInstallMethod(createRawPluginInstallRow(legacy, { installMethod: method }))
      ).toBe(method);
    }
  });

  test("a row without the field, or a value that is no row, has no method and no warning", () => {
    resetUnknownInstallMethodWarningForTests();
    const warn = spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      expect(readStoredInstallMethod(createRawPluginInstallRow(legacy, {}))).toBeUndefined();
      expect(readStoredInstallMethod(null)).toBeUndefined();
      expect(readStoredInstallMethod("claude-plugin")).toBeUndefined();
      expect(readStoredInstallMethod([])).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("the warning names the unknown value, cut short, or the kind of a value that is no text", () => {
    const warned = (installMethod: unknown) => {
      resetUnknownInstallMethodWarningForTests();
      const warn = spyOn(log, "warn").mockImplementation(() => undefined);
      try {
        readStoredInstallMethod(createRawPluginInstallRow(legacy, { installMethod }));
        return warn.mock.calls.map(([, detail]) => detail);
      } finally {
        warn.mockRestore();
      }
    };
    expect(warned("codex-plugin")).toEqual([{ installMethod: "codex-plugin" }]);
    expect(warned("x".repeat(100))).toEqual([{ installMethod: "x".repeat(64) }]);
    expect(warned(7)).toEqual([{ installMethod: "number" }]);
  });

  test("an unknown value (from a newer build) means the fixed order and warns once per process", () => {
    resetUnknownInstallMethodWarningForTests();
    const warn = spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      for (const installMethod of ["codex-plugin", 7, null, { kind: "claude-plugin" }, ""]) {
        expect(
          readStoredInstallMethod(createRawPluginInstallRow(legacy, { installMethod }))
        ).toBeUndefined();
      }
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("readPluginComponentImports saved install methods", () => {
  test("methodByName holds each row's saved method, by plugin name", async () => {
    using tmp = new DisposableTempDir("plugin-registry-install-method");
    const result = await readRows(path.join(tmp.path, "plugins.json"), [
      createRawPluginInstallRow(createTestPluginInstallEntry("claude"), {
        installMethod: "claude-plugin",
      }),
      createRawPluginInstallRow(createTestPluginInstallEntry("cursor"), {
        installMethod: "cursor-plugin",
      }),
      createTestPluginInstallEntry("legacy"),
    ]);
    expect(result.methodByName.get("claude")).toBe("claude-plugin");
    expect(result.methodByName.get("cursor")).toBe("cursor-plugin");
    expect(result.methodByName.has("legacy")).toBe(false);
  });

  test("an unknown installMethod never invalidates the row: imports and consent stay as saved", async () => {
    using tmp = new DisposableTempDir("plugin-registry-unknown-install-method");
    const consent = {
      skills: { greet: "fp" },
      mcpServers: {},
      workflows: {},
      agents: {},
      slashCommands: {},
    };
    const entry = createTestPluginInstallEntry(
      "demo",
      { skills: ["greet"], mcpServers: [] },
      consent
    );
    const result = await readRows(path.join(tmp.path, "plugins.json"), [
      createRawPluginInstallRow(entry, { installMethod: "windsurf-plugin" }),
    ]);
    expect(result.byName.get("demo")).toEqual({ skills: ["greet"], mcpServers: [] });
    expect(result.consentByName.get("demo")).toEqual(consent);
    expect(result.installedAtByName.get("demo")).toBe(entry.installedAt);
    expect(result.methodByName.has("demo")).toBe(false);
  });
});

describe("installMethodMoved", () => {
  const saved = (extra: Record<string, unknown>) =>
    createRawPluginInstallRow(legacy, { installMethod: "claude-plugin", ...extra });

  test("a row that vouches for its commit has not moved", () => {
    expect(installMethodMoved(saved({ installMethodSha: legacy.lockedSha }))).toBe(false);
  });

  test("a different, missing or malformed installMethodSha counts as moved", () => {
    expect(installMethodMoved(saved({ installMethodSha: "b".repeat(40) }))).toBe(true);
    expect(installMethodMoved(saved({}))).toBe(true);
    for (const installMethodSha of [7, null, {}, [legacy.lockedSha], ""]) {
      expect(installMethodMoved(saved({ installMethodSha }))).toBe(true);
    }
  });

  test("a row without a saved method, or with one this build does not know, has nothing to compare", () => {
    expect(installMethodMoved(legacy)).toBe(false);
    expect(installMethodMoved(createRawPluginInstallRow(legacy, { installMethodSha: "b" }))).toBe(
      false
    );
    resetUnknownInstallMethodWarningForTests();
    const warn = spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      expect(installMethodMoved(saved({ installMethod: "windsurf-plugin" }))).toBe(false);
    } finally {
      warn.mockRestore();
    }
    expect(installMethodMoved(null)).toBe(false);
  });

  test("only a row with a saved method gets an installMethodSha", () => {
    expect(installMethodShaFor("cursor-plugin", legacy.lockedSha)).toEqual({
      installMethodSha: legacy.lockedSha,
    });
    expect(installMethodShaFor(undefined, legacy.lockedSha)).toEqual({});
  });

  test("methodMovedByName names the rows that an older build moved", async () => {
    using tmp = new DisposableTempDir("plugin-registry-method-moved");
    const entry = (name: string) => createTestPluginInstallEntry(name);
    const result = await readRows(path.join(tmp.path, "plugins.json"), [
      createRawPluginInstallRow(entry("current"), {
        installMethod: "claude-plugin",
        installMethodSha: legacy.lockedSha,
      }),
      createRawPluginInstallRow(entry("moved"), {
        installMethod: "claude-plugin",
        installMethodSha: "b".repeat(40),
      }),
      createRawPluginInstallRow(entry("unrecorded"), { installMethod: "cursor-plugin" }),
      entry("legacy"),
    ]);
    expect([...result.methodMovedByName].sort()).toEqual(["moved", "unrecorded"]);
  });
});

describe("readPluginComponentImports saved methods of rows that fail the schema", () => {
  const saved = { installMethod: "claude-plugin", installMethodSha: legacy.lockedSha };

  test("a row that a newer build made invalid keeps its saved method, and imports and consent stay closed", async () => {
    using tmp = new DisposableTempDir("plugin-registry-invalid-row-method");
    const newerSource = { ...legacy, source: { type: "future-kind", url: "x" } };
    const result = await readRows(path.join(tmp.path, "plugins.json"), [
      createRawPluginInstallRow(newerSource, saved),
    ]);
    expect(result.methodByName.get("demo")).toBe("claude-plugin");
    expect(result.byName.get("demo")).toEqual({ skills: [], mcpServers: [] });
    expect(result.consentByName.get("demo")?.mcpServers).toEqual({});
    expect(result.methodMovedByName.has("demo")).toBe(false);

    const moved = await readRows(path.join(tmp.path, "plugins.json"), [
      createRawPluginInstallRow(newerSource, { installMethod: "claude-plugin" }),
    ]);
    expect(moved.methodMovedByName.has("demo")).toBe(true);
  });

  test("two rows of one name leave no saved method", async () => {
    using tmp = new DisposableTempDir("plugin-registry-duplicate-row-method");
    const result = await readRows(path.join(tmp.path, "plugins.json"), [
      createRawPluginInstallRow(legacy, saved),
      createRawPluginInstallRow({ ...legacy, source: { type: "future-kind" } }, saved),
    ]);
    expect(result.methodByName.has("demo")).toBe(false);
    expect(result.methodMovedByName.has("demo")).toBe(false);
    expect(result.byName.get("demo")).toEqual({ skills: [], mcpServers: [] });

    const invalidFirst = await readRows(path.join(tmp.path, "plugins.json"), [
      createRawPluginInstallRow({ ...legacy, source: { type: "future-kind" } }, saved),
      createRawPluginInstallRow(legacy, saved),
    ]);
    expect(invalidFirst.methodByName.has("demo")).toBe(false);
  });
});

describe("readPluginMcpPolicy", () => {
  test("canonical snapshot ignores skills, metadata, ordering, and duplicate selected names", async () => {
    using tmp = new DisposableTempDir("mcp-policy-content");
    await fs.mkdir(path.join(tmp.path, "plugins"));
    const registryPath = path.join(tmp.path, "plugins.json");
    await readRows(registryPath, [
      legacy,
      createTestPluginInstallEntry("other", { skills: [], mcpServers: ["b", "a", "a"] }),
    ]);
    const before = await readPluginMcpPolicy(registryPath);
    await readRows(registryPath, [
      createTestPluginInstallEntry("other", { skills: ["new"], mcpServers: ["a", "b"] }),
      { ...legacy, lockedSha: "new" },
    ]);
    expect(await readPluginMcpPolicy(registryPath)).toEqual(before);
    await readRows(registryPath, [
      legacy,
      createTestPluginInstallEntry("other", { skills: [], mcpServers: ["b"] }),
    ]);
    expect(await readPluginMcpPolicy(registryPath)).not.toEqual(before);
  });

  test("a managed server is allowed only for its reviewed fingerprint (#6498)", async () => {
    using tmp = new DisposableTempDir("mcp-policy-consent");
    await fs.mkdir(path.join(tmp.path, "plugins"));
    const registryPath = path.join(tmp.path, "plugins.json");
    const save = async (componentConsent?: Parameters<typeof createTestPluginInstallEntry>[2]) => {
      await readRows(registryPath, [
        createTestPluginInstallEntry("demo", { skills: [], mcpServers: ["srv"] }, componentConsent),
      ]);
      return readPluginMcpPolicy(registryPath);
    };
    const unreviewed = await save();
    const server: MCPServerPluginProvenance = {
      pluginName: "demo",
      serverName: "srv",
      sourceScope: "global",
      sourceLocation: "plugins/demo",
      componentPolicy: { registryPath: unreviewed.registryPath, name: "demo" },
      consentFingerprint: "reviewed",
    };
    // An imported name without a record (every install from before #6498) does not start.
    expect(isPluginMcpServerAllowed(server, unreviewed)).toBe(false);
    // Neither does a record for another fingerprint, or a skill record of the same name.
    expect(
      isPluginMcpServerAllowed(
        server,
        await save({
          skills: {},
          mcpServers: { srv: "x" },
          workflows: {},
          agents: {},
          slashCommands: {},
        })
      )
    ).toBe(false);
    expect(
      isPluginMcpServerAllowed(
        server,
        await save({
          skills: { srv: "reviewed" },
          mcpServers: {},
          workflows: {},
          agents: {},
          slashCommands: {},
        })
      )
    ).toBe(false);
    const reviewed = await save({
      skills: {},
      mcpServers: { srv: "reviewed" },
      workflows: {},
      agents: {},
      slashCommands: {},
    });
    expect(isPluginMcpServerAllowed(server, reviewed)).toBe(true);
    // A consent change is a policy change, so running clients are rechecked.
    expect(reviewed).not.toEqual(unreviewed);
    // A server whose load computed no fingerprint never matches.
    expect(isPluginMcpServerAllowed({ ...server, consentFingerprint: undefined }, reviewed)).toBe(
      false
    );
    // Unmanaged servers (no install owner) are not gated.
    expect(isPluginMcpServerAllowed({ ...server, componentPolicy: undefined }, unreviewed)).toBe(
      true
    );
  });

  test("owner retarget during the registry read cannot authorize the old canonical owner", async () => {
    using tmp = new DisposableTempDir("mcp-policy-owner");
    const a = path.join(tmp.path, "a");
    const b = path.join(tmp.path, "b");
    const alias = path.join(tmp.path, "alias");
    for (const home of [a, b]) {
      await fs.mkdir(path.join(home, "plugins"), { recursive: true });
      await readRows(path.join(home, "plugins.json"), [legacy]);
    }
    await fs.symlink(a, alias, "dir");
    const original = fs.readFile;
    const read = spyOn(fs, "readFile").mockImplementation(
      // The forwarding wrapper preserves readFile's encoding-dependent overloads.
      (async (...args: Parameters<typeof fs.readFile>) => {
        const value = await original(...args);
        await fs.unlink(alias);
        await fs.symlink(b, alias, "dir");
        return value;
      }) as typeof fs.readFile
    );
    try {
      expect((await readPluginMcpPolicy(path.join(alias, "plugins.json"))).imports).toBeNull();
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
    }
    expect((await readPluginMcpPolicy(path.join(alias, "plugins.json"))).registryPath).toBe(
      path.join(b, "plugins.json")
    );
  });
});
