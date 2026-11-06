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

## Threat model

CAUTION: Run this skill only on a host where you are the only local account. agent-browser starts
Chrome with a DevTools port on `127.0.0.1` (`--remote-debugging-port=0`), which asks for no
credentials and which agent-browser cannot turn off. While the signed-in app is open, any local
account that finds that port can control the browser, read the page and take the stored token.

The skill trusts the checkout. Launch runs the checkout's code, and Bun loads the checkout's
`.env` files into the processes launch starts, so a line such as `NODE_OPTIONS=--require=<file>`
there runs code in Vite and the backend. None of the protections below holds against a checkout
you do not trust.

These protections matter on a host where you are the only local account too:

- No text evidence keeps the token: `capture` replaces it with `<redacted>` in the files it
  writes, and cleanup in every text file of the evidence and in the server log (see Evidence).
  Screenshots are not redacted.
- `env` and `open` keep the token out of your terminal and the agent's transcript: `env` prints
  none, and `open` does not print agent-browser's output, which repeats the URL with the token
  (when the open fails, it prints that output redacted).
- Vite never serves the token: launch and every command that reads a run refuse a run home in a
  folder that Vite serves (see Evidence), and `vite.config.ts` denies `server.lock` and its
  temporary copies.
- A web page that rebinds its DNS name to this machine cannot reach the app that Vite serves.
  Launch's `env -i` drops every `VITE_ALLOWED_HOSTS` spelling and the port-forward proxy
  variables. Bun still loads the checkout's `.env` files into the sandbox script, so launch
  refuses unless the `Allowed hosts:` line in `server.log` reads `loopback only`. Vite then
  accepts only `localhost`, a `*.localhost` name or an IP address as the Host (an IP address
  cannot be rebound) and refuses every other name, also on its WebSocket proxy to the backend.
  The backend's own TCP port has no Host check, but its API calls (`/orpc`, and `/api` except
  its spec and docs) need the token. The `Allowed hosts:` check catches a `.env` line written for
  remote access, not a hostile checkout.
- Other machines cannot reach Vite or the backend: launch refuses unless both listen only on a
  loopback address. A `.env` line such as `XUM_VITE_HOST=0.0.0.0` makes a server listen on every
  interface, and Vite accepts an IP-address Host. This check too catches a `.env` line written
  for remote access, not a hostile checkout.
- `open` turns off agent-browser's live stream, a WebSocket on `127.0.0.1` that any local account
  can connect to, and so can a web page on a `localhost`, `127.0.0.1` or `[::1]` origin (see
  Drive).

These protections matter only when other local accounts exist, and they are not enough there:
the DevTools port above stays open.

- The token is in no command line: `open`, launch, `doctor` and the redaction pass it to node or
  curl on stdin or fd 3 (see Drive and Doctor). `make dev-server` exports it to the server's own
  processes, whose environment only you and root can read.
