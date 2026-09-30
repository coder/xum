# design-sync notes — Mux

Mux is an **Electron + React app**, not a component-library package: there is no
`dist/` and no shipped `.d.ts` tree. The sync treats `src/browser`'s **storied**
components as the design system. Storybook is `@storybook/react-vite`; stories
live under `src/browser/{stories,components,features}/**`.

## How the bundle entry works

There is no library entry, so we generate one:

- **`.design-sync/gen-barrel.mjs`** reads `.design-sync/sb-reference/index.json`
  (authoritative titles) and emits **`.design-sync/ds-barrel.ts`** — one export
  per storied component under its **real export name** (NOT aliased). The
  converter would name a component after its story title's last segment, so
  `cfg.titleMap` maps each segment → the real name (e.g.
  `"Bash": "BashToolCall"`); the generator emits that map to
  `.cache/titlemap.json` to merge into config. It resolves each component by
  scoring `[storyFileBase, component: meta, titleSeg]` against the story's
  imports, falling back to convention files (sibling, flat parent for
  `features/Tools/*ToolCall.tsx`). Run it from the repo root after stories
  change: `node .design-sync/gen-barrel.mjs`, then rebuild.
- `cfg.entry` AND `cfg.extraEntries` both point at the barrel: `entry` builds
  `window.Mux`; `extraEntries` is **source-scanned to seed the converter's
  `exported` set** (there is no `.d.ts` to derive it from, so without this every
  storybook title drops as `[TITLE_UNMAPPED]`).
- The barrel also exports the providers the preview harness needs
  (PROVIDER_LINES: Theme, Tooltip, API, Policy, Experiments, Settings, Router,
  Project, AboutDialog) so they live on `window.Mux` and previews can shim to
  them. `cfg.provider` references `window.Mux.ThemeProvider`.

(See "Preview model — ISOLATED previews" below for how previews resolve against
`window.Mux`.)

## Theme / provider

