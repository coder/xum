---
name: verify-xum
description: Drives the real Xum web UI (a `make dev-server-sandbox` instance with the mock AI, isolated XUM_ROOT and free ports) through agent-browser to prove a change works the way a user sees it, with screenshots, ARIA snapshots and on-disk side effects as evidence. Use to verify a UI or backend change in this checkout end to end, to reproduce a reported Xum bug in the browser, or before claiming a Xum feature works.
---

# Verify Xum in the browser

This skill starts one disposable Xum dev server from this checkout, drives its web UI with
`agent-browser`, and keeps the evidence after teardown. The mock AI (`XUM_MOCK_AI=1`) answers every
chat turn, so a run makes no model calls and costs nothing.

The feature map in [features/README.md](features/README.md) has one recipe per user-facing feature.
Pick the recipe for the behavior you changed and drive every entry point it lists.

Surfaces:

- Primary: the web UI that `make dev-server` serves (Vite on a free port, backend `xum server` on
  another). Source edits hot-reload into the running instance.
- Electron: the same renderer in the desktop shell. This skill does not launch or prove it. See
  the [dev-desktop-sandbox](../dev-desktop-sandbox/SKILL.md) and [electron](../electron/SKILL.md)
  skills.
- CLI: `xum api` against the sandbox (see Drive). Headless `xum run` needs no server. Run it
  under `env -i` with its own two roots under the run's scratch folder, which cleanup deletes. It
  refuses to start without a provider key, so pass a fake one: the mock answers, and your real
  keys stay out.

  ```bash
  env -i PATH="$PATH" HOME="$HOME" TMPDIR="$VERIFY_XUM_RUN/tmp" XUM_MOCK_AI=1 XUM_DISABLE_TELEMETRY=1 \
    ANTHROPIC_API_KEY=sk-ant-verify-xum-fake \
    XUM_ROOT="$VERIFY_XUM_RUN/scratch/cli-root" \
    XUM_RUN_SESSION_ROOT="$VERIFY_XUM_RUN/scratch/cli-sessions" \
    bun src/cli/index.ts run --dir "$VERIFY_XUM_PROJECT" --json "[mock:list-languages] hi"
  ```

- Model-driven explorers and story tests run only in the bug-bash sandbox. See the
  [bug-bash](../bug-bash/SKILL.md) skill.

## Launch

The script runs on Linux only: it needs `setsid`, `flock`, `ss` and `/proc`. Bun on PATH must be
the version in `package.json` `packageManager`. Launch refuses another Bun.

```bash
.xum/skills/verify-xum/scripts/verify-xum.sh launch
```

Launch runs `make dev-server-sandbox` with `--clean-providers --clean-projects`, the mock AI and an
`env -i` allowlist, in its own process group. It returns when the app is usable, in about 15 s when
`dist/` is already built. It gives up when the whole launch, seed included, takes longer than
`VERIFY_XUM_READY_TIMEOUT` seconds (default 300).
Ready means all of these hold:

- the backend that nodemon restarts after the first watch build owns `server.lock` and answers
  `/health`,
- Vite serves the app,
- the seed is done: onboarding marked seen, a fake Anthropic provider on a dead loopback port (the
  composer refuses to send without a provider), the trusted project `demo-app` (a throwaway git
  repo) and the workspace `Verify playground` with its worktree set up.

It prints the run's `export` lines and the URL of the seeded workspace. A failed launch prints the
server log tail and cleans up. Launch refuses while the process group of this checkout's newest
run is alive, by the same identity check as cleanup: two dev servers in one checkout share `dist/`
and `node_modules/.vite`. The group's first process writes the group id into the run's
`state.env` before it starts the server. From that moment, right after the spawn, the check and
cleanup find the group even when the launcher was killed. Until then the group holds the launch
lock, so a second launch waits for it. Launch also stops at once when the
sandbox copied a `config.json` (the recipes assume default preferences) and when the backend
crashes after its rebuild (nodemon then waits for a file change that never comes).

## Doctor

Run it first whenever anything looks off. It changes nothing.

```bash
.xum/skills/verify-xum/scripts/verify-xum.sh doctor
```

Every check line must read `ok`. A `note` line only informs. It checks that the process group
lives and carries the run's id (`VERIFY_XUM_SERVER_OF` in its env), the checkout's newest-run link
names the run, the backend pid in the sandbox `server.lock` and the app port belong to the group,
`/health` answers, `/version` reports the launch commit, and the backend env has `XUM_MOCK_AI=1`.
The backend always has an auth token: launch runs make under `env -i`, which drops
`XUM_DEV_SERVER_NO_AUTH`. (A checkout from before #7904 starts it without one, and the skill works
the same.) Doctor and launch read the token from `server.lock` and send it to curl on stdin, never
in argv.
Exit 1 means do not drive this instance: run cleanup, then launch again.