- No other account except root can replace or write the run's files: launch makes the run
  folder (with the run's 0600 token copy) and the server tree's TMPDIR with mode 0700, and the
  run home too when it makes it. Launch and every command that reads a run refuse a run home or
  run folder that group or others can write, every command refuses such a git dir, and all of
  them refuse a folder above these that group or others can write without the sticky bit (see
  Launch and Evidence).

## Launch

The script runs on Linux only: it needs `setsid`, `flock`, `ss` and `/proc`. Every command
refuses a checkout whose git dir (or, for a worktree, its common git dir) is not yours or is
writable by group or others, and one with a folder above that git dir that is not yours or
root's, or that group or others can write without the sticky bit: the launch lock and the
newest-run link live there. Use a checkout of your own, not a shared repository. Under umask 002
(the default on Debian and Ubuntu, which give each user a private group), git makes a clone's
folder, `.git` and `.git/worktrees/<name>` 0775, so every command refuses. Run
`chmod g-w,o-w` on the folder the message names (it names one at a time), or use a checkout made
under umask 022. A writable folder you do not own (root's, for example) cannot be fixed that way:
the message then says to use a checkout under folders you own. Bun on PATH must be the version in
`package.json` `packageManager`. Launch refuses another Bun.

```bash
.xum/skills/verify-xum/scripts/verify-xum.sh launch
```

Launch runs `make dev-server-sandbox` with `--clean-providers --clean-projects`, the mock AI and an
`env -i` allowlist, in its own process group. It returns when the app is usable. That takes about
2 to 3 minutes on a busy host, most of it the module walk below, plus the rebuild of `dist/` after a
source change. It gives up when the whole launch, seed and module walk included, takes longer than
`VERIFY_XUM_READY_TIMEOUT` seconds (default 600).
Ready means all of these hold:

- the backend that nodemon restarts after the first watch build owns `server.lock` and answers
  `/health`,
- Vite serves the app,
- the seed is done: onboarding marked seen, a fake Anthropic provider on a dead loopback port (the
  composer refuses to send without a provider), the trusted project `demo-app` (a throwaway git
  repo) and the workspace `Verify playground` with its worktree set up,
- Vite has transformed every module that the renderer's served code imports, statically or with
  `import()` (about 1,600). Worker scripts are left out (see Gotchas). Vite transforms a module on
  its first request, on one thread. For the first page load that is about 45 CPU seconds, most of
  it in Babel, where React Compiler runs. A cold Vite makes the first `open` plus `idle` take
  longer than agent-browser's 25 s wait. `scripts/warmViteModules.ts` requests the whole graph over
  HTTP, so the first `open` gets modules from Vite's cache. It fails the launch on a module that
  Vite cannot serve.

It prints the run's `export` lines and the URL of the seeded workspace. A failed launch prints the
server log tail and cleans up. Launch refuses while the process group of this checkout's newest
run is alive, by the same identity check as cleanup: two dev servers in one checkout share `dist/`
and `node_modules/.vite`. The group's first process writes the group id into the run's
`state.env` before it starts the server. From that moment, right after the spawn, the check and
cleanup find the group even when the launcher was killed. Until then the group holds the launch
lock, so a second launch waits for it. Launch also stops at once when the sandbox copied a
`config.json` (the recipes assume default preferences), when the sandbox's `Allowed hosts:` line
does not read `loopback only`, when Vite or the backend listens on an address that is not
loopback, `ss` fails or, once it answers, `ss` shows no socket for it (see Threat model), when the
backend has no auth token (see Doctor), and when the backend crashes after its rebuild (nodemon
then waits for a file change that never comes).

## Doctor

Run it first whenever anything looks off. It changes nothing.

```bash
.xum/skills/verify-xum/scripts/verify-xum.sh doctor
```

Every check line must read `ok`. A `note` line only informs. It checks that the process group
lives and carries the run's id (`VERIFY_XUM_SERVER_OF` in its env), the checkout's newest-run link
names the run, the backend pid in the sandbox `server.lock` and the app port belong to the group,
`/health` answers, `/version` reports the launch commit, and the backend env has `XUM_MOCK_AI=1`.
The backend always has an auth token: launch refuses a backend whose `server.lock` has none.
Launch's `env -i` drops `XUM_DEV_SERVER_NO_AUTH`, but Bun loads the checkout's `.env` files into
the sandbox script, so a `.env` line `XUM_DEV_SERVER_NO_AUTH=1` turns auth off again. The refusal
names that line and says to remove it. (A checkout from before #7904 starts the backend without a
token, so launch refuses it too.) Doctor and launch send the token to the backend only over its
Unix socket, which the Makefile puts in a folder that only you can write, and give it to curl on
stdin, never in argv. They never send it to the TCP port: while the backend starts, stops or
restarts under nodemon, that port can be free for another account to bind. Doctor's `/health`
check needs no token and goes to the TCP port.
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
  node from `server.lock` (or the run's token copy) and hands it to `agent-browser batch` on
  stdin, so no command line or environment of `open`'s processes holds the token. CAUTION: never
  put the token in an `agent-browser` argument. Every local account can read a process's command
  line while it runs.
- `open` turns off agent-browser's live stream for the session first, every time, and refuses to
  open the page while it is on. agent-browser 0.33 serves each session's screen and input as a
  WebSocket on `127.0.0.1` that any local account can connect to, and so can a web page on a
  `localhost`, `127.0.0.1` or `[::1]` origin. agent-browser starts the stream with each new
  daemon and has no setting to keep it off. CAUTION: never run `agent-browser stream enable` in a
  run's session. Another account could then watch and drive the signed-in app.
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
- The CLI drives the same server. Run it through `verify-xum.sh cli`, which runs
  `dist/cli/api.mjs` against the newest run under `env -i`: the live Xum's server URL and auth
  token are in your env under both `XUM_*` and legacy `MUX_*` names, and the CLI reads either.
  With them gone it finds the sandbox through `XUM_ROOT`:

  ```bash
  verify-xum.sh cli workspace list
  ```

  The CLI talks to the TCP port that `server.lock` names, and it has no Unix-socket mode. So
  `cli` first checks that the pid in `server.lock` carries this run's id and is the only listener
  on that port, and refuses otherwise (a backend that is stopping or restarting). A restart in the
  moment between that check and the CLI's own read of `server.lock` is not covered.

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

### WebKit capture

agent-browser drives Chromium. Phone users run Safari, which is WebKit, and the two engines lay
some pages out differently, so a Chromium pass cannot show a WebKit-only defect. `webkit-capture`
opens a page of the run in Playwright WebKit at a phone viewport:

```bash
.xum/skills/verify-xum/scripts/verify-xum.sh webkit-capture "/workspace/$VERIFY_XUM_WORKSPACE_ID" chat/reply
```

`webkit-capture <path> <feature>/<step>` loads `<path>` in a new browser (390x844 at 3x, mobile,
touch), waits as `idle` does, and writes `<step>-webkit.png` and `<step>-webkit.txt` under
`evidence/<feature>/`. `idle`'s test reads a page as settled while it still shows the loading
screen or a Mermaid diagram that is still rendering, so this command also waits for both to go.
After 60 s it exits 1 and names what still shows. It exits 3 on `<name> failed to load.`, as
`idle` does, and 1 when the page shows the startup connection error or the token prompt instead
of the page. A failed run leaves no `-webkit` files from an earlier run of the same name.

The report holds only fixed text and numbers: the URL you gave (without the token), the engine and
its mode, the viewport, `document.documentElement.scrollWidth <= innerWidth` with both numbers (or
`unknown` when the page does not return two numbers), and the counts of console errors and page
errors. It holds no text from the page, because the page can
be a hostile branch and its text would reach your terminal and the transcript. Nothing the helper
prints comes from the page either: the checks that wait for the page return one integer, and the
helper treats anything else as not settled. A hostile page can still make those numbers lie, as it
can change what it paints, so the PNG is the evidence. Open it: the width line sees only page-level
overflow, not content that paints outside its frame inside the page, and the PNG is the 390x844
viewport, not the whole page. The helper still redacts the token and replaces control characters
in everything it writes, as a second layer.

- The browser starts at `<path>`. It shows what a URL and the server's state give: a transcript
  that `agent-browser` steps built (the history is on the server), a route, a saved setting. A
  state that only clicks reach (an open dialog) cannot be captured this way: report that and say
  what you checked instead.
- It uses the repo's locked `playwright-core`. WebKit needs GTK and GStreamer libraries that many
  hosts lack. On `auto` (the default of `VERIFY_XUM_WEBKIT`, which can also be `host` or
  `docker`) it runs on the host when WebKit launches there (`node_modules/.bin/playwright
  install webkit`, and `--with-deps` for the libraries). Otherwise it runs the same helper in
  `mcr.microsoft.com/playwright@sha256:2f05f8a7...` (Playwright 1.64.1, pinned by digest, pulled
  once). The image's browsers belong to that Playwright version: after a Playwright bump, set
  `WEBKIT_IMAGE` and `WEBKIT_IMAGE_PLAYWRIGHT_CORE` in `verify-xum.sh` (the recipe is in the
  comment above them). The test fails until the version constant moves, and Docker mode refuses
  while `node_modules` and the constant differ. When neither mode works, the command exits 1 and
  names both fixes.
- The token reaches the helper on stdin, as it reaches curl in `doctor`, so it is in no command
  line (see Threat model). It is in no environment either, and the helper's redaction runs over
  everything it writes, as `capture`'s does. The browser's profile lives in a temporary
  folder (the container's tmpfs, or the run's `tmp` folder, which cleanup deletes). The host
  helper runs under `env -i` with an allowlist. Playwright drives WebKit over a pipe, so this
  command adds no DevTools port or stream to the one that the Threat model names for
  agent-browser. Playwright opens a debugging port (`--remote-debugging-port=0`) only for its
  `webkit-wsl` channel, a Windows option that the helper does not select.
- CAUTION: in Docker mode `--network host` lets the container reach every loopback port of the
  host, the sandbox's backend and its token included. The container gets the token on stdin only,
  runs one file of this repo from the pinned image as your uid with no capabilities and a
  read-only root, and mounts only `node_modules` (read-only), that file (read-only) and the
  `<feature>` evidence folder of the step (the command refuses a name without a `<feature>/`).
  The command refuses a Docker endpoint that is not a local socket (the token would leave the
  host), refuses a control character or a byte that is not valid UTF-8 in that endpoint and in any
  path it hands to Docker (Docker can echo a path to your terminal), and runs the docker CLI with
  an empty private config (its `proxies` would otherwise go into the container's environment). The
  single-account CAUTION of the Threat model applies to this command too.
- Nothing outlives the command except the evidence: the container is removed when it exits and
  stops itself after 180 s at most, and the private Docker config sits in the run's `tmp` folder
  that cleanup deletes. Cleanup redacts the report like every other text file of the evidence.

Proof standards:

- Drive the path a user takes. No test-only routes, no state written behind the UI's back except
  the seed, and edits to the worktree that stand in for the user's own editor.
- Mock only at a production boundary. The mock AI stands in for the model provider. Do not stub
  Xum's own code, routes or stores to make a step pass.
- Name what the mock skips. It never calls a provider, and its tool calls are canned and leave
  the worktree alone. A mock run does not prove a change to provider requests or tool execution:
  report that part as not verified, or prove it at that boundary.
- Capture the action and the resulting state, not only the final screen.
- Check a UI change at phone width too. Run `agent-browser set viewport 375 812` and
  `verify-xum.sh idle`, repeat the changed recipe's steps and captures with names that end in
  `-375`, and look for clipped text, content past the right edge
  (`agent-browser eval 'document.documentElement.scrollWidth <= innerWidth'` prints `true`) and
  controls that cover each other. When the phone layout reaches a step's control another way, or
  does not show it, follow the phone layout's own path to it or capture that it is absent, and
  say which. Run `agent-browser set viewport 1280 720` afterwards. A change with no UI needs no
  phone pass: say so.
- For every UI change to layout, CSS, SVG or scrolling, add a WebKit capture
  (`verify-xum.sh webkit-capture`, above) of each page the change reaches, and read the
  `-webkit` PNG next to the `-375` one. Phone users run Safari, which is WebKit, and agent-browser
  is Chromium: a page that fits in the `-375` capture can still break in WebKit, as Mermaid
  diagrams did on an iPhone. Say which captures you could not make in WebKit, and why.
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
  the Review recipe). Vite's scan does not see the dependencies of the highlight worker
  (`@pierre/highlights`), and a request for that worker on a cache without them logs the same
  lines. Launch's module walk leaves workers out, so a cold cache still reloads at that request.
  Vite then invalidates every module it had transformed, so the page load after the reload is as
  slow as a cold one.
- Now and then Chrome fails every module request that is still queued (a dozen to over a hundred
  while the page loads) with `net::ERR_NETWORK_CHANGED`, because a network interface or address of
  the host changed. A Docker container that starts on a shared host adds one: `ip monitor link`
  shows its `veth` links at that instant. Vite is not at fault: curl gets the same module at once.
  What the page shows depends on the failed modules. A lazily loaded one shows
  `<name> failed to load.` with a `Reload` button, the console logs
  `Failed to fetch dynamically imported module`, and `verify-xum.sh idle` exits 3. A module of the
  first-load graph shows nothing: the page stays on `Loading Xum` and `idle` exits 1 after 25 s.
  `React.lazy` keeps a failure and the boot screen has no failure state, so only a reload
  recovers. Run `agent-browser reload`, then repeat the step, and note the reload in your report.
  Launch warms Vite, so a page load takes a few seconds and the window for such a change is
  short. Under heavy host load a warm load can still take 20 s.
- A page that stays on `Loading Xum` after `idle` timed out has lost a module request (see the
  previous item): run `agent-browser reload`. A slow transform is not the usual cause after a
  launch, because Vite has already transformed every module. Vite transforms a module again after a
  source edit, and every module again after a dependency re-optimization (the first item above).
  Then the page can stay on `Loading Xum` for as long as a cold load takes, which is longer than
  one `idle`: run `idle` again.
- agent-browser's headless Chromium matches `(hover: none)`, so Tailwind's `hover:` and
  `group-hover:` variants never apply. Controls that appear on hover (a sidebar row's archive
  icon) ignore clicks there. Focus them (`agent-browser focus '[aria-label="<name>"]'`) and press
  Enter, which is the keyboard user's path.
- `agent-browser` sessions are host-global. Use only the run's `AGENT_BROWSER_SESSION`.
- HOME is the real one, so git inside the app uses your global git config. Xum writes its own
  state only under the sandbox XUM_ROOT.
