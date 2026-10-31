import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DisposableTempDir } from "@/node/services/tempDir";
import { discoverAgentPluginAt, nodePluginFs } from "./discovery";
import { loadPluginCursorHooks } from "./cursorHooks";

/** cursor/plugins at 4dd1d05: ralph-loop/hooks/hooks.json. */
const RALPH_LOOP = {
  version: 1,
  hooks: {
    afterAgentResponse: [{ command: "./hooks/capture-response.sh" }],
    stop: [{ command: "./hooks/stop-hook.sh", loop_limit: null }],
  },
};

/** cursor/plugins at 4dd1d05: advisor/hooks/hooks.json. */
const ADVISOR = {
  version: 1,
  hooks: {
    afterFileEdit: [{ command: 'bash "${CURSOR_PLUGIN_ROOT}/hooks/mark-pending.sh"' }],
    afterAgentResponse: [{ command: 'bash "${CURSOR_PLUGIN_ROOT}/hooks/capture-response.sh"' }],
    subagentStop: [
      {
        command: 'bash "${CURSOR_PLUGIN_ROOT}/hooks/record-consult.sh"',
        matcher: "^advisor-subagent$",
      },
    ],
    stop: [{ command: 'bash "${CURSOR_PLUGIN_ROOT}/hooks/stop-hook.sh"', loop_limit: 3 }],
  },
};

function inline(document: Record<string, unknown>) {
  return loadPluginCursorHooks({ rootPath: "/unused", source: document, fs: nodePluginFs });
}

function stopEntry(entry: Record<string, unknown>) {
  return inline({ version: 1, hooks: { stop: [{ command: "./x.sh", ...entry }] } });
}