The `.storybook/preview.tsx` decorator can't be auto-bundled — `globals.css`
does `@import "tailwindcss"` (a build-time PostCSS entry esbuild can't resolve),
so the decorator bundle fails. We replace it with
`cfg.provider = { component: "ThemeProvider", props: { forcedTheme: "dark" } }`.
`ThemeProvider` sets `data-theme`/`color-scheme` on `<html>` (ThemeContext.tsx
:112), which is what actually themes the CSS. The real compiled Tailwind CSS
(incl. theme tokens + katex) ships via the `[CSS_FROM_STORYBOOK]` fallback
scraped from `sb-reference` — NOT from the IIFE bundle's own CSS.

> Re-sync watch: the decorator also seeds localStorage defaults (collapse
> sidebars, disable tutorials, clear drafts). `cfg.provider` does NOT replicate
> that, so sidebar/tutorial-sensitive stories may differ from Storybook — verify
> in the compare loop; widen `cfg.provider` to a custom setup wrapper if needed.

## IIFE-incompatible deps stubbed (`.design-sync/tsconfig.ds.json`)

`cfg.tsconfig` points at `.design-sync/tsconfig.ds.json` (extends the repo
tsconfig, `baseUrl: ".."`). It stubs two deps the IIFE bundle can't take:

- `@novnc/novnc/lib/rfb` → `.design-sync/stubs/novnc-rfb.ts` (no-op RFB class).
  The real VNC client uses **top-level await** (illegal in IIFE) and needs a
  live server. Reached via `RightSidebar → tabRegistry → DesktopPanel →
useDesktopConnection`.
- `katex/dist/katex.min.css` → `.design-sync/stubs/empty.css`. The bundle has no
  `.ttf` loader; real katex styling arrives via the sb-reference CSS fallback.

> **Do NOT add `@/*`/`@shared/*` to `tsconfig.ds.json`'s `paths`.** The
> converter's `tsconfigPathsPlugin` (bundle.mjs) probes the bare path before
> `/index`, so directory imports like `@/common/utils/errors` resolve to the
> _directory_ and esbuild errors "is a directory". Leaving `@/` out lets
> esbuild's native tsconfig discovery resolve it (directory→index correctly).
> The converter's plugin is then scoped to just the two stubs.
> Also: `tsconfig.ds.json` must contain **no JSON comments or `"//"` keys** — the
> plugin's comment-stripper mangles `//` and silently nulls the whole plugin.

## Preview model — ISOLATED previews (not compiled stories)

Mux's Storybook is integration-style: `src/browser/stories/meta.tsx` imports
`AppLoader` (the whole app), and **62/73 stories** render the full app via
`AppWithMocks`. Compiling those stories as previews produces ~17 MB blobs (the
whole app graph) — over the 5 MB cap. So previews are **authored by hand**, one
per component, in `.design-sync/previews/<RealName>.tsx`:

- Each renders the component DIRECTLY with inline mock props, inside
  `MuxPreviewShell` (`.design-sync/preview-harness.tsx`) — a lightweight provider
  chain (theme, API+mock client, experiments, policy, router, project, settings,
  about-dialog, tooltip) WITHOUT the app shell. No heavy renderers.
- **`MuxPreviewShell` injects a `height:auto` reset** for `html,body,#root,
  #storybook-root`. globals.css pins those to `100vh;min-height:100vh` (so the
  Electron app fills its window); inside the gallery's auto-sizing iframe that
  clamps `documentElement.scrollHeight` to the iframe's short initial height, so
  cards never grow and the component (below its variant label) is **clipped on
  the main page** — only the full-height Edit view shows it. Keep the reset in
  the shell; do NOT remove it. (No-op for modals: fixed content floors scrollH at
  the viewport.)
- `cfg.storyImports.shim: ["/src/browser/"]` routes component/provider imports to
  `window.Mux` (the prebuilt bundle) so previews stay thin (~3.3 MB) and share
  React-context identity; `cfg.storyImports.bundle: ["/src/browser/stories/"]`
  keeps the mock client compiling from source (it's data).
- Components export REAL names (no alias); `cfg.titleMap` maps title segments →
  real names. So `import { TodoToolCall }` resolves to `window.Mux.TodoToolCall`.
- Validate each preview with the scratch `check-preview.mjs` (compiles + <5 MB +
  no heavy deps) before building. Re-authoring after story changes is manual.

## Curation — fitting the 5 MB upload cap (IMPORTANT)

Claude Design **rejects any file >5 MB** (`[FILE_OVER_5MB]`, hard). Mux's full
68-component bundle is **28 MB** and many previews are >5 MB, because the
storied components are app-level features pulling huge graphs (shiki ~10 MB,
mermaid+cytoscape ~3 MB, recharts, ghostty, the whole app via `<AppWithMocks>`).
`bundle.mjs` can't be forked and the heavy deps are imported by _name_, so the
novnc/katex stub trick doesn't generalize.

Per the user's "curate the largest fitting set" decision, the barrel excludes
**48 of 73** titles (`gen-barrel.mjs` EXCLUDE\_\* lists, mirrored as `titleMap`
nulls). **25 components** remain — bundle **~4.7 MB**, every preview ~3.3 MB,
all render cleanly (25/25 render check).

- **EXCLUDE_EMPTY (5):** BackgroundProcessesBanner, MemoryTab, ModelSelector,
  MultiProjectGitStatusIndicator, WorkspaceMCPModal — render BLANK in an isolated
  static preview because they read live store/async API data (model list, git
  status, memory, background processes, workspace MCP) that the harness can't
  populate synchronously. Two had per-preview store-wiring attempts that still
  rendered empty (async, not a quick fix). Deferred until the harness can drive
  those stores + await their loads.
- **EXCLUDE_HEAVY (23):** pull shiki/mermaid/recharts/d3/ghostty/lottie — verify
  with the scratch sizing scripts before re-including any.
- **EXCLUDE_OVERSIZED (15):** light deps but large source closures (sidebars,
  AgentListItem, Bash, the big settings sections) → previews >5 MB or bundle
  over cap.
- **EXCLUDE_APP_SCREEN (5):** full-app screens, no single component.

> Re-sync watch: if heavy deps shrink (e.g. shiki lazy-loaded) or components are
> refactored lighter, re-measure and consider re-including. Headroom is only
> ~0.5 MB, so adding components needs a fresh union measurement first.

To re-measure: the sizing scripts used were ad-hoc (component closure + union
size via esbuild metafile). Re-derive from `gen-barrel.mjs`'s export list if
needed; the cap is per-file 5 MB on both `_ds_bundle.js` and each `_preview/*.js`.

## Re-sync risks

- **Barrel staleness:** if stories are added/removed/retitled, **first build the
  reference Storybook** (it's gitignored, so absent on a fresh checkout):
  `npx storybook build -c .storybook -o .design-sync/sb-reference`, then re-run
  `node .design-sync/gen-barrel.mjs` (it errors with this exact prerequisite if
  the reference is missing) and rebuild — otherwise new components drop or stale
  ones 404. The barrel is committed; the generator is the source of truth.
- **UI primitives (Button/Input/Checkbox/Switch/Select/Dialog/Tooltip/Popover):**
  storied at `src/browser/components/<Name>/<Name>.stories.tsx` (title
  `Components/<Name>`) with owned previews in `previews/`. Gotchas baked into the
  tooling: (1) the chat composer (`App/Chat/Input` → ChatInput) shares the "Input"
  title segment, so `gen-barrel.mjs` excludes it by path (`EXCLUDE_IMPORT`) and
  `cfg.overrides.Input.skip` drops its 2 stories from the Input component — if
  ChatInput gains stories they resurface as `unpaired` under Input; add them to
  that skip. (2) Compound primitives export only their Root from the title-segment
  resolution; their parts (`DialogContent`/`TooltipContent`/`PopoverContent`/…)
  ride `window.Mux` via `gen-barrel.mjs`'s `PRIMITIVE_PART_LINES`. (3) Overlays
  (Dialog/Tooltip/Popover) use `cardMode: "single"`; previews render them
  `defaultOpen`. (4) Select's play-driven `Open` story is skipped (static preview
  can't reproduce the click).
- **`[DOCS_UNMAPPED]`:** Mux has no per-component markdown in `docs/`; components
  ship the floor doc. Non-fatal — not a regression.
- **novnc/katex stubs:** if Mux swaps these libs or the desktop/markdown wiring
  changes, revisit the `tsconfig.ds.json` stubs.
- **Per-file 5 MB cap** applies to BOTH `_ds_bundle.js` and each `_preview/*.js`.
  Bundle ~4.7 MB and previews ~3.3 MB leave thin headroom — adding components or
  providers needs a fresh size measurement. (HeartbeatToolCall added: bundle 4.69 MB,
  its preview 3.21 MB. WorkspaceLifecycleToolCall added: bundle **4.71 MB**, its preview
  3.22 MB — both still fit, headroom now **~0.29 MB**. Tool cards share deps
  (ToolPrimitives/toolUtils/lucide/the tool schema), so each new one adds only ~tens of KB
  to the bundle; a NON-tool-card component would need a fresh union measurement first.)
- **HeartbeatToolCall (tool card):** owned preview has one cell per story (10, named to
  match the story exports so `compare` pairs them — the stories import `meta.tsx` → the
  whole app, so the preview is hand-authored like the other cards). `cfg.overrides`
  uses `cardMode: "column"` because the `CustomMessageWrapping` story renders at a pinned
  375px (narrower than a grid cell → `[GRID_OVERFLOW] wide`); column keeps all stories
  full-width. All 10 stories grade `match`.
- **WorkspaceLifecycleToolCall (tool card, `task_workspace_lifecycle`):** owned preview, one
  cell per story (8, named to match exports so `compare` pairs them — stories import
  `meta.tsx` → whole app, so hand-authored like the other cards). `cfg.overrides` uses
  `cardMode: "column"` (the `BlockedNeedsAction` story renders at a pinned 375px →
  `[GRID_OVERFLOW] wide`, same as Heartbeat). **Capture cap raised to 8** (`compare
  --max-stories 8`) so the tail `ErrorResult` (ErrorBox layout) + `InvalidScope` (danger
  row) variants grade too — the default cap is 6 and would skip them. All 8 grade `match`.
  gen-barrel auto-resolves it (segment `WorkspaceLifecycle` → real name via story imports);
  no EXCLUDE entry needed.
- **Card viewport — KEEP THE DEFAULT 900x700; do NOT bump it for height.** Tall multi-story
  column cards (HeartbeatToolCall, WorkspaceLifecycleToolCall) and tall sections
  (KeybindsSection, GoalTab, GeneralSection) exceed 700px, but the gallery ALREADY handles this:
  per `emit.mjs` (~L475) the product "fits the card to its ≤728px column / 500px fold by scaling;
  content below the fold is **hover-scrollable**." So at the default viewport you scroll the card
  to see everything at normal zoom. Setting a tall `cfg.overrides.<Name>.viewport` (e.g. 900x2600)
  was tried and REVERTED — it makes the gallery scale the whole oversized card down to fit the
  column, so it renders tiny/zoomed-out and is harder to read than the scroll. A `viewport`
  override is for the capture/grading framing of overlays (`single` mode), not for showing tall
  cards in full. (Reverting the bump re-grades the card — render unchanged, re-confirms `match`.)
- **"Empty card on first appearance" is a stale gallery render, NOT a defect:** a brand-new
  card can show empty cells (labels only) in the gallery until the app recompiles its
  thumbnail — a hard-refresh / re-open of the project (which clears `_ds_needs_recompile` and
  re-renders) fixes it. Don't chase it as a sync bug if the card renders correctly standalone.
- **WorkflowRun/Timeouts exclusion:** `WorkflowRunToolCall` is EXCLUDE_HEAVY via its
  `WorkflowRun` segment, but `WorkflowRunToolCall.timeout.stories.tsx` titles to
  `…/WorkflowRun/Timeouts` (segment `Timeouts`), which slips that exclusion and would pull
  the heavy component (shiki/mermaid/recharts) into the bundle over cap. Fixed by adding
  `"Timeouts"` to `gen-barrel.mjs` EXCLUDE_HEAVY (a **segment** exclusion, not a path one, so
  the generated titleMap also nulls `Timeouts` and stays consistent with `cfg.titleMap "Timeouts": null`
  — a path exclusion would drift). If WorkflowRun stories are retitled again, re-check this.
- **`[FONT_MISSING]` "Ubuntu Mono":** pre-existing fallback in the `globals.css` monospace
  stack (`… "Geist Mono", "Ubuntu Mono", "Consolas" …`). Geist Mono ships and wins, so
  nothing renders in Ubuntu Mono — accepted (the unused fallback needs no @font-face).
- **Accepted `close` grades (6 stories — isolated-preview limits, NOT defects):**
  the isolated single-component preview legitimately diverges from a story that is
  a gallery, a full-app scenario, a play-expanded interaction, or a mid-stream
  capture; the component itself renders faithfully each time. Don't re-investigate
  on a churn re-grade — re-confirm only if that component or its story changes.
  - `GetGoalToolCall` (Get/Complete Goal Gallery): story is a multi-variant
    gallery; preview shows one representative variant.
  - `TodoToolCall` (Todo Write With Long Todos) & `DevToolsStepCard` (Narrow
    Expanded): story `play()`-clicks to expand; static preview shows the collapsed
    default (no `defaultExpanded` prop to set).
  - `InterruptedBarrier` (Context Exceeded Suggestion): presentation-only
    component; story drives the full app to a richer context-exceeded composition.
  - `TitleBar` (Mac OS Desktop): isolated preview has no workspace context, so the
    bar shows its version-string fallback vs the story's project/branch.
  - `CompactingMessageContent` (Streaming Compaction): story captured mid-stream
    (3 bullets) vs the preview's settled summary (5); same card.

## Accepted validator warnings (triaged — not regressions)

- **`[TOKENS_MISSING]` (9 vars, e.g. `--color-text-primary`, `--color-card`,
  `--radix-…`):** these are referenced via Tailwind arbitrary-value utilities but
  **never defined in Mux's own source CSS** (radix runtime vars + dangling/
  runtime-set tokens). Not introduced by the sync. All 25 previews render
  correctly (verified in `_screenshots/`), so accepted. If a future component
  visibly mis-colors, ship globals.css's `:root[data-theme]` blocks via cfg.
- **`[FONT_MISSING]` "Ubuntu Mono":** an unreached fallback in a `'Geist Mono',
'Ubuntu Mono', monospace` stack — Geist Mono ships and wins. Accepted.
