/**
 * Plugin hook fixtures for the bug bash (startApp.ts seed): Codex-format plugins and a copy of
 * Cursor's ralph-loop (ralph-loop-cursor).
 *
 * Local git repositories that Settings > Plugins can install from their absolute path, and a seed
 * step that installs some of them, so explorers reach the hook review without spending steps on
 * the install. No fixture ships MCP servers or an executable hooks.js: installing or reviewing them
 * starts no process. Model-driven jobs also set XUM_DISABLE_AGENT_TOOLS=1, which registers no Codex
 * hook at all, so hooks never fire in a bug bash (unit and integration tests cover that).
 * ralph-loop-cursor's two command hooks run shell scripts, but only after the user trusts them and
 * only in an app with no XUM_DISABLE_* switch (cursorHookRunner.ts): the mock phase of
 * `make test-bugbash-repros` (repros/cursorStopHookLoop.e2e.ts), never a model-driven job.
 */
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 as SCHEMA_ID } from "../../src/node/services/agentPlugins/manifest";

/** Plugins the seed installs; the others stay sources for the explorer to install. */
export const PREINSTALLED_PLUGINS = [
  "hook-review-demo",
  "hook-big-input",
  "hook-odd-matchers",
  "ralph-loop-cursor",
];

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
            // \pL: Rust syntax Xum still refuses (it translates \A and \z since #6808).
            { matcher: "\\pL(?:Bash|Edit)", hooks: [guardHook("rust_class", {})] },
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

/** relative path -> content, written as is. */
type Files = Record<string, string>;

/**
 * cursor/plugins `ralph-loop` at commit 4dd1d05, with each file's git blob SHA from that commit:
 * `${CURSOR_PLUGIN_ROOT}/hooks/x.sh` must stay the published script, byte for byte.
 */
