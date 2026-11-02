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

- Start each bash call with `eval "$(.xum/skills/verify-xum/scripts/verify-xum.sh env)"`. The
  recipes write the helper as `verify-xum.sh`.
- Open the app with `agent-browser open "$VERIFY_XUM_URL/workspace/$VERIFY_XUM_WORKSPACE_ID"`,
  run `verify-xum.sh idle`, and expand the project in the sidebar with
  `agent-browser find role button click --name "Expand project demo-app" --exact`. A new browser
  session starts with the project collapsed, and the recipes choose workspace rows by name. The
  expand command fails when the project is already expanded. That failure is harmless.
- Send a message in three steps: fill `Message`, run `verify-xum.sh send-ready`, then press Enter
  or choose `Send message`.
- Use accessible names with `agent-browser find role <role> <action> --name "<name>" --exact`.
  Names are exact strings from the UI. `find text "<text>" click --exact` is the fallback for rows
  without a role.
- `find` does not wait. After a step that navigates or opens a view, the recipe waits for the next
  target first, with `agent-browser wait '[aria-label="<name>"]'` or
  `agent-browser wait --text "<text>"`. Keep those waits when you adapt a recipe.
- Run recipes in the order of this index when you drive more than one. A recipe that changes a
  setting restores it at its end.
- Shortcuts are the Linux bindings that agent-browser presses. `src/browser/utils/ui/keybinds.ts`
  defines them, with their macOS variants.

## Proof and skip reporting

- Capture with `verify-xum.sh capture <feature>/<step>`. The feature part of the name is the file
  name below.
- Capture the state after each action that the recipe marks as proof, not only the last screen.
- Check the side effect the recipe names (`chat.jsonl`, `config.json`, git state, or the CLI)
  and save its output next to the captures, as `$VERIFY_XUM_EVIDENCE/<feature>/<step>.txt`.
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
