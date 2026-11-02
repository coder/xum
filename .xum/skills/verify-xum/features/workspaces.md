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
  `agent-browser wait --text "Mock response: Draft the release notes"`. The URL changes to
  `/workspace/<new id>`, and the sidebar has a `Select workspace release-notes` row. Capture
  `workspaces/created`.
- **Check the worktree.** Run `git -C "$VERIFY_XUM_PROJECT" worktree list`. It lists
  `$VERIFY_XUM_ROOT/src/demo-app/release-notes` on branch `release-notes`.
- **Keyboard create.** Press Ctrl+N. Run `agent-browser press Control+n` and
  `agent-browser wait '[aria-label="Workspace name"]'`. The URL changes to
  `/project?project=demo-app-<hash>&draft=<id>`. Create `scratch-notes` the same way as above,
  with the message `Collect scratch notes`.
- **Open from the sidebar.** Run
  `agent-browser find role button click --name "Select workspace release-notes" --exact`. The URL
  is `/workspace/<release-notes id>`. Run
  `agent-browser find role button click --name "Select workspace Verify playground" --exact`. The
  URL is `/workspace/$VERIFY_XUM_WORKSPACE_ID`.
- **Archive from the row.** Focus the row's archive icon and press Enter. Run
  `agent-browser wait '[aria-label="Archive workspace release-notes"]'`,
  `agent-browser focus '[aria-label="Archive workspace release-notes"]'` and
  `agent-browser press Enter`. The `Select workspace release-notes` row disappears, and in
  `$VERIFY_XUM_ROOT/config.json` the `release-notes` entry gets an `archivedAt` time. Capture
  `workspaces/archived`.
- **Archive with the keyboard.** Open `scratch-notes` from its row, run `verify-xum.sh idle`, and
  press Ctrl+Shift+Backspace. Run `agent-browser press Control+Shift+Backspace`. The
  `Select workspace scratch-notes` row disappears, and its `config.json` entry gets an
  `archivedAt` time.
- **Restore.** Open the project page and the archived list. Run
  `agent-browser find role button click --name "Create workspace in demo-app" --exact`,
  `agent-browser wait '[aria-label="Expand archived workspaces"]'`,
  `agent-browser find role button click --name "Expand archived workspaces" --exact` and
  `agent-browser wait '[aria-label="Restore workspace release-notes"]'`. The region
  `Archived workspaces` lists `release-notes` and `scratch-notes`. Run
  `agent-browser find role button click --name "Restore workspace release-notes" --exact`. The
  app opens `/workspace/<release-notes id>`, the sidebar row is back, and `config.json` gets an
  `unarchivedAt` time for it. Capture `workspaces/restored`.
- **CLI view.** List the workspaces through the CLI:

  ```bash
  env -u XUM_SERVER_URL -u XUM_SERVER_AUTH_TOKEN XUM_ROOT="$VERIFY_XUM_ROOT" \
    node "$VERIFY_XUM_CHECKOUT/dist/cli/api.mjs" workspace list >"$VERIFY_XUM_EVIDENCE/workspaces/cli-list.txt"
  ```

  The file has the titles `Verify playground` and `release-notes`.

## Gotchas

- The project row's accessible name is `Create workspace in demo-app`, but choosing it opens the
  project page. It creates nothing.
- Right after a create, the next new-workspace composer keeps `Send message` disabled for a few
  seconds until its branch list has loaded and its draft is saved. `verify-xum.sh send-ready`
  waits for it.
- With `Workspace name` empty, Xum names the workspace with random words (`curvy-mangos-pull`).
  Fill the name so rows and branches have known names.
- In agent-browser's Chromium, `document.hasFocus()` is false, so a reply that finishes while you
  watch does not mark the workspace read. When you leave it, its row shows an unread status dot,
  and that dot takes the archive icon's place. Open the workspace once more, as the recipe does,
  before you archive it from its row.
- A click on the archive icon selects the row instead in agent-browser's Chromium. The icon takes
  clicks only on row hover, and that browser matches `(hover: none)`, so Tailwind's `group-hover`
  never applies (see SKILL.md Gotchas). Focus the icon, as above.