const RALPH_LOOP_4DD1D05: Record<string, { sha: string; text: string }> = {
  ".cursor-plugin/plugin.json": {
    sha: "529e02ea7b6380442271a346d4c94a1f76868051",
    text: `{
  "name": "ralph-loop",
  "displayName": "Ralph Loop",
  "version": "1.0.0",
  "description": "Continuous self-referential AI loops for iterative development, implementing the Ralph Wiggum technique. Run the agent in a while-true loop with the same prompt until task completion.",
  "author": {
    "name": "Cursor",
    "email": "plugins@cursor.com"
  },
  "homepage": "https://github.com/cursor/plugins",
  "repository": "https://github.com/cursor/plugins",
  "license": "MIT",
  "logo": "assets/avatar.png",
  "keywords": [
    "ralph",
    "loop",
    "iteration",
    "self-referential",
    "automation",
    "iterative-development"
  ],
  "category": "developer-tools",
  "tags": [
    "automation",
    "iteration",
    "agent-loop"
  ],
  "skills": "./skills/",
  "hooks": "./hooks/hooks.json"
}
`,
  },
  "hooks/hooks.json": {
    sha: "04a99668978b1bf028d41c92fa62cd7ae475d166",
    text: `{
  "version": 1,
  "hooks": {
    "afterAgentResponse": [
      {
        "command": "./hooks/capture-response.sh"
      }
    ],
    "stop": [
      {
        "command": "./hooks/stop-hook.sh",
        "loop_limit": null
      }
    ]
  }
}
`,
  },
  "hooks/stop-hook.sh": {
    sha: "ba0ba3434ca4d213cfef58f57699bffaed61dabf",
    text: `#!/bin/bash

# Ralph Loop stop hook.
# When the agent finishes a turn, this hook decides whether to feed the
# same prompt back for another iteration or let the session end.
#
# Cursor stop hook API:
#   Input:  { "status": "completed"|"aborted"|"error", "loop_count": N, ...common }
#   Output: { "followup_message": "<text>" }  to continue, or exit 0 with no output to stop

set -euo pipefail

HOOK_INPUT=$(cat)

PROJECT_DIR="\${CURSOR_PROJECT_DIR:-.}"
STATE_FILE="$PROJECT_DIR/.cursor/ralph/scratchpad.md"
DONE_FLAG="$PROJECT_DIR/.cursor/ralph/done"

# No active loop. Let the session end.
if [[ ! -f "$STATE_FILE" ]]; then
  exit 0
fi

# Parse state file frontmatter
FRONTMATTER=$(sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$STATE_FILE")
ITERATION=$(echo "$FRONTMATTER" | grep '^iteration:' | sed 's/iteration: *//')
MAX_ITERATIONS=$(echo "$FRONTMATTER" | grep '^max_iterations:' | sed 's/max_iterations: *//')
COMPLETION_PROMISE=$(echo "$FRONTMATTER" | grep '^completion_promise:' | sed 's/completion_promise: *//' | sed 's/^"\\(.*\\)"$/\\1/')

# Validate iteration is numeric
if [[ ! "$ITERATION" =~ ^[0-9]+$ ]]; then
  echo "Ralph loop: state file corrupted (iteration: '$ITERATION'). Stopping." >&2
  rm -f "$STATE_FILE" "$DONE_FLAG"
  exit 0
fi

if [[ ! "$MAX_ITERATIONS" =~ ^[0-9]+$ ]]; then
  echo "Ralph loop: state file corrupted (max_iterations: '$MAX_ITERATIONS'). Stopping." >&2
  rm -f "$STATE_FILE" "$DONE_FLAG"
  exit 0
fi

# Check if completion promise was detected by the afterAgentResponse hook
if [[ -f "$DONE_FLAG" ]]; then
  echo "Ralph loop: completion promise fulfilled at iteration $ITERATION." >&2
  rm -f "$STATE_FILE" "$DONE_FLAG"
  exit 0
fi

# Check max iterations
if [[ $MAX_ITERATIONS -gt 0 ]] && [[ $ITERATION -ge $MAX_ITERATIONS ]]; then
  echo "Ralph loop: max iterations ($MAX_ITERATIONS) reached." >&2
  rm -f "$STATE_FILE" "$DONE_FLAG"
  exit 0
fi

# Extract prompt text (everything after the closing --- in frontmatter)
PROMPT_TEXT=$(awk '/^---$/{i++; next} i>=2' "$STATE_FILE")

if [[ -z "$PROMPT_TEXT" ]]; then
  echo "Ralph loop: no prompt text found in state file. Stopping." >&2
  rm -f "$STATE_FILE" "$DONE_FLAG"
  exit 0
fi

# Increment iteration
NEXT_ITERATION=$((ITERATION + 1))
TEMP_FILE="\${STATE_FILE}.tmp.$$"
sed "s/^iteration: .*/iteration: $NEXT_ITERATION/" "$STATE_FILE" > "$TEMP_FILE"
mv "$TEMP_FILE" "$STATE_FILE"

# Build the followup message: iteration context + original prompt
if [[ "$COMPLETION_PROMISE" != "null" ]] && [[ -n "$COMPLETION_PROMISE" ]]; then
  HEADER="[Ralph loop iteration $NEXT_ITERATION. To complete: output <promise>$COMPLETION_PROMISE</promise> ONLY when genuinely true.]"
else
  HEADER="[Ralph loop iteration $NEXT_ITERATION.]"
fi

FOLLOWUP="$HEADER

$PROMPT_TEXT"

# Output followup_message to continue the loop
jq -n --arg msg "$FOLLOWUP" '{"followup_message": $msg}'

exit 0
`,
  },
  "hooks/capture-response.sh": {
    sha: "d8da50a2aeceb066e4715958a6615d116cbb5d37",
    text: `#!/bin/bash

# afterAgentResponse hook for Ralph Loop.
# Checks if the agent's response contains a matching completion promise.
# If found, writes a done flag so the stop hook knows to end the loop.
#
# Input:  { "text": "<assistant response text>" }
# Output: none (fire-and-forget)

set -euo pipefail

HOOK_INPUT=$(cat)

PROJECT_DIR="\${CURSOR_PROJECT_DIR:-.}"
STATE_FILE="$PROJECT_DIR/.cursor/ralph/scratchpad.md"
DONE_FLAG="$PROJECT_DIR/.cursor/ralph/done"

# No active loop, nothing to do
if [[ ! -f "$STATE_FILE" ]]; then
  exit 0
fi

# Extract completion promise from state file frontmatter
FRONTMATTER=$(sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$STATE_FILE")
COMPLETION_PROMISE=$(echo "$FRONTMATTER" | grep '^completion_promise:' | sed 's/completion_promise: *//' | sed 's/^"\\(.*\\)"$/\\1/')

# No promise configured, nothing to check
if [[ "$COMPLETION_PROMISE" = "null" ]] || [[ -z "$COMPLETION_PROMISE" ]]; then
  exit 0
fi

# Extract response text from hook input
RESPONSE_TEXT=$(echo "$HOOK_INPUT" | jq -r '.text // empty')

if [[ -z "$RESPONSE_TEXT" ]]; then
  exit 0
fi

# Check for <promise>TEXT</promise> in the response
PROMISE_TEXT=$(echo "$RESPONSE_TEXT" | perl -0777 -pe 's/.*?<promise>(.*?)<\\/promise>.*/$1/s; s/^\\s+|\\s+$//g; s/\\s+/ /g' 2>/dev/null || echo "")

if [[ -n "$PROMISE_TEXT" ]] && [[ "$PROMISE_TEXT" = "$COMPLETION_PROMISE" ]]; then
  touch "$DONE_FLAG"
fi

exit 0
`,
  },
  "skills/ralph-loop/SKILL.md": {
    sha: "5c943180ac88bb7b0981071a69712e78cfed7089",
    text: `---
name: ralph-loop
description: Start a Ralph Loop for iterative self-referential development. Use when the user asks to run a ralph loop, start an iterative loop, or wants repeated autonomous iteration on a task until completion.
---

# Ralph Loop

## Trigger

The user wants to start a Ralph loop. An iterative development loop where the same prompt is fed back after every turn, and the agent sees its own previous work each iteration.

## Workflow

1. Gather the user's task prompt and optional parameters:
   - \`max_iterations\` (number, default 0 for unlimited)
   - \`completion_promise\` (text, or "null" if not set)

2. Create the directory \`.cursor/ralph/\` if it doesn't exist, then write the state file at \`.cursor/ralph/scratchpad.md\` with this exact format:

   \`\`\`markdown
   ---
   iteration: 1
   max_iterations: <N or 0>
   completion_promise: "<TEXT>" or null
   ---

   <the user's task prompt goes here>
   \`\`\`

   Example:
   \`\`\`markdown
   ---
   iteration: 1
   max_iterations: 20
   completion_promise: "COMPLETE"
   ---

   Build a REST API for todos with CRUD operations, input validation, and tests.
   \`\`\`

3. Confirm to the user that the Ralph loop is active, then begin working on the task.

4. The stop hook automatically intercepts each turn end and feeds the same prompt back as a followup message. You will see it prefixed with \`[Ralph loop iteration N.]\`.

## Guardrails

- If a completion promise is set, you may ONLY output \`<promise>TEXT</promise>\` when the statement is completely and genuinely true.
- Do not output false promises to escape the loop.
- Always recommend setting \`max_iterations\` as a safety net.
- Quote the \`completion_promise\` value in the YAML frontmatter if it contains special characters.

## Output

Confirm the loop is active (prompt, iteration limit, promise if set), then start working on the task immediately.
`,
  },
  "skills/cancel-ralph/SKILL.md": {
    sha: "1e75c5b0ba50de8cd0d8d6baa0f58a9db63c904e",
    text: `---
name: cancel-ralph
description: Cancel an active Ralph Loop. Use when the user wants to stop, cancel, or abort a running ralph loop.
---

# Cancel Ralph

## Trigger

The user wants to cancel or stop an active Ralph loop.

## Workflow

1. Check if \`.cursor/ralph/scratchpad.md\` exists.

2. **If it does not exist**: Tell the user "No active Ralph loop found."

3. **If it exists**:
   - Read \`.cursor/ralph/scratchpad.md\` to get the current iteration from the \`iteration:\` field.
   - Remove the state file and any done flag:
     \`\`\`bash
     rm -rf .cursor/ralph
     \`\`\`
   - Report: "Cancelled Ralph loop (was at iteration N)."

## Output

A short confirmation with the iteration count, or a message that no loop was active.
`,
  },
};

