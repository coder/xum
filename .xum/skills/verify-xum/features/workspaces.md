# Workspaces

A workspace is one chat with its own git worktree and branch of a project. The user creates one
from the project composer by naming it and sending a first message, opens it from the sidebar,
archives it to hide it, and restores it from the project's archived list.

## Sub-features

- `ws-create` creates a named workspace, its worktree and branch, and sends the first message.
- `ws-open` opens a workspace from its sidebar row.
- `ws-archive` hides a workspace from the sidebar and records the archive time.
- `ws-restore` brings an archived workspace back from the project page.
- `ws-cli` lists the same workspaces through `xum api workspace list`.

## How to get to it (user POV)

- Choose `New chat in demo-app` on the project's sidebar row, or press Ctrl+N.
- Choose a `Select workspace <title>` row in the sidebar.
- Hover a sidebar row and choose its `Archive workspace <title>` icon, or tab to the icon and
  press Enter, or press Ctrl+Shift+Backspace in the open workspace.
- Choose the project row (`Create workspace in demo-app`), then `Expand archived workspaces` and
  `Restore workspace <title>`.
- Run `xum api workspace list` against the server.

## Driving it with agent-browser

Preconditions:

- Baseline state. No workspace is named `release-notes` or `scratch-notes`.
- The app is open on `Verify playground` with the project expanded (see the
  [driving conventions](./README.md#driving-conventions)), and `verify-xum.sh idle` returned.

- **Open the composer.** Choose `New chat in demo-app`. Run
  `agent-browser find role button click --name "New chat in demo-app" --exact` and
  `agent-browser wait '[aria-label="Workspace name"]'`. The URL is
  `$VERIFY_XUM_URL/project?project=demo-app-<hash>&draft=<id>`, and the page has the textboxes
  `Workspace name` and `Message`.
- **Create.** Name the workspace and send. Run
  `agent-browser find role textbox fill "release-notes" --name "Workspace name" --exact`,
  `agent-browser find role textbox fill "Draft the release notes" --name "Message" --exact`,
  `verify-xum.sh send-ready`,
  `agent-browser find role button click --name "Send message" --exact` and
  `agent-browser wait --text "Mock response: Draft the release notes"` and `verify-xum.sh idle`.
  The URL changes to `/workspace/<new id>`, and the sidebar has a `Select workspace release-notes`
  row. Capture `workspaces/created`.
- **Check the worktree.** Run `git -C "$VERIFY_XUM_PROJECT" worktree list`. It lists
  `$VERIFY_XUM_ROOT/src/demo-app/release-notes` on branch `release-notes`.
- **Keyboard create.** Press Ctrl+N. Run `agent-browser press Control+n` and
  `agent-browser wait '[aria-label="Workspace name"]'`. The URL changes to
  `/project?project=demo-app-<hash>&draft=<id>`. Create `scratch-notes` the same way as above,
  with the message `Collect scratch notes`, and run `verify-xum.sh idle` after its reply.
- **Open from the sidebar.** The app made up the workspace id at create time. Read it from
  `config.json` in each bash call that needs it:
  `RN_ID=$(verify-xum.sh workspace-field release-notes id)`. Run
  `agent-browser find role button click --name "Select workspace release-notes" --exact` and
  `agent-browser wait --url "**/workspace/$RN_ID"`. The URL is `/workspace/$RN_ID`. Run
  `agent-browser find role button click --name "Select workspace Verify playground" --exact` and
  `agent-browser wait --url "**/workspace/$VERIFY_XUM_WORKSPACE_ID"`. The URL is
  `/workspace/$VERIFY_XUM_WORKSPACE_ID`.
- **Archive from the row.** Focus the row's archive icon and press Enter. Run
  `agent-browser wait '[aria-label="Archive workspace release-notes"]'`,
  `agent-browser focus '[aria-label="Archive workspace release-notes"]'` and
  `agent-browser press Enter`. The archive request is still running when Enter returns. Wait for
  its result with
  `agent-browser wait --fn '!document.querySelector("[aria-label=\"Select workspace release-notes\"]")'`.
  The `Select workspace release-notes` row is gone. Wait until the server has written the
  archive:

  ```bash
  timeout 10 sh -c 'until [ -n "$(verify-xum.sh workspace-field release-notes archivedAt)" ]; do sleep 0.2; done'
  ```

  In `$VERIFY_XUM_ROOT/config.json` the `release-notes` entry has an `archivedAt` time. Capture
  `workspaces/archived`.

- **Archive with the keyboard.** Open `scratch-notes` from its row and wait until the app is on
  it: the shortcut archives whichever workspace is open. Run
  `agent-browser find role button click --name "Select workspace scratch-notes" --exact`,
  `agent-browser wait --url "**/workspace/$(verify-xum.sh workspace-field scratch-notes id)"` and
  `verify-xum.sh idle`. Then press Ctrl+Shift+Backspace. Run
  `agent-browser press Control+Shift+Backspace` and wait for the archive with
  `agent-browser wait --fn '!document.querySelector("[aria-label=\"Select workspace scratch-notes\"]")'`.
  The `Select workspace scratch-notes` row is gone. Wait for its `archivedAt` time with the same
  `timeout 10` loop for `scratch-notes`.
- **Restore.** Open the project page and the archived list. Run
  `agent-browser find role button click --name "Create workspace in demo-app" --exact`,
  `agent-browser wait '[aria-label="Expand archived workspaces"]'`,
  `agent-browser find role button click --name "Expand archived workspaces" --exact` and
  `agent-browser wait '[aria-label="Restore workspace release-notes"]'`. The region
  `Archived workspaces` lists `release-notes` and `scratch-notes`. Run
  `agent-browser find role button click --name "Restore workspace release-notes" --exact`, then
  wait for the result in the same bash call with
  `agent-browser wait --url "**/workspace/$(verify-xum.sh workspace-field release-notes id)"` and
  `agent-browser wait '[aria-label="Select workspace release-notes"]'`. The app is on the
  `release-notes` workspace URL, the sidebar row is back, and `config.json` has an
  `unarchivedAt` time for it. Capture `workspaces/restored`.
- **CLI view.** List the workspaces through the CLI:

  ```bash
  mkdir -p "$VERIFY_XUM_EVIDENCE/workspaces"
  verify-xum.sh cli workspace list >"$VERIFY_XUM_EVIDENCE/workspaces/cli-list.txt"
  ```

  The file has the titles `Verify playground` and `release-notes`.

## Gotchas

- The reply text shows before its stream ends. Run `verify-xum.sh idle` after it. Archiving a
  workspace that still streams opens the dialog `Archive "<title>" while streaming?`, and the
  row stays.
- The project row's accessible name is `Create workspace in demo-app`, but choosing it opens the
  project page. It creates nothing.
- Right after a create, the next new-workspace composer keeps `Send message` disabled for a few
  seconds until its branch list has loaded and its draft is saved. `verify-xum.sh send-ready`
  waits for it.
- With `Workspace name` empty, Xum names the workspace with random words (`curvy-mangos-pull`).
  Fill the name so rows and branches have known names.
- Xum marks a reply read only while `document.hasFocus()` is true (`src/browser/App.tsx:1386`).
  An earlier run saw it false in agent-browser's Chromium: a reply that finished while the
  workspace was open left an unread status dot on its row, and the dot took the archive icon's
  place. On agent-browser 0.33.2 (2026-11-03) `agent-browser eval 'document.hasFocus()'` printed
  `true`, and a workspace watched until its reply kept its archive icon. If it prints `false`,
  open the workspace once more before you archive it from its row, as the recipe does.
- A click on the archive icon selects the row instead in agent-browser's Chromium. The icon takes
  clicks only on row hover, and that browser matches `(hover: none)`, so Tailwind's `group-hover`
  never applies (see SKILL.md Gotchas). Focus the icon, as above.