describe("loadPluginCursorHooks", () => {
  test("ralph-loop: two runnable hooks, and stop has no own loop limit", async () => {
    const { hooks, warnings, notApplied } = await inline(RALPH_LOOP);
    expect(hooks.map((hook) => [hook.event, hook.status])).toEqual([
      ["afterAgentResponse", "runnable"],
      ["stop", "runnable"],
    ]);
    const stop = hooks[1].handler;
    expect(stop.type === "cursor-command" && stop.loopLimit).toBeNull();
    expect(hooks[1].key).toBe("cursor:plugin.json#hooks#stop[0]");
    expect(warnings).toEqual([]);
    expect(notApplied).toEqual([]);
  });

  test("advisor: three runnable hooks and subagentStop listed as an event Xum does not apply", async () => {
    const { hooks, notApplied } = await inline(ADVISOR);
    expect(hooks.filter((hook) => hook.status === "runnable").map((hook) => hook.event)).toEqual([
      "afterFileEdit",
      "afterAgentResponse",
      "stop",
    ]);
    const subagentStop = hooks.find((hook) => hook.event === "subagentStop");
    expect(subagentStop?.status).toBe("ignored-event");
    expect(notApplied).toEqual([
      { part: "hook", name: "subagentStop[0]", reason: "event not applied in Xum" },
    ]);
  });

  test("a reformatted file keeps every hash; a changed loop_limit changes only that hash", async () => {
    using tmp = new DisposableTempDir("cursor-hooks");
    const load = async (text: string) => {
      await fs.mkdir(path.join(tmp.path, "hooks"), { recursive: true });
      await fs.writeFile(path.join(tmp.path, "hooks", "hooks.json"), text);
      const result = await loadPluginCursorHooks({
        rootPath: await fs.realpath(tmp.path),
        source: "hooks/hooks.json",
        fs: nodePluginFs,
      });
      return result.hooks.map((hook) => hook.hash);
    };
    const compact = await load(JSON.stringify(ADVISOR));
    expect(await load(JSON.stringify(ADVISOR, null, 4))).toEqual(compact);
    const changed = structuredClone(ADVISOR);
    changed.hooks.stop[0].loop_limit = 4;
    const next = await load(JSON.stringify(changed));
    expect(next.slice(0, 3)).toEqual(compact.slice(0, 3));
    expect(next[3]).not.toBe(compact[3]);
  });

  test("loop_limit 80 runs as 50 and declared keeps 80; 90 declares something else", async () => {
    const [eighty] = (await stopEntry({ loop_limit: 80 })).hooks;
    const [ninety] = (await stopEntry({ loop_limit: 90 })).hooks;
    expect(eighty.handler.type === "cursor-command" && eighty.handler.loopLimit).toBe(50);
    expect(ninety.handler.type === "cursor-command" && ninety.handler.loopLimit).toBe(50);
    const declared = (hook: typeof eighty): unknown =>
      hook.handler.type === "cursor-command" ? JSON.parse(hook.handler.declared) : undefined;
    expect(declared(eighty)).toEqual({ command: "./x.sh", loop_limit: 80 });
    expect(declared(ninety)).toEqual({ command: "./x.sh", loop_limit: 90 });
    expect(eighty.hash).not.toBe(ninety.hash);
  });

  test.each([-1, 1.5, "3"])("loop_limit %p drops the hook with the warning", async (value) => {
    const { hooks, warnings } = await stopEntry({ loop_limit: value });
    expect(hooks).toEqual([]);
    expect(warnings).toEqual([
      "plugin.json#hooks: hook stop[0]: loop_limit must be a whole number or null; ignoring this hook",
    ]);
  });

  test("an unknown field appears in declared, and changing it changes the hash", async () => {
    const [a] = (await stopEntry({ extra: { a: 1 } })).hooks;
    const [b] = (await stopEntry({ extra: { a: 2 } })).hooks;
    const declared: unknown = a.handler.type === "cursor-command" && JSON.parse(a.handler.declared);
    expect(declared).toMatchObject({ extra: { a: 1 } });
    expect(a.hash).not.toBe(b.hash);
  });

  test("a preToolUse hook is listed as an event Xum does not apply", async () => {
    const { hooks, notApplied } = await inline({
      version: 1,
      hooks: { preToolUse: [{ command: "./guard.sh" }] },
    });
    expect(hooks.map((hook) => hook.status)).toEqual(["ignored-event"]);
    expect(notApplied).toEqual([
      { part: "hook", name: "preToolUse[0]", reason: "event not applied in Xum" },
    ]);
  });

  test("each kind of hook that does not run gets one reason, checked in order", async () => {
    const { hooks, notApplied } = await inline({
      version: 1,
      hooks: {
        stop: [
          { type: "prompt", prompt: "check it", matcher: "x" },
          { command: "./x.sh", matcher: "x" },
        ],
        sessionStart: [{ command: "./x.sh", matcher: "x" }],
      },
    });
    expect(hooks.map((hook) => [hook.handler.type, hook.status])).toEqual([
      ["cursor-prompt", "unsupported-handler"],
      ["cursor-command", "ignored-event"],
      ["cursor-command", "ignored-event"],
    ]);
    expect(notApplied.map((entry) => entry.reason)).toEqual([
      "prompt hooks are not applied in Xum",
      "matcher not applied in Xum",
      "event not applied in Xum",
    ]);
  });

  test("an entry without a command string and a non-positive timeout warn", async () => {
    const { hooks, warnings } = await inline({
      version: 1,
      hooks: { stop: [{ command: 3 }, { command: "./x.sh", timeout: 0 }] },
    });
    expect(hooks).toHaveLength(1);
    expect(hooks[0].handler.type === "cursor-command" && hooks[0].handler.timeoutSeconds).toBe(
      undefined
    );
    expect(warnings).toEqual([
      "plugin.json#hooks: hook stop[0]: an entry needs a command string; ignoring this hook",
      "plugin.json#hooks: hook stop[1]: timeout must be a positive number; using the default",
    ]);
  });

  test("a hook dropped at parse gets a not-applied row with its reason", async () => {
    const { hooks, notApplied } = await inline({
      version: 1,
      hooks: {
        stop: [
          { command: 3 },
          { command: "./x.sh", loop_limit: -1 },
          { command: "./x.sh", loop_limit: 1.5 },
          { command: "./x.sh", loop_limit: "3" },
          { command: "./x.sh", matcher: "x" },
        ],
        "after\u202EFileEdit": "./x.sh",
      },
    });
    expect(hooks.map((hook) => hook.key)).toEqual(["cursor:plugin.json#hooks#stop[4]"]);
    // The kept hook's row first, then the dropped ones in file order. Names stay raw here: the
    // display marks their controls, as for every not-applied row.
    expect(notApplied).toEqual([
      { part: "hook", name: "stop[4]", reason: "matcher not applied in Xum" },
      { part: "hook", name: "stop[0]", reason: "an entry needs a command string" },
      { part: "hook", name: "stop[1]", reason: "loop_limit must be a whole number or null" },
      { part: "hook", name: "stop[2]", reason: "loop_limit must be a whole number or null" },
      { part: "hook", name: "stop[3]", reason: "loop_limit must be a whole number or null" },
      { part: "hook", name: "after\u202EFileEdit", reason: "must be an array of hooks" },
    ]);
  });

  test("dropped-hook rows stop at 50, as the warnings do", async () => {
    const stop = Array.from({ length: 60 }, () => ({ command: 3 }));
    const { notApplied, warnings } = await inline({ version: 1, hooks: { stop } });
    expect(notApplied).toHaveLength(50);
    expect(notApplied.at(-1)?.name).toBe("stop[49]");
    expect(warnings.at(-1)).toBe("10 more hook warnings not shown");
  });

  test("a file with 300 hooks keeps the first 256 and warns", async () => {
    const stop = Array.from({ length: 300 }, (_, index) => ({ command: `./x${index}.sh` }));
    const { hooks, warnings } = await inline({ version: 1, hooks: { stop } });
    expect(hooks).toHaveLength(256);
    expect(hooks.at(-1)?.key).toBe("cursor:plugin.json#hooks#stop[255]");
    expect(warnings).toEqual(["More than 256 hooks; ignoring the rest"]);
  });
});