function gitBlobSha(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest("hex");
}

/**
 * The published ralph-loop runs `./hooks/stop-hook.sh`, which Xum, like Cursor, runs from the
 * workspace root, where it is not found (D17). The fixture changes only the two commands, as the
 * unmerged cursor/plugins PR #524 does.
 */
function ralphLoopCursor(): Files {
  const files: Files = {};
  for (const [relPath, file] of Object.entries(RALPH_LOOP_4DD1D05)) {
    if (gitBlobSha(file.text) !== file.sha) {
      throw new Error(`ralph-loop-cursor: ${relPath} is not the cursor/plugins 4dd1d05 file`);
    }
    files[relPath] = file.text;
  }
  let hooks = files["hooks/hooks.json"];
  for (const script of ["capture-response", "stop-hook"]) {
    const published = `"command": "./hooks/${script}.sh"`;
    if (!hooks.includes(published)) throw new Error(`ralph-loop-cursor: no ${published}`);
    hooks = hooks.replace(
      published,
      `"command": ${JSON.stringify(`bash "\${CURSOR_PLUGIN_ROOT}/hooks/${script}.sh"`)}`
    );
  }
  files["hooks/hooks.json"] = hooks;
  return files;
}

/** Fixtures in another tool's format, written file by file. */
function fileFixtures(): Record<string, Files> {
  return { "ralph-loop-cursor": ralphLoopCursor() };
}

