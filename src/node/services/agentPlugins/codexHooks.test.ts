import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DisposableTempDir } from "@/node/services/tempDir";
import type { AgentPluginManifest } from "./manifest";
import { compileHookMatcher, loadPluginCodexHooks } from "./codexHooks";
import { discoverAgentPluginAt } from "./discovery";
import { readOpenAIExtension } from "./openaiExtension";

const SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

async function writePlugin(
  root: string,
  files: Record<string, unknown>,
  extensions?: AgentPluginManifest["extensions"]
) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, typeof content === "string" ? content : JSON.stringify(content));
  }
  const rootPath = await fs.realpath(root);
  const manifest: AgentPluginManifest = {
    schemaId: SCHEMA,
    name: "guard",
    ...(extensions !== undefined ? { extensions } : {}),
  };
  // The com.openai view discovery gives the loader (root plugin.json supplies it here).
  const openai = readOpenAIExtension(manifest).extension;
  return {
    rootPath,
    manifest,
    ...(openai !== undefined ? { openai, openaiManifestPath: "plugin.json" } : {}),
  };
}

const scan = {
  type: "mcp_tool",
  server: "scanner",
  tool: "scan",
  input: { cmd: "${tool_input.command}" },
};

describe("loadPluginCodexHooks", () => {
  test("parses hooks/hooks.json: mcp_tool on a mapped event runs, the rest are listed only", async () => {
    using tmp = new DisposableTempDir("codex-hooks-default");
    const plugin = await writePlugin(tmp.path, {
      "hooks/hooks.json": {
        hooks: {
          PreToolUse: [
            { matcher: "^bash$", hooks: [scan, { type: "command", command: "./x.sh" }] },
          ],
          Stop: [{ hooks: [{ type: "mcp_tool", server: "s", tool: "t", timeout: 30 }] }],
          SessionStart: [{ hooks: [{ type: "mcp_tool", server: "s", tool: "t" }] }],
        },
      },
    });

    const { hooks, warnings } = await loadPluginCodexHooks(plugin);

    expect(warnings).toEqual([]);
    expect(
      hooks.map(({ event, matcher, status, handler, source }) => ({
        event,
        matcher,
        status,
        type: handler.type,
        source,
      }))
    ).toEqual([
      {
        event: "PreToolUse",
        matcher: "^bash$",
        status: "runnable",
        type: "mcp_tool",
        source: "hooks/hooks.json",
      },
      {
        event: "PreToolUse",
        matcher: "^bash$",
        status: "unsupported-handler",
        type: "command",
        source: "hooks/hooks.json",
      },
      {
        event: "Stop",
        matcher: undefined,
        status: "runnable",
        type: "mcp_tool",
        source: "hooks/hooks.json",
      },
      {
        event: "SessionStart",
        matcher: undefined,
        status: "ignored-event",
        type: "mcp_tool",
        source: "hooks/hooks.json",
      },
    ]);
    expect(hooks[0]?.handler).toEqual({
      type: "mcp_tool",
      server: "scanner",
      tool: "scan",
      input: { cmd: "${tool_input.command}" },
    });
    expect(hooks[2]?.handler).toMatchObject({ input: {}, timeoutSeconds: 30 });
  });

  test("a non-finite timeout drops only that handler", async () => {
    using tmp = new DisposableTempDir("codex-hooks-timeout");
    const plugin = await writePlugin(tmp.path, {
      // 1e400 parses to Infinity, which JSON and the review RPC cannot carry.
      "hooks/hooks.json": `{ "hooks": { "Stop": [ { "hooks": [ { "type": "mcp_tool", "server": "s", "tool": "t", "timeout": 1e400 }, { "type": "mcp_tool", "server": "s", "tool": "t" } ] } ] } }`,
    });

    const { hooks, warnings } = await loadPluginCodexHooks(plugin);

    expect(hooks.map((hook) => hook.key)).toEqual(["hooks/hooks.json#Stop[0][1]"]);
    expect(warnings).toHaveLength(1);
  });

  test("bounds the work for a pointer: entries, repeated files and hook count", async () => {
    using tmp = new DisposableTempDir("codex-hooks-bounds");
    const many = { hooks: { Stop: [{ hooks: Array.from({ length: 300 }, () => scan) }] } };
    const plugin = await writePlugin(
      tmp.path,
      { "hooks/one.json": { hooks: { Stop: [{ hooks: [scan] }] } }, "hooks/many.json": many },
      { "com.openai": { hooks: Array.from({ length: 1000 }, () => "./hooks/one.json") } }
    );
    const withPointer = (hooks: unknown[]) => ({
      rootPath: plugin.rootPath,
      openai: readOpenAIExtension({ extensions: { "com.openai": { hooks } } }).extension,
      openaiManifestPath: "plugin.json",
    });
    // The same file repeated is read once.
    expect((await loadPluginCodexHooks(plugin)).hooks).toHaveLength(1);
    // Only the first 32 entries are read.
    const inline = { hooks: { Stop: [{ hooks: [scan] }] } };
    const fromEntries = await loadPluginCodexHooks(withPointer(Array(40).fill(inline)));
    expect(fromEntries.hooks).toHaveLength(32);
    // At most 256 hooks per plugin.
    const { hooks, warnings } = await loadPluginCodexHooks(withPointer(["./hooks/many.json"]));
    expect(hooks).toHaveLength(256);
    expect(warnings).toEqual(["More than 256 hooks; ignoring the rest"]);
  });

  test("bounds the warnings of invalid pointer entries and invalid groups", async () => {
    using tmp = new DisposableTempDir("codex-hooks-warning-bounds");
    const invalidGroups = { hooks: { Stop: Array<number>(1000).fill(1) } };
    const plugin = await writePlugin(
      tmp.path,
      { "hooks/bad.json": invalidGroups },
      { "com.openai": { hooks: ["./hooks/bad.json", ...Array<number>(100_000).fill(1)] } }
    );

    const { warnings } = await loadPluginCodexHooks(plugin);

    // Discovery's readOpenAIExtension drops the 100,000 invalid raw entries, so the loader sees
    // one entry. Its 1000 invalid groups: 50 warnings are kept, plus a summary of the rest.
    expect(warnings).toHaveLength(51);
    expect(warnings.at(-1)).toBe("950 more hook warnings not shown");
  });

  test("a hooks file path cannot take an inline source's hook keys", async () => {
    using tmp = new DisposableTempDir("codex-hooks-key-collision");
    const document = { hooks: { Stop: [{ hooks: [scan] }] } };
    const plugin = await writePlugin(
      tmp.path,
      { "plugin.json#hooks[1]": document },
      { "com.openai": { hooks: ["plugin.json#hooks[1]", document] } }
    );

    const { hooks } = await loadPluginCodexHooks(plugin);

    // Only the inline entry's key remains: the file path would have produced the same one.
    expect(hooks.map((hook) => hook.source)).toEqual(["plugin.json#hooks[1]"]);
  });

  test("an inline entry keeps its declared index after an invalid entry is dropped", async () => {
    using tmp = new DisposableTempDir("codex-hooks-inline-index");
    const document = { hooks: { Stop: [{ hooks: [scan] }] } };
    // hooks[0] is not a relative path, so discovery drops it.
    const plugin = await writePlugin(tmp.path, {}, { "com.openai": { hooks: [1, document] } });

    const { hooks } = await loadPluginCodexHooks(plugin);

    expect(hooks.map((hook) => hook.key)).toEqual(["plugin.json#hooks[1]#Stop[0][0]"]);
  });

  test("a com.openai pointer replaces the default file instead of adding to it", async () => {
    using tmp = new DisposableTempDir("codex-hooks-pointer");
    const plugin = await writePlugin(
      tmp.path,
      {
        "hooks/hooks.json": { hooks: { Stop: [{ hooks: [scan] }] } },
        "hooks/tools.json": { hooks: { PostToolUse: [{ hooks: [scan] }] } },
      },
      {
        "com.openai": {
          hooks: ["./hooks/tools.json", { hooks: { UserPromptSubmit: [{ hooks: [scan] }] } }],
        },
      }
    );

    const { hooks, warnings } = await loadPluginCodexHooks(plugin);

    expect(warnings).toEqual([]);
    expect(hooks.map((hook) => [hook.event, hook.source, hook.key])).toEqual([
      ["PostToolUse", "hooks/tools.json", "hooks/tools.json#PostToolUse[0][0]"],
      ["UserPromptSubmit", "plugin.json#hooks[1]", "plugin.json#hooks[1]#UserPromptSubmit[0][0]"],
    ]);
  });

  test("the hash ignores formatting and key order but changes with what runs", async () => {
    const hashes = async (document: string) => {
      using tmp = new DisposableTempDir("codex-hooks-hash");
      const plugin = await writePlugin(tmp.path, { "hooks/hooks.json": document });
      return (await loadPluginCodexHooks(plugin)).hooks.map((hook) => hook.hash);
    };
    const base = await hashes(
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "bash", hooks: [scan] }] } })
    );
    const reordered = await hashes(
      `{ "hooks": { "PreToolUse": [ { "hooks": [ { "input": { "cmd": "\${tool_input.command}" }, "tool": "scan", "server": "scanner", "type": "mcp_tool" } ], "matcher": "bash" } ] } }`
    );
    const otherInput = await hashes(
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "bash", hooks: [{ ...scan, input: {} }] }] },
      })
    );
    const otherMatcher = await hashes(
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "edit", hooks: [scan] }] } })
    );
    const otherEvent = await hashes(
      JSON.stringify({ hooks: { PostToolUse: [{ matcher: "bash", hooks: [scan] }] } })
    );

    expect(base).toHaveLength(1);
    expect(reordered).toEqual(base);
    for (const changed of [otherInput, otherMatcher, otherEvent]) {
      expect(changed).toHaveLength(1);
      expect(changed).not.toEqual(base);
    }
  });

  test("invalid parts are dropped with a warning; siblings still load", async () => {
    using tmp = new DisposableTempDir("codex-hooks-invalid");
    const outside = path.join(tmp.path, "outside.json");
    await fs.writeFile(outside, JSON.stringify({ hooks: { Stop: [{ hooks: [scan] }] } }));
    const plugin = await writePlugin(
      path.join(tmp.path, "plugin"),
      {
        "hooks/a.json": {
          hooks: {
            PreToolUse: [
              { matcher: "(", hooks: [scan] },
              { hooks: [{ type: "mcp_tool", tool: "t" }] },
            ],
            Nonsense: [{ hooks: [scan] }],
            PostToolUse: [{ hooks: [scan] }],
          },
        },
      },
      {
        "com.openai": {
          hooks: ["./hooks/a.json", "./hooks/missing.json", "./hooks/link.json", "../x"],
        },
      }
    );
    await fs.symlink(outside, path.join(plugin.rootPath, "hooks/link.json"));

    const { hooks, warnings } = await loadPluginCodexHooks(plugin);

    expect(hooks.map((hook) => hook.event)).toEqual(["PostToolUse"]);
    // One warning per dropped part, in discovery order. The "../x" pointer entry never reaches
    // the loader: discovery's readOpenAIExtension drops it and reports it as a diagnostic.
    const patterns = [
      /matcher is not a valid regex/,
      /'mcp_tool' handler has missing or invalid fields/,
      /unknown hook event 'Nonsense'/,
      /missing\.json cannot be read/,
      /link\.json cannot be read.*outside/,
    ];
    expect(warnings).toHaveLength(patterns.length);
    patterns.forEach((pattern, index) => expect(warnings[index]).toMatch(pattern));
  });

  test('"*", "" and an omitted matcher all mean match-all (no matcher)', async () => {
    using tmp = new DisposableTempDir("codex-hooks-match-all");
    const plugin = await writePlugin(tmp.path, {
      "hooks/hooks.json": {
        hooks: {
          PreToolUse: [
            { matcher: "*", hooks: [scan] },
            { matcher: "", hooks: [scan] },
            { hooks: [scan] },
          ],
        },
      },
    });

    const { hooks, warnings } = await loadPluginCodexHooks(plugin);

    expect(warnings).toEqual([]);
    expect(hooks.map((hook) => [hook.status, hook.matcher])).toEqual([
      ["runnable", undefined],
      ["runnable", undefined],
      ["runnable", undefined],
    ]);
    // Same thing runs, so the same trust key.
    expect(new Set(hooks.map((hook) => hook.hash)).size).toBe(1);
  });

  test("a handler nested too deeply to hash is dropped with a warning; siblings load", async () => {
    using tmp = new DisposableTempDir("codex-hooks-deep");
    // Under the 256 KiB file cap, but deeper than the stack can recurse.
    const depth = 100_000;
    const deepInput = `{"x":${"[".repeat(depth)}${"]".repeat(depth)}}`;
    const deep = `{"type":"mcp_tool","server":"s","tool":"t","input":${deepInput}}`;
    const plugin = await writePlugin(tmp.path, {
      "hooks/hooks.json": `{"hooks":{"PreToolUse":[{"hooks":[${deep},${JSON.stringify(scan)}]}]}}`,
    });

    const { hooks, warnings } = await loadPluginCodexHooks(plugin);

    expect(hooks.map((hook) => hook.handler.type === "mcp_tool" && hook.handler.server)).toEqual([
      "scanner",
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/nests deeper than \d+ levels; ignoring a handler/);
  });

  test("a non-string matcher nested too deeply to serialize drops its group; siblings load", async () => {
    using tmp = new DisposableTempDir("codex-hooks-deep-matcher");
    // Under the 256 KiB file cap, but deeper than JSON.stringify can recurse.
    const depth = 100_000;
    const deepMatcher = `${"[".repeat(depth)}${"]".repeat(depth)}`;
    const valid = JSON.stringify({ matcher: "Bash", hooks: [scan] });
    const plugin = await writePlugin(tmp.path, {
      "hooks/hooks.json": `{"hooks":{"PreToolUse":[{"matcher":${deepMatcher},"hooks":[${JSON.stringify(scan)}]},${valid}]}}`,
    });

    const { hooks, warnings } = await loadPluginCodexHooks(plugin);

    expect(hooks.map((hook) => hook.matcher)).toEqual(["Bash"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /matcher is not a valid regex \(not a string\); ignoring its group/
    );
  });

  test("Codex matchers: a leading inline-flag group loads; untranslated Rust syntax drops its group", async () => {
    using tmp = new DisposableTempDir("codex-hooks-rust-regex");
    const plugin = await writePlugin(tmp.path, {
      "hooks/hooks.json": {
        hooks: {
          PreToolUse: [
            { matcher: "(?i)^bash$", hooks: [scan] },
            { matcher: "(?x) bash", hooks: [scan] },
          ],
          // Codex ignores the matcher on these events, so an invalid one does not drop the group.
          Stop: [{ matcher: "(", hooks: [scan] }],
          UserPromptSubmit: [{ matcher: "(?P<x>", hooks: [scan] }],
        },
      },
    });

    const { hooks, warnings } = await loadPluginCodexHooks(plugin);

    expect(hooks.map((hook) => [hook.event, hook.matcher])).toEqual([
      ["PreToolUse", "(?i)^bash$"],
      ["Stop", undefined],
      ["UserPromptSubmit", undefined],
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/'PreToolUse' matcher is not a valid regex/);
  });

  test("a Rust matcher that JavaScript would read differently drops its group", async () => {
    using tmp = new DisposableTempDir("codex-hooks-rust-only");
    const refused = ["\\A(?:Bash|Edit)\\z", "^[[:alpha:]]+$", "^\\pL+$", "^[a-z&&[^x]]$"];
    const plugin = await writePlugin(tmp.path, {
      "hooks/hooks.json": {
        hooks: {
          PreToolUse: [
            ...refused.map((matcher) => ({ matcher, hooks: [scan] })),
            // Escaped punctuation, \xhh and a plain class read the same in both dialects.
            { matcher: "^mcp\\.\\x5f[a-z-]+$", hooks: [scan] },
          ],
        },
      },
    });

    const { hooks, warnings } = await loadPluginCodexHooks(plugin);

    expect(hooks.map((hook) => hook.matcher)).toEqual(["^mcp\\.\\x5f[a-z-]+$"]);
    expect(warnings).toHaveLength(refused.length);
    expect(warnings[0]).toMatch(/not a valid regex \('\\A' means something else in JavaScript\)/);
    expect(warnings[1]).toMatch(/'\[' in a character class/);
  });

  test("warnings name the refused matcher and the bad field of each handler", async () => {
    // Bug bash (hooks-warnings-big): two broken handlers in one event gave the same warning.
    using tmp = new DisposableTempDir("codex-hooks-warning-names");
    const plugin = await writePlugin(tmp.path, {
      "hooks/hooks.json": {
        hooks: {
          PreToolUse: [
            { matcher: "\\A(?:Bash|Edit)\\z", hooks: [scan] },
            { matcher: "^Bash$", hooks: [{ ...scan, tool: "bad_timeout", timeout: "ten" }] },
            { matcher: "^Bash$", hooks: [{ type: "mcp_tool", server: " ", tool: "blank_server" }] },
          ],
        },
      },
    });

    const { warnings } = await loadPluginCodexHooks(plugin);

    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('ignoring its group "\\\\A(?:Bash|Edit)\\\\z"');
    expect(warnings[1]).toContain(`('timeout' of tool "bad_timeout")`);
    expect(warnings[2]).toContain(`('server' of tool "blank_server")`);
  });

  test("compileHookMatcher reads matchers as Codex does", () => {
    const matching = (pattern: string, names: string[]) => {
      const matcher = compileHookMatcher(pattern);
      return names.filter((name) => matcher.test(name));
    };
    expect(matching("(?i)^bash$", ["bash", "BASH", "bash2"])).toEqual(["bash", "BASH"]);
    expect(matching("(?is)^a.b$", ["A\nB", "axb", "a\n\nb"])).toEqual(["A\nB", "axb"]);
    // A plain name list matches whole names only.
    expect(matching("Bash|Edit", ["Bash", "Edit", "BashOutput", "MultiEdit"])).toEqual([
      "Bash",
      "Edit",
    ]);
    expect(matching("^mcp__.*", ["mcp__s__t", "x_mcp__"])).toEqual(["mcp__s__t"]);
  });

  test("mcp_tool fields follow Codex: blank targets are dropped, a timeout below 1s becomes 1s", async () => {
    using tmp = new DisposableTempDir("codex-hooks-mcp-fields");
    const plugin = await writePlugin(tmp.path, {
      "hooks/hooks.json": `{"hooks":{"PreToolUse":[{"hooks":[${[
        `{"type":"mcp_tool","server":"s","tool":"zero","timeout":0}`,
        `{"type":"mcp_tool","server":" ","tool":"t"}`,
        `{"type":"mcp_tool","server":"s","tool":"\\t"}`,
        `{"type":"mcp_tool","server":"s","tool":"negative","timeout":-1}`,
        `{"type":"mcp_tool","server":"s","tool":"infinite","timeout":1e400}`,
      ].join(",")}]}]}}`,
    });

    const { hooks, warnings } = await loadPluginCodexHooks(plugin);

    expect(hooks.map((hook) => hook.handler)).toEqual([
      { type: "mcp_tool", server: "s", tool: "zero", input: {}, timeoutSeconds: 1 },
    ]);
    expect(warnings).toHaveLength(4);
    for (const warning of warnings) expect(warning).toMatch(/missing or invalid fields/);
  });

  test("null matcher and null timeout mean omitted, as Codex's Option fields read them", async () => {
    using tmp = new DisposableTempDir("codex-hooks-null-fields");
    const plugin = await writePlugin(tmp.path, {
      "hooks/hooks.json": {
        hooks: {
          PreToolUse: [{ matcher: null, hooks: [{ ...scan, timeout: null }] }, { hooks: [scan] }],
        },
      },
    });

    const { hooks, warnings } = await loadPluginCodexHooks(plugin);

    expect(warnings).toEqual([]);
    expect(hooks.map((hook) => [hook.matcher, hook.handler])).toEqual([
      [undefined, { type: "mcp_tool", server: "scanner", tool: "scan", input: scan.input }],
      [undefined, { type: "mcp_tool", server: "scanner", tool: "scan", input: scan.input }],
    ]);
  });

  test("a fractional timeout drops its handler: Codex reads timeout as whole seconds", async () => {
    using tmp = new DisposableTempDir("codex-hooks-fraction");
    const plugin = await writePlugin(tmp.path, {
      "hooks/hooks.json": {
        hooks: {
          Stop: [
            {
              hooks: [
                { ...scan, timeout: 1.5 },
                { ...scan, timeout: 2 },
                // Every u64 value parses in Codex, also above 2^53; 2^64 does not.
                { ...scan, timeout: 1e19 },
                { ...scan, timeout: 2 ** 64 },
              ],
            },
          ],
        },
      },
    });

    const { hooks, warnings } = await loadPluginCodexHooks(plugin);

    expect(hooks.map((hook) => hook.key)).toEqual([
      "hooks/hooks.json#Stop[0][1]",
      "hooks/hooks.json#Stop[0][2]",
    ]);
    expect(warnings).toHaveLength(2);
  });

  test("a handler whose input holds a non-finite number is dropped with a warning", async () => {
    using tmp = new DisposableTempDir("codex-hooks-non-finite");
    const infinite = `{"type":"mcp_tool","server":"s","tool":"t","input":{"a":[{"b":1e400}]}}`;
    const plugin = await writePlugin(tmp.path, {
      "hooks/hooks.json": `{"hooks":{"PreToolUse":[{"hooks":[${infinite},${JSON.stringify(scan)}]}]}}`,
    });

    const { hooks, warnings } = await loadPluginCodexHooks(plugin);

    expect(hooks.map((hook) => hook.handler.type === "mcp_tool" && hook.handler.server)).toEqual([
      "scanner",
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/non-finite number; ignoring a handler/);
  });

  test("a plugin without hooks has none, silently", async () => {
    using tmp = new DisposableTempDir("codex-hooks-none");
    const plugin = await writePlugin(tmp.path, {});
    expect(await loadPluginCodexHooks(plugin)).toEqual({ hooks: [], warnings: [] });
  });
});

describe("Codex package manifests (the com.openai extension discovery selected)", () => {
  const stopHooks = (tool: string) => ({ hooks: { Stop: [{ hooks: [{ ...scan, tool }] }] } });

  /** Writes `files` under a fresh plugin directory and runs real discovery on it. */
  async function discovered(root: string, files: Record<string, unknown>) {
    const pluginDir = path.join(root, "guard");
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(pluginDir, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, typeof content === "string" ? content : JSON.stringify(content));
    }
    const { plugin, diagnostics } = await discoverAgentPluginAt({ pluginDir, scope: "global" });
    if (plugin === null) throw new Error(`not a plugin: ${JSON.stringify(diagnostics)}`);
    return Object.assign(plugin, { diagnostics });
  }

  test.each([
    { name: "an empty hooks list", hooks: [] as unknown[] },
    { name: "a hooks list whose only entry is invalid", hooks: ["/etc/hooks.json"] },
  ])("$name turns the default hooks file off", async (fixture) => {
    // Codex P1 (PRRT_kwDOPxxmWM6sFheU): trust is keyed by the definition, not the file, so a
    // fallback to hooks/hooks.json would re-run a hook the plugin's update turned off.
    using tmp = new DisposableTempDir("codex-hooks-pointer-off");
    const plugin = await discovered(tmp.path, {
      "plugin.json": {
        $schema: SCHEMA,
        name: "guard",
        extensions: { "com.openai": { hooks: fixture.hooks } },
      },
      "hooks/hooks.json": stopHooks("default_scan"),
    });

    const { hooks } = await loadPluginCodexHooks(plugin);

    expect(hooks).toEqual([]);
    // An invalid entry is reported (a discovery diagnostic); an empty list is a plain off switch.
    expect(
      plugin.diagnostics.some((diagnostic) => diagnostic.message.includes("hooks' entries"))
    ).toBe(fixture.hooks.length > 0);
  });

  test("without a hooks field, the default hooks file loads", async () => {
    using tmp = new DisposableTempDir("codex-hooks-pointer-absent");
    const plugin = await discovered(tmp.path, {
      "plugin.json": { $schema: SCHEMA, name: "guard", extensions: { "com.openai": {} } },
      "hooks/hooks.json": stopHooks("default_scan"),
    });

    const { hooks } = await loadPluginCodexHooks(plugin);

    expect(hooks.map((hook) => hook.source)).toEqual(["hooks/hooks.json"]);
  });

  test("a .codex-plugin/plugin.json overlay's hooks pointer replaces the default file", async () => {
    // Codex PRRT_kwDOPxxmWM6r2kUR: the root plugin.json has no com.openai, so discovery takes it
    // from the overlay; the loader must follow it, not load the default hooks/hooks.json.
    using tmp = new DisposableTempDir("codex-hooks-overlay-pointer");
    const plugin = await discovered(tmp.path, {
      "plugin.json": { $schema: SCHEMA, name: "guard" },
      ".codex-plugin/plugin.json": { name: "guard", hooks: "./hooks/custom.json" },
      "hooks/hooks.json": stopHooks("default_scan"),
      "hooks/custom.json": stopHooks("custom_scan"),
    });

    const { hooks, warnings } = await loadPluginCodexHooks(plugin);

    expect(warnings).toEqual([]);
    expect(
      hooks.map((hook) => [hook.source, hook.handler.type === "mcp_tool" && hook.handler.tool])
    ).toEqual([["hooks/custom.json", "custom_scan"]]);
  });

  test.each([
    {
      name: "a Codex-only package",
      files: { ".codex-plugin/plugin.json": { name: "guard", hooks: stopHooks("inline_scan") } },
      source: ".codex-plugin/plugin.json#hooks[0]",
    },
    {
      name: "a root plugin.json with a Codex overlay",
      files: {
        "plugin.json": { $schema: SCHEMA, name: "guard" },
        ".codex-plugin/plugin.json": { name: "guard", hooks: stopHooks("inline_scan") },
      },
      source: ".codex-plugin/plugin.json#hooks[0]",
    },
    {
      name: "a root plugin.json",
      files: {
        "plugin.json": {
          $schema: SCHEMA,
          name: "guard",
          extensions: { "com.openai": { hooks: stopHooks("inline_scan") } },
        },
      },
      source: "plugin.json#hooks[0]",
    },
  ])("inline hooks of $name are labeled with the manifest that declares them", async (fixture) => {
    // Codex PRRT_kwDOPxxmWM6r2kUY: the label names a file the user can open.
    using tmp = new DisposableTempDir("codex-hooks-inline-label");
    const plugin = await discovered(tmp.path, fixture.files);

    const { hooks } = await loadPluginCodexHooks(plugin);

    expect(hooks.map((hook) => hook.source)).toEqual([fixture.source]);
  });
});