describe("Cursor hooks through discovery", () => {
  async function discover(files: Record<string, string>, outside?: Record<string, string>) {
    const tmp = new DisposableTempDir("cursor-hooks-discovery");
    const pluginDir = path.join(tmp.path, "plugins", "kit");
    for (const [relative, content] of Object.entries({
      ".cursor-plugin/plugin.json": JSON.stringify({ name: "kit" }),
      ...files,
    })) {
      await fs.mkdir(path.dirname(path.join(pluginDir, relative)), { recursive: true });
      await fs.writeFile(path.join(pluginDir, relative), content);
    }
    for (const [relative, content] of Object.entries(outside ?? {})) {
      await fs.writeFile(path.join(tmp.path, relative), content);
    }
    const { plugin, diagnostics } = await discoverAgentPluginAt({ pluginDir, scope: "global" });
    return { plugin, diagnostics, tmp };
  }

  test("a manifest hooks path with .. gives no hooks and one warning", async () => {
    const { plugin, diagnostics, tmp } = await discover(
      { ".cursor-plugin/plugin.json": JSON.stringify({ name: "kit", hooks: "../hooks.json" }) },
      { "hooks.json": JSON.stringify(RALPH_LOOP) }
    );
    using _tmp = tmp;
    expect(plugin?.cursorHooks?.hooks).toEqual([]);
    const hookWarnings = [
      ...diagnostics.filter((entry) => entry.severity === "warning").map((entry) => entry.message),
      ...(plugin?.cursorHooks?.warnings ?? []),
    ].filter((message) => message.includes("hooks"));
    expect(hookWarnings).toHaveLength(1);
  });

  test("a hooks/hooks.json symlink to a file outside the plugin gives no hooks and one warning", async () => {
    const { tmp } = await discover({});
    using _tmp = tmp;
    const outside = path.join(tmp.path, "outside.json");
    await fs.writeFile(outside, JSON.stringify(RALPH_LOOP));
    const pluginDir = path.join(tmp.path, "plugins", "kit");
    await fs.mkdir(path.join(pluginDir, "hooks"), { recursive: true });
    await fs.symlink(outside, path.join(pluginDir, "hooks", "hooks.json"));
    const { plugin } = await discoverAgentPluginAt({ pluginDir, scope: "global" });
    expect(plugin?.cursorHooks?.hooks).toEqual([]);
    expect(plugin?.cursorHooks?.warnings).toHaveLength(1);
    expect(plugin?.cursorHooks?.warnings[0]).toContain("hooks/hooks.json cannot be read");
  });

  test("a hooks file over 256 KiB gives no hooks and one warning", async () => {
    const padded = JSON.stringify({ ...RALPH_LOOP, pad: "x".repeat(256 * 1024) });
    const { plugin, tmp } = await discover({ "hooks/hooks.json": padded });
    using _tmp = tmp;
    expect(plugin?.cursorHooks?.hooks).toEqual([]);
    expect(plugin?.cursorHooks?.warnings).toHaveLength(1);
  });

  test("the default hooks file is read, and a missing one gives no hooks and no warning", async () => {
    const present = await discover({ "hooks/hooks.json": JSON.stringify(RALPH_LOOP) });
    using _present = present.tmp;
    expect(present.plugin?.cursorHooks?.hooks.map((hook) => hook.key)).toEqual([
      "cursor:hooks/hooks.json#afterAgentResponse[0]",
      "cursor:hooks/hooks.json#stop[0]",
    ]);
    const missing = await discover({});
    using _missing = missing.tmp;
    expect(missing.plugin?.cursorHooks).toEqual({ hooks: [], warnings: [] });
  });
});