/** Upstream marks the two scripts executable; they run as `bash <script>` either way. */
const EXECUTABLE = new Set(["hooks/stop-hook.sh", "hooks/capture-response.sh"]);

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

/** Makes `dir` a git repository with one commit ("v1") of everything in it. */
export function commitFixture(dir: string, env: NodeJS.ProcessEnv): void {
  git(dir, env, "init", "-q", "-b", "main");
  git(dir, env, "add", ".");
  git(dir, env, "commit", "-qm", "v1");
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
    commitFixture(dir, env);
    paths.set(fixture.name, dir);
  }
  for (const [name, files] of Object.entries(fileFixtures())) {
    const dir = path.join(root, name);
    for (const [relPath, content] of Object.entries(files)) {
      const file = path.join(dir, relPath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, { mode: EXECUTABLE.has(relPath) ? 0o755 : 0o644 });
    }
    commitFixture(dir, env);
    paths.set(name, dir);
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
    // A source previews as a plugin or as a Claude Code marketplace; these are plugins.
    const found = ok<{
      kind: string;
      preview?: { source: unknown; method: unknown; lockedSha: string; consentDigest: string };
    }>(`preview ${name}`, await api("agentPlugins/preview", { input: source }));
    const preview = found.preview;
    if (found.kind !== "plugin" || preview === undefined) {
      throw new Error(`plugin hook seed: ${name} previewed as a ${found.kind}, not a plugin`);
    }
    ok(
      `install ${name}`,
      await api("agentPlugins/install", {
        source: preview.source,
        method: preview.method,
        expectedSha: preview.lockedSha,
        expectedConsentDigest: preview.consentDigest,
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