## Drive

Every bash call starts by loading the run. This sets `AGENT_BROWSER_SESSION` (a session name only
this run uses) and the `VERIFY_XUM_*` paths and URLs. It also unsets the Git variables that point
git at another repository (`GIT_DIR`, `GIT_INDEX_FILE` and the rest of
`git rev-parse --local-env-vars`), so the recipes' git commands act on the demo repo:

```bash
eval "$(.xum/skills/verify-xum/scripts/verify-xum.sh env)"
.xum/skills/verify-xum/scripts/verify-xum.sh open "/workspace/$VERIFY_XUM_WORKSPACE_ID"
.xum/skills/verify-xum/scripts/verify-xum.sh idle
agent-browser snapshot -i
agent-browser find role button click --name "Open settings" --exact
```

- Prefer `find role <role> <action> --name "<accessible name>" --exact` and the names in the
  feature map over `@eN` refs, which change with every snapshot. Without `--exact`, `--name`
  matches substrings and can act on a different element.
- Open pages with `verify-xum.sh open <path>`, not `agent-browser open`. `make dev-server` starts
  the backend with an auth token, and the first page of a browser session needs it as
  `?token=<token>` (the app keeps it and strips it from the address bar). `open` builds that URL in
  node from `server.lock` and hands it to `agent-browser batch` on stdin, so the token is in no
  command line or environment. CAUTION: never put the token in an `agent-browser` argument. Every
  local account can read a process's command line while it runs.
- CAUTION: Run this skill only on a host where you are the only local account. agent-browser
  starts Chrome with a DevTools port on `127.0.0.1` (`--remote-debugging-port=0`), which asks for
  no credentials and which agent-browser cannot turn off. While the signed-in app is open, any
  local account that finds that port can control the browser, read the page and take the stored
  token.
- `open` turns off agent-browser's live stream for the session first, every time, and refuses to
  open the page while it is on. agent-browser 0.33 serves each session's screen and input as a
  WebSocket on `127.0.0.1` that any local account can connect to, starts it with each new
  daemon, and has no setting to keep it off. CAUTION: never run `agent-browser stream enable` in
  a run's session. Another account could then watch and drive the signed-in app.
- `idle` waits until the page settles: no CSS transition runs, and on a `/workspace/` page the
  `Conversation transcript` log is neither loading nor streaming (`aria-busy="false"`). A click
  while the right sidebar slides open lands where the target was and is lost. `idle` exits 3
  when the page shows `<name> failed to load.` (see Gotchas).
- `send-ready` waits until the composer's `Send message` button is enabled. Fill the message, run
  `send-ready`, then send. The workspace composer keeps Send disabled until the transcript has
  caught up, and the new-workspace composer until the branch list has loaded and the draft is
  saved. Enter pressed before that refuses the send.
- After an action that opens a view, wait for the view's text (`agent-browser wait --text "<text>"`)
  before the next key press. The URL changes before the view mounts, and an Escape sent too early
  leaves a dialog open that hides the rest of the page from `find`.
- Chain a wait and the key presses after it with `&&`. A failed wait then stops the chain, and no
  keys go to whatever has focus instead.
- `snapshot -i` lists only interactive elements. Use a full `snapshot` to read text, headings and
  states such as `INTERRUPTED`.
- Mock replies are `Mock response: <your text>`. `[mock:long-stream]` in a message streams for
  about 20 s, long enough to press Stop. Markers such as `[mock:error:api]` and
  `[mock:list-languages]` are in `src/node/services/mock/mockAiRouter.ts`. Mock tool calls are
  canned and leave the worktree alone. A canned `todo_write` (`[mock:todo-nudge]`) still writes
  its TODO list to the workspace's session folder.
- The CLI drives the same server. Run it under `env -i`: the live Xum's server URL and auth
  token are in your env under both `XUM_*` and legacy `MUX_*` names, and the CLI reads either.
  With them gone it finds the sandbox through `XUM_ROOT`:

  ```bash
  env -i PATH="$PATH" HOME="$HOME" XUM_ROOT="$VERIFY_XUM_ROOT" \
    node "$VERIFY_XUM_CHECKOUT/dist/cli/api.mjs" workspace list
  ```

## Evidence

