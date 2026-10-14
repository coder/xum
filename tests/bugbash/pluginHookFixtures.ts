/**
 * Codex-format plugin hook fixtures for the bug bash (startApp.ts seed).
 *
 * Local git repositories that Settings > Plugins can install from their absolute path, and a seed
 * step that installs some of them, so explorers reach the hook review without spending steps on
 * the install. No fixture ships MCP servers or an executable hooks.js: installing or reviewing them
 * starts no process. Model-driven jobs also set XUM_DISABLE_AGENT_TOOLS=1, which registers no Codex
 * hook at all, so hooks never fire in a bug bash (unit and integration tests cover that).
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 as SCHEMA_ID } from "../../src/node/services/agentPlugins/manifest";

/** Plugins the seed installs; the others stay sources for the explorer to install. */
export const PREINSTALLED_PLUGINS = ["hook-review-demo", "hook-big-input", "hook-odd-matchers"];

interface PluginFixture {
  name: string;
  description: string;
  /** hooks/hooks.json content: an object (serialized) or raw text (for a malformed file). */
  hooks: unknown;
}

const guardHook = (tool: string, input: Record<string, unknown>, extra = {}) => ({
  type: "mcp_tool",
  server: "guard",
  tool,
  input,
  ...extra,
});

/**
 * A nested input that is small on disk but large when pretty-printed: the review panel must show a
 * bounded form of it (PluginHooksPanel formatPluginHookInput).
 */
function bigNestedInput(): Record<string, unknown> {
  let nested: unknown = Array.from({ length: 6000 }, (_, i) => i % 10);
  for (let depth = 0; depth < 30; depth++) nested = [nested];
  return { policy: "deny-list", values: nested, note: "x".repeat(60_000) };
}

export function pluginFixtures(): PluginFixture[] {
  return [
    {
      name: "hook-guard",
      description: "Checks shell commands and prompts before they run (bug-bash fixture)",
      hooks: {
        hooks: {
          PreToolUse: [
            {
              matcher: "^Bash$",
              hooks: [
                guardHook(
                  "check_command",
                  { command: "${tool_input.command}" },
                  { timeout: 5, statusMessage: "Checking the command" }
                ),
              ],
            },
          ],
          UserPromptSubmit: [{ hooks: [guardHook("check_prompt", { prompt: "${prompt}" })] }],
          Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
          SessionStart: [{ hooks: [guardHook("hello", {})] }],
        },
      },
    },
    {
      name: "hook-broken-file",
      description: "Ships a hooks.json that is not valid JSON (bug-bash fixture)",
      hooks: '{ "hooks": { "PreToolUse": [ { "matcher": "^Bash$", "hooks": [ ',
    },
    {
      name: "hook-review-demo",
      description:
        "Two hooks to trust, turn off and review again after an update (bug-bash fixture)",
      hooks: {
        hooks: {
          PreToolUse: [
            {
              matcher: "^(Bash|file_edit_replace_string)$",
              hooks: [guardHook("check_edit", { path: "${tool_input.path}" }, { timeout: 10 })],
            },
          ],
          UserPromptSubmit: [{ hooks: [guardHook("check_prompt", { prompt: "${prompt}" })] }],
        },
      },
    },
    {
      name: "hook-big-input",
      description: "A hook whose input is too large to show in full (bug-bash fixture)",
      hooks: {
        hooks: { PreToolUse: [{ matcher: "*", hooks: [guardHook("audit", bigNestedInput())] }] },
      },
    },
    {
      name: "hook-odd-matchers",
      description: "Matchers and handlers Xum refuses, with warnings (bug-bash fixture)",
      hooks: {
        hooks: {
          PreToolUse: [
            { matcher: "(?i)^bash$", hooks: [guardHook("ok_inline_flag", {})] },
            { matcher: "\\A(?:Bash|Edit)\\z", hooks: [guardHook("rust_anchors", {})] },
            { matcher: "^[[:alpha:]]+$", hooks: [guardHook("posix_class", {})] },
            { matcher: "^Bash$", hooks: [guardHook("bad_timeout", {}, { timeout: "ten" })] },
            { matcher: "^Bash$", hooks: [{ type: "mcp_tool", server: " ", tool: "blank_server" }] },
          ],
          NotAnEvent: [{ hooks: [guardHook("unknown_event", {})] }],
        },
      },
    },
  ];
}

