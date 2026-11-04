# Xum verification map

One recipe per user-facing feature of the Xum web UI. Read this index, then drive the matching
feature file with the `verify-xum` harness. Update the file in the same change as the feature.

## Baseline preconditions

- `verify-xum.sh launch` started the run, and `verify-xum.sh doctor` prints only `ok` lines.
- The seed holds the trusted project `demo-app` (one commit on `main`: `README.md`, `src/math.ts`)
  and the workspace `Verify playground` (branch `verify-playground`, id `$VERIFY_XUM_WORKSPACE_ID`,
  worktree `$VERIFY_XUM_WORKTREE`) with an empty transcript.
- Onboarding is marked seen, tutorials are off, and a fake Anthropic provider is configured, so
  the composer sends. The mock AI answers every turn.

## Driving conventions

- Start each bash call with `eval "$(.xum/skills/verify-xum/scripts/verify-xum.sh env)"`. It also
  puts the helper on `PATH`, so the recipes call it as `verify-xum.sh`.
- Run each step's commands as one `&&` chain, or under `set -e`, so the first failed `wait` stops
  the step. Keys pressed after a failed wait go to whatever has focus. In one run a palette query
  went into the composer, and the Enter after it sent that text as a chat message.
- Start every recipe whose preconditions name `Verify playground` by opening it, even after
  another recipe: the workspaces and command-palette recipes end on `release-notes`, and the
  recipes read evidence from `$VERIFY_XUM_WORKSPACE_ID`. Open the app with
  `verify-xum.sh open "/workspace/$VERIFY_XUM_WORKSPACE_ID"` and run `verify-xum.sh idle`. A new
  browser session starts with the project collapsed, and the recipes choose workspace rows by
  name, so expand it when it is collapsed. This form fails only when the button is there and the
  click fails, so it is safe in an `&&` chain:

  ```bash
  { [[ $(agent-browser eval '!!document.querySelector("[aria-label=\"Expand project demo-app\"]")') != true ]] \
    || agent-browser find role button click --name "Expand project demo-app" --exact; }
  ```

- Open pages with `verify-xum.sh open <path>`. It adds the backend's auth token without putting
  it on any command line (SKILL.md Drive).
- Read a workspace's id, or another field of its `config.json` entry, with
  `verify-xum.sh workspace-field <name> <field>`, for example
  `RN_ID=$(verify-xum.sh workspace-field release-notes id)`. The app makes up ids at create time,
  and a shell variable is gone in the next bash call, so read it in each call that needs it.
- Send a message in three steps: fill `Message`, run `verify-xum.sh send-ready`, then press Enter
  or choose `Send message`.
- Use accessible names with `agent-browser find role <role> <action> --name "<name>" --exact`.
  Names are exact strings from the UI. `find text "<text>" click --exact` is the fallback for rows
  without a role.
- `find` does not wait. After a step that navigates or opens a view, the recipe waits for the next
  target first, with `agent-browser wait '[aria-label="<name>"]'` or
  `agent-browser wait --text "<text>"`. Keep those waits when you adapt a recipe.
- When a wait times out, run `verify-xum.sh idle`. Exit 3 means a module failed to load (SKILL.md
  Gotchas): run `agent-browser reload`, repeat the step, and note the reload with the evidence.
- Run recipes in the order of this index when you drive more than one. A recipe that changes a
  setting restores it at its end.
- Shortcuts are the Linux bindings that agent-browser presses. `src/browser/utils/ui/keybinds.ts`
  defines them, with their macOS variants.

## Proof and skip reporting

- Capture with `verify-xum.sh capture <feature>/<step>`. The feature part of the name is the file
  name below.
- Capture the state after each action that the recipe marks as proof, not only the last screen.
- Check the side effect the recipe names (`chat.jsonl`, `config.json`, git state, or the CLI)
  and save its output next to the captures, as `$VERIFY_XUM_EVIDENCE/<feature>/<step>.txt`. Run
  `mkdir -p "$VERIFY_XUM_EVIDENCE/<feature>"` first: only `capture` creates that folder.
- Report an entry point you could not drive with the command you ran and the unmet precondition.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph on the user-visible behavior. Then it
has exactly four H2 sections in this order:

1. `Sub-features` lists short IDs with one line each.
2. `How to get to it (user POV)` lists every entry point a user has.
3. `Driving it with agent-browser` starts with `Preconditions:` and pairs each user action with
   the exact command and the observable result.
4. `Gotchas` lists traps that waste or invalidate a run.

## Features

- [Workspaces](./workspaces.md) covers creating a workspace from the project composer, opening it
  from the sidebar, archiving and restoring it, and the CLI view of the list.
- [Chat](./chat.md) covers sending a message, the streamed reply, Stop, and the transcript after a
  reload.
- [Review](./review.md) covers the Review tab's diff of uncommitted worktree changes, marking a
  hunk as read, and the sidebar's keyboard toggle.
- [Command palette](./command-palette.md) covers opening the palette, switching workspaces, and
  running a command.
- [Settings](./settings.md) covers opening Settings, changing a preference, and its persistence.
