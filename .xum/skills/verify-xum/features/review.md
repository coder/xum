# Review

The Review tab in the right sidebar shows the workspace's diff against its base branch, one hunk
per change. The user includes uncommitted edits, reads the diff, and marks a hunk as read. The tab
label counts read hunks against all hunks.

## Sub-features

- `review-open` opens the Review tab from the right sidebar.
- `review-uncommitted` shows uncommitted worktree edits once `Uncommitted:` is checked.
- `review-read` marks a hunk as read and updates the `Review <read>/<total>` count.
- `review-toggle` hides and shows the right sidebar with the keyboard and keeps the open tab.

## How to get to it (user POV)

- Choose `Expand right sidebar`, then choose `Review` under `Open a tool`.
- Press Ctrl+Shift+B to collapse the right sidebar and to open it again on its last tab.

## Driving it with agent-browser

Preconditions:

- Baseline state. The worktree `$VERIFY_XUM_WORKTREE` has no changes.
- The app is open on `Verify playground`, the right sidebar is collapsed with no tab open, and
  `Uncommitted:` is unchecked (`userPreferences.review.includeUncommitted` is not `true` in
  `config.json`). The recipe's Restore step leaves this state.

- **Edit a file.** Change the worktree the way an editor would:

  ```bash
  printf 'export function sub(a: number, b: number): number {\n  return a - b;\n}\n' >>"$VERIFY_XUM_WORKTREE/src/math.ts"
  ```

  `git -C "$VERIFY_XUM_WORKTREE" status --short` prints ` M src/math.ts`.

- **Open the sidebar.** Run
  `agent-browser find role button click --name "Expand right sidebar" --exact`,
  `agent-browser wait --text "Open a tool"` and `verify-xum.sh idle`. The heading `Open a tool`
  lists a `Review` button.
- **Open Review.** Run `agent-browser find role button click --name "Review" --exact` and
  `agent-browser wait --text "Uncommitted:"`. The tab `Review Close Review` is selected, and the
  panel reads `No changes found` with `Uncommitted:` unchecked. If the page reloads here instead
  (a cold Vite cache, see Gotchas), the sidebar and the Review tab stay open. Run
  `verify-xum.sh idle` and `agent-browser wait --text "Uncommitted:"`, then continue at
  **Include uncommitted edits**.
- **Include uncommitted edits.** Run
  `agent-browser find role checkbox check --name "Uncommitted:" --exact` and
  `agent-browser wait --text "math.ts"`. The file tree lists `src` and `math.ts` with `+3`, the
  hunk shows the three added lines of `sub`, and the tab reads `Review 0/1`. Capture
  `review/diff`.
- **Mark as read.** Run `verify-xum.sh idle` and
  `agent-browser wait '[aria-label="Mark as read (M)"]'` (after a reload the hunk's button shows
  late), then `agent-browser find role button click --name "Mark as read (M)" --exact`. The tab
  reads `Review 1/1`, and the hunk reads `Hunk marked as read`.
  The app writes `review-state.json` a moment later. Wait for it:

  ```bash
  timeout 10 sh -c 'until grep -qsF "\"isRead\": true" "$1"; do sleep 0.2; done' sh "$VERIFY_XUM_ROOT/sessions/$VERIFY_XUM_WORKSPACE_ID/review-state.json"
  ```

  `$VERIFY_XUM_ROOT/sessions/$VERIFY_XUM_WORKSPACE_ID/review-state.json` has `"isRead": true` for
  that hunk. Capture `review/read`.

- **Keyboard toggle.** Run `agent-browser press Control+Shift+B` and
  `agent-browser wait '[aria-label="Expand right sidebar"]'`. The sidebar collapses, and the
  button `Expand right sidebar` is back. Run `agent-browser press Control+Shift+B` again and
  `agent-browser wait '[aria-label="Collapse right sidebar"]'`. The button reads
  `Collapse right sidebar`, and the tab `Review 1/1 Close Review` is selected.
- **Restore.** The sidebar slid open again: run `verify-xum.sh idle`, then
  `agent-browser find role button click --name "Mark as read (M)" --exact`. The tab reads
  `Review 0/1` at once, and the app writes `review-state.json` a moment later. Wait for
  it:

  ```bash
  timeout 10 sh -c 'while grep -qF "\"isRead\": true" "$1"; do sleep 0.2; done' sh "$VERIFY_XUM_ROOT/sessions/$VERIFY_XUM_WORKSPACE_ID/review-state.json"
  ```

  `review-state.json` has no `"isRead": true`. Run
  `agent-browser find role checkbox click --name "Uncommitted:" --exact`. The box is
  `checked=false` at once. Wait until the server has written it:

  ```bash
  timeout 10 sh -c 'until grep -qF "\"includeUncommitted\": false" "$1"; do sleep 0.2; done' sh "$VERIFY_XUM_ROOT/config.json"
  ```

  `config.json` has `"includeUncommitted": false` under `userPreferences.review`. Run `git -C "$VERIFY_XUM_WORKTREE" checkout -- src/math.ts`,
  `agent-browser find role button click --name "Close Review" --exact` and
  `agent-browser wait '[aria-label="Expand right sidebar"]'`. Closing the last tab collapses the
  sidebar.

## Gotchas

- `find role ... --name` matches substrings without `--exact`. The hunk itself is a button whose
  name starts with `Mark as read (M)`, so the call without `--exact` selects the hunk and marks
  nothing.
- On a cold Vite cache the first open of Review reloads the page (see SKILL.md Gotchas). The
  sidebar and the Review tab stay open after the reload, so the recipe goes on from the open tab.
- A click on `Review` while the sidebar still slides open is lost. Keep the `idle` call before it.
- Skip a Restore step and a rerun in the same run fails. A hunk's id comes from its content, so
  the same edit comes back already read. With `Uncommitted:` already checked, the panel did not
  show a new edit within 25 s, until `Refresh diff`. With the Review tab open,
  `Expand right sidebar` opens that tab instead of `Open a tool`.
- `find` has no `uncheck` action. `find role checkbox click` toggles the box.
