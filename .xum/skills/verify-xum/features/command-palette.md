# Command palette

The command palette is a search box over workspaces and commands. Without a prefix it lists
workspaces to switch to. With `>` it lists commands, such as `Change Model…` and `Open Settings`.

## Sub-features

- `palette-open` opens the palette with each shortcut and closes it with Escape.
- `palette-switch` switches to another workspace by typing part of its title.
- `palette-command` runs a command from `>` mode.

## How to get to it (user POV)

- Press Ctrl+Shift+P (`OPEN_COMMAND_PALETTE`) for workspace search.
- Press F4 (`OPEN_COMMAND_PALETTE_ACTIONS`) for command mode, which prefills `>`.

## Driving it with agent-browser

Preconditions:

- Baseline state plus a second workspace `release-notes` (create it with the
  [workspaces](./workspaces.md) recipe, or skip `palette-switch` and report it).
- The app is open on `Verify playground`, and `verify-xum.sh idle` returned.

- **Open and close.** Run `agent-browser press Control+Shift+P`,
  `agent-browser wait '[aria-label="Command palette"]'` and
  `agent-browser wait '[role="listbox"][aria-label="Suggestions"] [role="option"]'`: on the first
  open of a page the list fills a moment after the combobox shows. The combobox
  `Command palette` is expanded, with the listbox `Suggestions`. Run `agent-browser press Escape`
  and `agent-browser wait --fn '!document.querySelector("[aria-label=\"Command palette\"]")'`.
  The combobox is gone. The press can return before the palette closes, and the next shortcut
  would then close the palette that is still open instead of opening it.
- **Switch workspace.** Press Ctrl+Shift+P, wait for the palette as above, then run
  `agent-browser keyboard type "release"` and
  `agent-browser wait '[role="option"][aria-selected="true"][aria-label="release-notes"]'`.
  `Suggestions` lists the option `release-notes`, selected. Run `agent-browser press Enter` and
  `agent-browser wait --url "**/workspace/$(verify-xum.sh workspace-field release-notes id)"`:
  the palette closes first and navigates a moment later. The URL is the `release-notes`
  workspace's. Capture `command-palette/switched`.
- **Command mode.** Run `agent-browser press F4` and
  `agent-browser wait '[aria-label="Command palette"]'`. The combobox value is `>`, and
  `Suggestions` lists commands such as `Open Settings` and `Change Model…`.
- **Run a command.** Run `agent-browser keyboard type "Change Model"`,
  `agent-browser wait '[role="option"][aria-selected="true"][aria-label="Change Model…"]'`,
  `agent-browser press Enter` and `agent-browser wait --text "Show all models…"`. The model picker
  opens with the textbox `Search [provider:model-name]`. Run
  `agent-browser find text "Sonnet 5.5" click --exact`. The composer's combobox reads
  `Model: Sonnet 5.5`. Capture `command-palette/model`.

## Gotchas

- Wait for the option you want to be selected before you press Enter. The first palette open after
  a page load shows a plain input while the palette's code loads (`LoadingPaletteInput` at
  `src/browser/components/CommandPalette/LazyCommandPalette.tsx:38`), with the same label
  `Command palette`. A snapshot shows it as `textbox "Command palette"` until the code loads, then
  as `combobox "Command palette"`. agent-browser types and presses Enter in a few milliseconds, before the code
  arrives. Since #7897 that input keeps the Enter and runs it on the first option once the code
  loads. Before it, the Enter was lost. The wait proves that the option Enter runs is the one the
  recipe expects.
- Type into the palette with `agent-browser keyboard type`. The combobox has focus as soon as it
  opens.
- Workspace options show the title only. A leading `•` marks the open workspace.
- The model pick stays in memory until a send (see [chat](./chat.md) Gotchas). Do not reload
  between `Change Model…` and the check.
