import { describe, expect, test } from "bun:test";
import { normalizeCursorManifest } from "./cursorManifest";
import { INERT_COMPONENT_PATH, validatePluginManifest } from "./manifest";

function load(raw: Record<string, unknown>) {
  const result = normalizeCursorManifest({ name: "cursor-kit", ...raw });
  const validation = validatePluginManifest(result.manifest);
  if (!validation.ok) {
    throw new Error(`normalized manifest is invalid: ${validation.errors.join("; ")}`);
  }
  return { ...result, loaded: validation.manifest, validatorWarnings: validation.warnings };
}

describe("normalizeCursorManifest metadata", () => {
  test("keeps the metadata fields that the Agent Plugins manifest has", () => {
    const { loaded, warnings, notApplied } = load({
      version: "1.2.3",
      description: "Cursor team kit",
      author: { name: "Cursor", email: "team@cursor.com", url: "https://cursor.com" },
      homepage: "https://cursor.com/plugins",
      repository: "https://github.com/cursor/plugins",
      license: "MIT",
      keywords: ["ci", "review"],
    });
    expect(loaded).toMatchObject({
      name: "cursor-kit",
      version: "1.2.3",
      description: "Cursor team kit",
      author: { name: "Cursor", email: "team@cursor.com", url: "https://cursor.com" },
      homepage: "https://cursor.com/plugins",
      repository: "https://github.com/cursor/plugins",
      license: "MIT",
      keywords: ["ci", "review"],
    });
    expect(warnings).toEqual([]);
    expect(notApplied).toEqual([]);
  });

  test("lists displayName and logo as not applied, without a warning", () => {
    const { loaded, warnings, validatorWarnings, notApplied } = load({
      displayName: "Cursor Kit",
      logo: "assets/logo.svg",
    });
    expect(loaded).not.toHaveProperty("displayName");
    expect(loaded).not.toHaveProperty("logo");
    expect(warnings).toEqual([]);
    expect(validatorWarnings).toEqual([]);
    expect(notApplied).toEqual([
      { part: "field", name: "displayName", reason: "not applied in Xum" },
      { part: "field", name: "logo", reason: "not applied in Xum" },
    ]);
  });

  // RFC section 1 table: `name` gets the "same handling as Claude", and Claude loads a
  // non-kebab name under its lowercase form with `_` as `-`, with a warning.
  test("loads a non-kebab name the way the Claude manifest does", () => {
    const { loaded, warnings } = load({ name: "Cursor_Kit" });
    expect(loaded.name).toBe("cursor-kit");
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("keeps only name, email and url of author, with a warning", () => {
    const { loaded, warnings } = load({ author: { name: "Cursor", twitter: "@cursor" } });
    expect(loaded.author).toEqual({ name: "Cursor" });
    expect(warnings.length).toBe(1);
  });

  test.each([
    "variables",
    "category",
    "tags",
    "publisher",
    "clientVersionRequirement",
    "minClientVersions",
  ])("lists %s as not applied", (field) => {
    const { notApplied } = load({ [field]: field === "tags" ? ["a"] : "value" });
    expect(notApplied).toEqual([{ part: "field", name: field, reason: "not applied in Xum" }]);
  });

  test("lists commands as a not-applied command", () => {
    const { notApplied, loaded } = load({ commands: "./commands/" });
    expect(notApplied).toEqual([
      { part: "command", name: "commands", reason: "not applied in Xum" },
    ]);
    expect(loaded.contributes?.slashCommands).toBeUndefined();
  });

  test("never passes Xum-only contributes or extensions through", () => {
    const { loaded } = load({
      contributes: {
        hooks: "evil-hooks.js",
        workflows: "evil-workflows",
        slashCommands: [{ name: "x", description: "x", expansion: "x" }],
      },
      extensions: { mux: { hooks: { tools: ["bash"] } } },
    });
    expect(loaded.contributes?.hooks).toBeUndefined();
    expect(loaded.contributes?.workflows).toBeUndefined();
    expect(loaded.contributes?.slashCommands).toBeUndefined();
    expect(loaded.extensions).toBeUndefined();
  });
});

describe("normalizeCursorManifest skills", () => {
  test("without the field, the default skills/ folder applies", () => {
    const { loaded, notApplied } = load({});
    expect(loaded.contributes?.skills).toBeUndefined();
    expect(notApplied).toEqual([]);
  });

  test("a string folder path replaces the default", () => {
    expect(load({ skills: "./my-skills/" }).loaded.contributes?.skills).toEqual(["my-skills"]);
  });

  test("a list of two folders keeps both, in order", () => {
    const { loaded, notApplied } = load({ skills: ["./skills/", "./extra-skills"] });
    expect(loaded.contributes?.skills).toEqual(["skills", "extra-skills"]);
    expect(notApplied).toEqual([]);
  });

  test("a file path is listed and loads no skills, not the default folder", () => {
    const { loaded, notApplied } = load({ skills: "./skills/a/SKILL.md" });
    expect(notApplied).toEqual([
      {
        part: "field",
        name: "skills: ./skills/a/SKILL.md",
        reason: "only folder paths are applied in Xum",
      },
    ]);
    expect(loaded.contributes?.skills).toEqual([INERT_COMPONENT_PATH]);
  });

  test("a path outside the plugin folder is listed and loads no skills", () => {
    const { loaded, notApplied } = load({ skills: "../x" });
    expect(notApplied).toEqual([
      { part: "field", name: "skills: ../x", reason: "path is outside the plugin folder" },
    ]);
    expect(loaded.contributes?.skills).toEqual([INERT_COMPONENT_PATH]);
  });

  test("a folder beside a refused path still loads", () => {
    const { loaded, notApplied } = load({ skills: ["./skills/*", "./more"] });
    expect(loaded.contributes?.skills).toEqual(["more"]);
    expect(notApplied).toEqual([
      { part: "field", name: "skills: ./skills/*", reason: "only folder paths are applied in Xum" },
    ]);
  });

  test("a value of the wrong type warns, is dropped, and the default applies", () => {
    const { loaded, warnings } = load({ skills: 3 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^'skills' must be .+; ignoring it$/);
    expect(loaded.contributes?.skills).toBeUndefined();
  });
});

describe("normalizeCursorManifest fields of the wrong type", () => {
  test.each<[string, unknown]>([
    ["skills", 3],
    ["agents", { dir: "x" }],
    ["rules", [true]],
    ["mcpServers", 7],
    ["hooks", ["hooks.json"]],
  ])("a wrong-typed %s is listed as a not-applied field", (field, value) => {
    const { notApplied } = load({ [field]: value });
    expect(notApplied.map((entry) => [entry.part, entry.name])).toEqual([["field", field]]);
    expect(notApplied[0]?.reason).toMatch(/^must be /);
  });
});

describe("normalizeCursorManifest rules", () => {
  test("without the field, rules/ is the rule folder", () => {
    expect(load({}).ruleDirs).toEqual(["rules"]);
  });

  test("a folder path replaces the default", () => {
    expect(load({ rules: "./my-rules/" }).ruleDirs).toEqual(["my-rules"]);
  });

  test("a list of folders keeps each, in order", () => {
    expect(load({ rules: ["./a", "b/"] }).ruleDirs).toEqual(["a", "b"]);
  });

  test("a glob is listed and no rule folder is read", () => {
    const { ruleDirs, notApplied } = load({ rules: "./rules/*.mdc" });
    expect(notApplied).toEqual([
      {
        part: "field",
        name: "rules: ./rules/*.mdc",
        reason: "only folder paths are applied in Xum",
      },
    ]);
    expect(ruleDirs).toEqual([]);
  });

  test.each(["./rules/a.mdc", "./rules/a.md", "./rules/a.markdown", "./rules/a?", "./rules/[ab]"])(
    "%s is not a folder path",
    (entry) => {
      const { ruleDirs, notApplied } = load({ rules: entry });
      expect(notApplied).toEqual([
        { part: "field", name: `rules: ${entry}`, reason: "only folder paths are applied in Xum" },
      ]);
      expect(ruleDirs).toEqual([]);
    }
  );

  test("a value of the wrong type warns and the default applies", () => {
    const { ruleDirs, warnings } = load({ rules: { dir: "x" } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^'rules' must be .+; ignoring it$/);
    expect(ruleDirs).toEqual(["rules"]);
  });
});

describe("normalizeCursorManifest agents", () => {
  test("without the field, the default agents/ folder applies", () => {
    expect(load({}).loaded.contributes?.agents).toBeUndefined();
  });

  test("a string folder path replaces the default", () => {
    expect(load({ agents: "./my-agents/" }).loaded.contributes?.agents).toBe("my-agents");
  });

  test("a list of two folders keeps the first and lists the second", () => {
    const { loaded, notApplied } = load({ agents: ["./agents/", "./more-agents/"] });
    expect(loaded.contributes?.agents).toBe("agents");
    expect(notApplied).toHaveLength(1);
    expect(notApplied[0]).toMatchObject({
      part: "field",
      reason: "only one agents folder is applied in Xum",
    });
    expect(notApplied[0]?.name).toMatch(/^agents: .*more-agents/);
  });

  test("a file path is listed and loads no agents, not the default folder", () => {
    const { loaded, notApplied } = load({ agents: "./agents/reviewer.md" });
    expect(notApplied).toEqual([
      {
        part: "field",
        name: "agents: ./agents/reviewer.md",
        reason: "only folder paths are applied in Xum",
      },
    ]);
    expect(loaded.contributes?.agents).toBe(INERT_COMPONENT_PATH);
  });
});

describe("normalizeCursorManifest mcpServers", () => {
  test("a string path becomes the MCP config path", () => {
    const { loaded, mcpConfigPath, notApplied } = load({ mcpServers: "./config/mcp.json" });
    expect(mcpConfigPath).toBe("config/mcp.json");
    expect(loaded.contributes?.mcp).toBeUndefined();
    expect(notApplied).toEqual([]);
  });

  test("an inline object is listed and keeps the default mcp.json from loading", () => {
    const { loaded, mcpConfigPath, notApplied } = load({
      mcpServers: { github: { command: "npx", args: ["github-mcp"] } },
    });
    expect(notApplied).toEqual([
      {
        part: "mcp",
        name: "mcpServers",
        reason: "inline mcpServers is not applied in Xum; use a ./mcp.json file",
      },
    ]);
    expect(mcpConfigPath).toBe(INERT_COMPONENT_PATH);
    expect(loaded.contributes?.mcp).toBeUndefined();
  });

  test("an inline list is listed the same way", () => {
    const { loaded, mcpConfigPath, notApplied } = load({ mcpServers: [{ command: "npx" }] });
    expect(notApplied).toEqual([
      {
        part: "mcp",
        name: "mcpServers",
        reason: "inline mcpServers is not applied in Xum; use a ./mcp.json file",
      },
    ]);
    expect(mcpConfigPath).toBe(INERT_COMPONENT_PATH);
    expect(loaded.contributes?.mcp).toBeUndefined();
  });
});

describe("normalizeCursorManifest hooks", () => {
  test("without the field, hooks/hooks.json is the hooks file", () => {
    const { hooks, notApplied } = load({});
    expect(hooks).toBe("hooks/hooks.json");
    expect(notApplied).toEqual([]);
  });

  test("a string path replaces the default", () => {
    expect(load({ hooks: "./config/hooks.json" }).hooks).toBe("config/hooks.json");
  });

  test("an inline object is kept as the hooks source", () => {
    const inline = { version: 1, hooks: { stop: [{ command: "./stop.sh" }] } };
    const { hooks, notApplied } = load({ hooks: inline });
    expect(hooks).toEqual(inline);
    expect(notApplied).toEqual([]);
  });

  test("Cursor hooks never become Xum hooks.js", () => {
    expect(load({ hooks: "./hooks/hooks.json" }).loaded.contributes?.hooks).toBeUndefined();
  });
});
