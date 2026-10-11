import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DisposableTempDir } from "@/node/services/tempDir";
import type { AgentPluginManifest } from "./manifest";
import { compileHookMatcher, loadPluginCodexHooks } from "./codexHooks";

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
  return { rootPath, manifest };
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
      manifest: { ...plugin.manifest, extensions: { "com.openai": { hooks } } },
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
    // One warning per dropped part, in discovery order.
    const patterns = [
      /must be relative paths/,
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

  test("a plugin without hooks has none, silently", async () => {
    using tmp = new DisposableTempDir("codex-hooks-none");
    const plugin = await writePlugin(tmp.path, {});
    expect(await loadPluginCodexHooks(plugin)).toEqual({ hooks: [], warnings: [] });
  });
});