function git(dir: string, env: NodeJS.ProcessEnv, ...args: string[]): void {
  const result = spawnSync(
    "git",
    ["-c", "user.name=Bug Bash", "-c", "user.email=bugbash@example.test", ...args],
    { cwd: dir, env, encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${result.stderr}`);
  }
}

function writeHooks(dir: string, hooks: unknown): void {
  fs.mkdirSync(path.join(dir, "hooks"), { recursive: true });
  // Compact on disk: the hooks file limit is 256 KiB, and the big-input fixture must stay under it
  // while its pretty-printed form is many times larger.
  const text = typeof hooks === "string" ? hooks : JSON.stringify(hooks);
  fs.writeFileSync(path.join(dir, "hooks", "hooks.json"), text);
}

/** Writes each fixture as a one-commit git repository; returns name -> absolute path. */
export function writePluginSources(root: string, env: NodeJS.ProcessEnv): Map<string, string> {
  const paths = new Map<string, string>();
  for (const fixture of pluginFixtures()) {
    const dir = path.join(root, fixture.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "plugin.json"),
      JSON.stringify(
        {
          $schema: SCHEMA_ID,
          name: fixture.name,
          version: "1.0.0",
          description: fixture.description,
        },
        null,
        2
      )
    );
    writeHooks(dir, fixture.hooks);
    git(dir, env, "init", "-q", "-b", "main");
    git(dir, env, "add", ".");
    git(dir, env, "commit", "-qm", "v1");
    paths.set(fixture.name, dir);
  }
  return paths;
}

type Api = (route: string, body: unknown) => Promise<unknown>;
type Result<T> = { success: true; data: T } | { success: false; error: string };

function ok<T>(label: string, raw: unknown): T {
  const result = raw as Result<T> | undefined;
  if (result?.success !== true) {
    throw new Error(`plugin hook seed: ${label} failed: ${JSON.stringify(result).slice(0, 500)}`);
  }
  return result.data;
}

/**
 * Installs PREINSTALLED_PLUGINS, trusts hook-review-demo's PreToolUse hook, then commits a v2 of
 * that plugin that changes the trusted hook: Settings > Plugins then offers an update, and after
 * it the hook asks for review again. Writes plugin-sources.md (the install paths) as an artifact.
 */
export async function seedPluginHooks(
  api: Api,
  sources: Map<string, string>,
  env: NodeJS.ProcessEnv,
  artifactsDir: string
): Promise<void> {
  for (const name of PREINSTALLED_PLUGINS) {
    const source = sources.get(name);
    if (source == null) throw new Error(`plugin hook seed: no source for ${name}`);
    const preview = ok<{ source: unknown; lockedSha: string }>(
      `preview ${name}`,
      await api("agentPlugins/preview", { input: source })
    );
    ok(
      `install ${name}`,
      await api("agentPlugins/install", {
        source: preview.source,
        expectedSha: preview.lockedSha,
      })
    );
  }
  const hooks = ok<{ hooks: { key: string; hash: string; event: string }[] }>(
    "getHooks hook-review-demo",
    await api("agentPlugins/getHooks", { name: "hook-review-demo" })
  );
  const pre = hooks.hooks.find((hook) => hook.event === "PreToolUse");
  if (pre == null) throw new Error("plugin hook seed: hook-review-demo has no PreToolUse hook");
  ok(
    "trust hook-review-demo PreToolUse",
    await api("agentPlugins/setHookTrust", {
      name: "hook-review-demo",
      key: pre.key,
      hash: pre.hash,
      state: "trusted",
    })
  );

  // v2: the trusted hook now also checks deletes and waits longer (a changed definition).
  const demo = sources.get("hook-review-demo");
  if (demo == null) throw new Error("plugin hook seed: no hook-review-demo source");
  const v2 = pluginFixtures().find((fixture) => fixture.name === "hook-review-demo");
  const v2Hooks = structuredClone(v2?.hooks) as {
    hooks: { PreToolUse: { matcher: string; hooks: Record<string, unknown>[] }[] };
  };
  v2Hooks.hooks.PreToolUse[0].matcher = "^(Bash|file_edit_replace_string|file_delete)$";
  v2Hooks.hooks.PreToolUse[0].hooks[0].timeout = 30;
  writeHooks(demo, v2Hooks);
  git(demo, env, "commit", "-qam", "v2: the edit check also covers deletes");

  const lines = [
    "# Plugin sources",
    "",
    "Local plugin repositories for the bug bash. Install one in Settings > Plugins by pasting its",
    "path into the install field. Already installed: " + PREINSTALLED_PLUGINS.join(", ") + ".",
    "",
    ...[...sources].map(([name, dir]) => `- ${name}: ${dir}`),
    "",
  ];
  fs.writeFileSync(path.join(artifactsDir, "plugin-sources.md"), lines.join("\n"));
}
