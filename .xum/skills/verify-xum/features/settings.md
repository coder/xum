# Settings

Settings is a dialog over the app with one section per area (General, Providers, Models, and
more). Each section has its own route under `/settings/`. A change applies at once and persists in
the server's `config.json`.

## Sub-features

- `settings-open` opens the dialog from the sidebar button, its shortcut, the palette, and its route.
- `settings-toggle` changes the `Flat chat list` switch and shows its effect on the sidebar.
- `settings-persist` keeps the change across a reload and in `config.json`.

## How to get to it (user POV)

- Choose `Open settings` (the gear in the sidebar header).
- Press Ctrl+, (`OPEN_SETTINGS`).
- Press F4, type `Open Settings`, and press Enter.
- Open `$VERIFY_XUM_URL/settings/general`.

## Driving it with agent-browser

Preconditions:

- Baseline state. `Flat chat list` is off.
- The app is open on `Verify playground`.

- **Open from the button.** Run
  `agent-browser find role button click --name "Open settings" --exact` and
  `agent-browser wait --text "Choose your preferred theme"`. The URL is `/settings/general`, and a
  full `snapshot` shows the dialog `Settings` with the section buttons `General`, `Providers` and
  `Models`. Run `agent-browser press Escape` and
  `agent-browser wait --fn '!document.querySelector("[data-modal-dialog-overlay][data-state=open], [role=dialog][aria-modal=true]")'`.
  The URL is back on the workspace.
- **Open with the keyboard.** Run `agent-browser press Control+,` and
  `agent-browser wait --text "Choose your preferred theme"`. The URL is `/settings/general`. Close
  it with Escape and the same wait as above.
- **Open from the palette.** Run `agent-browser press F4`,
  `agent-browser wait '[aria-label="Command palette"]'`,
  `agent-browser keyboard type "Open Settings"`,
  `agent-browser wait '[role="option"][aria-selected="true"][aria-label="Open Settings"]'`,
  `agent-browser press Enter` and `agent-browser wait --text "Choose your preferred theme"`. The
  URL is `/settings/general`.
- **Change a setting.** Run
  `agent-browser find role switch click --name "Toggle flat chat list" --exact`. The switch is
  `checked=true` at once, but the server writes `config.json` a moment later. Wait for the write
  before you capture or reload:

  ```bash
  timeout 10 sh -c 'until grep -qF "\"sidebarFlatMode\": true" "$1"; do sleep 0.2; done' sh "$VERIFY_XUM_ROOT/config.json"
  ```

  `$VERIFY_XUM_ROOT/config.json` has `"sidebarFlatMode": true` under `userPreferences.ui`. Capture
  `settings/flat-on`.

- **See the effect.** Run `agent-browser press Escape` and `agent-browser wait --text "RECENT"`.
  The sidebar has a `RECENT` group, and the workspace row is
  `Select workspace Verify playground (demo-app)`.
- **Reload.** Run `agent-browser reload`,
  `verify-xum.sh open /settings/general` and
  `agent-browser wait --text "Choose your preferred theme"`. The switch `Toggle flat chat list` is
  still `checked=true`. Capture `settings/persisted`.
- **Restore.** Run
  `agent-browser find role switch click --name "Toggle flat chat list" --exact`, wait until
  `config.json` has `"sidebarFlatMode": false` (the same `timeout 10` loop with `false`), and run
  `agent-browser press Escape`. The page opened
  Settings by its URL, so Escape lands on `/project?...`. Run
  `verify-xum.sh open "/workspace/$VERIFY_XUM_WORKSPACE_ID"` and
  `verify-xum.sh idle` to be back on `Verify playground`.

## Gotchas

- The palette shortcuts do nothing while a modal dialog is open, and the Settings dialog stays in
  the page for a moment after Escape (`isDialogOpen()` at `src/browser/utils/ui/keybinds.ts:291`,
  checked by the shortcut handler at `src/browser/App.tsx:1133`). The wait after Escape uses the same
  selectors. Without it, F4 is lost and the typed text goes to the composer.
- The palette steps wait for the selected option before Enter. See
  [command-palette](./command-palette.md) Gotchas.
- `snapshot -i` lists only the dialog's buttons and switches. Use a full `snapshot` to read the
  section text.
- Flat mode renames sidebar rows to `Select workspace <title> (<project>)`. Restore it before you
  drive another recipe.
- Read where a control saves before you name its side effect. `Flat chat list` calls
  `updateUserPreferences` (`src/browser/features/Settings/Sections/GeneralSection.tsx`), and other
  controls there call other routes.
