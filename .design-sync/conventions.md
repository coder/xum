# Mux design system — how to build with it

These components are Mux's real, compiled React components (the desktop app's UI:
chat tool-call cards, message states, settings sections, banners, modals, small
widgets). Build with them as-is; style your own layout glue with Tailwind using
Mux's token vocabulary below.

## Wrapping & theme (required)

Every component must render inside **`ThemeProvider`** (a bundle export). It sets
`data-theme` and `color-scheme` on `<html>`, and the entire stylesheet keys off
`html[data-theme="dark"]` / `[data-theme="light"]`. Without it the app renders
unthemed (default browser colors). Default to dark:

```jsx
import { ThemeProvider } from "<this design system>";

<ThemeProvider forcedTheme="dark">{/* your screen */}</ThemeProvider>;
```

Data-driven components (anything that reads workspaces, settings, providers, etc.)
also expect Mux's context providers — `APIProvider`, `SettingsProvider`,
`PolicyProvider`, `ProjectProvider`, `RouterProvider` (all bundle exports). Wrap
once near the root; leaf/presentational components (banners, tool-call cards,
badges) need only `ThemeProvider`.

## Styling idiom — Tailwind v4 with Mux's semantic tokens

There are **no CSS-module class maps**; style layout with Tailwind utility classes
built from Mux's semantic color tokens (NOT raw hex). Real families (all in the
shipped stylesheet):

| Purpose     | Utilities                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------- |
| Surfaces    | `bg-background`, `bg-background-secondary`, `bg-surface-primary`, `bg-surface-secondary`     |
| Text        | `text-foreground`, `text-muted-foreground`, `text-content-primary`, `text-content-secondary` |
| Borders     | `border-border`                                                                              |
| Accent      | `bg-accent`, `text-accent`                                                                   |
| Agent modes | `text-plan-mode` / `bg-plan-mode` — same for `edit` / `exec` / `thinking` / `task`. `ask` & `debug` ship only as `--color-<mode>-mode` tokens (no utility): use `style={{ color: "var(--color-ask-mode)" }}` |
| Radius      | `rounded-md`                                                                                 |

For a token Tailwind doesn't expose as a utility, reference it directly:
`style={{ color: "var(--color-content-primary)" }}`. Token names live in the
shipped CSS under `@theme` and the `[data-theme]` blocks — read it before styling.

## Where the truth lives

- **Stylesheet**: the bound `styles.css` (it `@import`s `_ds_bundle.css`, which
  carries every component's compiled styles + the token definitions). Read it for
  the full token/utility vocabulary.
- **Per component**: its `.prompt.md` (usage + variants) and `.d.ts` (`<Name>Props`
  — the exact prop contract). Read these before composing a component.

## Idiomatic snippet

```jsx
import { ThemeProvider, RosettaBanner } from "<this design system>";

export function Example() {
  return (
    <ThemeProvider forcedTheme="dark">
      <div className="bg-background text-foreground min-h-screen p-6">
        <div className="mx-auto max-w-2xl rounded-md border border-border bg-surface-primary p-4">
          <h2 className="text-content-primary text-lg font-semibold">Settings</h2>
          <p className="text-muted-foreground mt-1">Compose Mux components here.</p>
          <RosettaBanner />
        </div>
      </div>
    </ThemeProvider>
  );
}
```