Evidence goes to `$VERIFY_XUM_EVIDENCE`, which is `$VERIFY_XUM_HOME/<run>/evidence`.
`VERIFY_XUM_HOME` defaults to `$XUM_SCRATCH_DIR/verify-xum`, else `$XDG_RUNTIME_DIR/verify-xum`,
else `$HOME/.cache/verify-xum`, and never to a shared TMPDIR. Launch creates it with mode 0700.
Launch and every command that reads a run refuse a home inside the checkout, inside the main
worktree of a linked checkout, or inside the workspace root that the checkout's Vite reports
(`searchForWorkspaceRoot`, which can be a parent folder), symlinks and `..` resolved: Vite serves
every file there to anyone who reaches its port, the run's token copy and evidence included.
They also refuse when that Vite cannot report its root (run `bun install`).
Every command that reads a run's `state.env` first checks that the home and the run folder are
real folders (no symlinks), owned by you and not writable by group or others, and refuses
otherwise: the script sources that file. Cleanup never
deletes the evidence or the server log next to it (`<run>/server.log`). Evidence is meant to be
shared: `capture` replaces the backend's auth token (and any `token=` URL value) with
`<redacted>` in the URL and snapshot it writes, and cleanup does the same in every text file of
the evidence and in the server log. A screenshot is not redacted, so do not capture a page that
shows the token.

```bash
.xum/skills/verify-xum/scripts/verify-xum.sh capture chat/reply
```

`capture <feature>/<step>` writes `<step>.png`, `<step>.aria.txt` (full ARIA snapshot) and
`<step>.url.txt` under `evidence/<feature>/`. Pass absolute paths to any other `agent-browser`
output: it resolves relative paths against its daemon's directory.

Proof standards:

- Drive the path a user takes. No test-only routes, no state written behind the UI's back except
  the seed, and edits to the worktree that stand in for the user's own editor.
- Mock only at a production boundary. The mock AI stands in for the model provider. Do not stub
  Xum's own code, routes or stores to make a step pass.
- Name what the mock skips. It never calls a provider, and its tool calls are canned and leave
  the worktree alone. A mock run does not prove a change to provider requests or tool execution:
  report that part as not verified, or prove it at that boundary.
- Capture the action and the resulting state, not only the final screen.
- Check side effects next to what is visible: rows in
  `$VERIFY_XUM_ROOT/sessions/<workspace id>/chat.jsonl`, entries in `$VERIFY_XUM_ROOT/config.json`,
  git state in the worktree, or the CLI view above.
- Report an entry point you could not drive with the command and the unmet precondition. Do not
  count it as verified through another path.

## Cleanup

```bash
.xum/skills/verify-xum/scripts/verify-xum.sh cleanup
```

Cleanup closes this run's browser session, stops the process group that launch started (SIGTERM,
then SIGKILL after 20 s), deletes the sandbox XUM_ROOT, the run's `tmp` folder (the server tree's
TMPDIR, where the sandbox makes its XUM_ROOT) and the demo repo, and prints the evidence
path and file count. It refuses a run that another checkout launched. It signals the group only
while one of its processes carries the run's id and a live group leader is still the launch's
`make dev-server-sandbox`, so it kills nothing it did not start. Then it blanks the group id in
the run's `state.env`. Run it after every run, failed ones too. `doctor`, `env`, `open`,
`workspace-field`, `capture`, `idle`, `send-ready` and `cleanup` take an optional run directory
after their other arguments. Without one they use the newest launch from this checkout.

## Gotchas

- The bash tool's environment carries the live Xum's `PORT`, auth token and provider keys. Launch
  drops them with `env -i`. Never start a server or CLI by hand without the same care.
- The first open of a lazily loaded panel on a cold Vite cache (Review, for one) reloads the page:
  `server.log` shows `optimized dependencies changed. reloading`. The panel and its tab stay open
  across the reload. Run `idle`, wait for the panel's text, and continue from the open tab (see
  the Review recipe).
- Now and then a lazily loaded module request from agent-browser to Vite never completes. The
  page or panel then shows `<name> failed to load.` with a `Reload` button, and the console logs
  `Failed to fetch dynamically imported module`. curl gets the same module at once, so it is not
  a product failure. `verify-xum.sh idle` exits 3 on it. Run `agent-browser reload`, then repeat
  the step, and note the reload in your report.
- A page that stays on `Loading Xum` under host load recovers with `agent-browser reload`.
- agent-browser's headless Chromium matches `(hover: none)`, so Tailwind's `hover:` and
  `group-hover:` variants never apply. Controls that appear on hover (a sidebar row's archive
  icon) ignore clicks there. Focus them (`agent-browser focus '[aria-label="<name>"]'`) and press
  Enter, which is the keyboard user's path.
- `agent-browser` sessions are host-global. Use only the run's `AGENT_BROWSER_SESSION`.
- HOME is the real one, so git inside the app uses your global git config. Xum writes its own
  state only under the sandbox XUM_ROOT.
