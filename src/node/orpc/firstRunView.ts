import { FIRST_RUN_VIEW_ID } from "@/common/constants/firstRunView";
import {
  AUTH_TOKEN_KEY,
  LEFT_SIDEBAR_COLLAPSED_KEY,
  ONBOARDING_VIEWED_KEY,
} from "@/common/constants/storage";
import {
  LEFT_SIDEBAR_COLLAPSED_WIDTH_PX,
  LEFT_SIDEBAR_DEFAULT_WIDTH_PX,
  NARROW_VIEWPORT_MAX_WIDTH_PX,
} from "@/constants/layout";
import { VERSION } from "@/version";

/**
 * The static first-run view (T3 #5971, Option C step 2, plan section 5.6): a copy of the onboarding
 * wizard's first step ("Choose your own AI providers"), the step a new server opens on. On `/`, the
 * server will put it in a <template> and an early script will show it before the app JS runs
 * (PR 4). Until then nothing serves it. The live wizard removes it once it shows the same step.
 *
 * Captured from the live page at 412 px (the overlay and the dialog: 163 elements), then edited:
 * - The app shell's <main> is a <div>. The boot loader's <main> in #root stays the only landmark.
 * - The shell's root is `h-full`: outside #root, which globals.css sizes to the viewport, its
 *   nested `h-full` would resolve against an auto height and collapse to the content height.
 * - Radix runtime artifacts are gone: focus guards, generated ids, aria-hidden, tabindex,
 *   pointer-events. The disabled attributes are gone too: the live buttons are enabled, and
 *   `disabled:opacity-50` made the copy look disabled.
 * - The root is `inert`, so no part of the copy takes focus or clicks before the handoff.
 * - The root is `fixed`, so it is a stacking context: its z-index is the live overlay's 1500
 *   (`z-[1500]`).
 * - The left sidebar and the shell header come from the live 1200 px first paint (owner decision
 *   10-14), with runtime attributes and Radix ScrollArea pieces gone. Both sidebar states are here:
 *   the <style> shows the one App.tsx starts with: always collapsed at or below
 *   `NARROW_VIEWPORT_MAX_WIDTH_PX` (the drawer starts closed and ignores the saved flag,
 *   useLeftSidebarState), above it the saved one the early script sets in `data-sidebar`, else
 *   expanded. A saved custom width is not copied (leftover).
 * - The logo's fill follows `data-theme` (set before the app by index.html), as ProjectSidebar picks
 *   its dark or light logo from the theme.
 * - The live wizard focuses its first button and shows a focus ring. The inert copy has none.
 * tests/ui/onboarding/firstRunViewParity.test.ts fails when the overlay or the dialog drifts from
 * the live wizard in tags, classes or text (an icon's <svg> counts without its children).
 *
 * SECURITY AUDIT: trusted server text. Every byte is fixed at build time: it holds no user,
 * request, config or repo data, and nothing may be interpolated into it but FIRST_RUN_VIEW_ID, the
 * layout constants the live sidebar uses, and the build's version (HTML-escaped).
 * PR 4 inserts it with `template.content.cloneNode(true)`, never with innerHTML, outerHTML or
 * insertAdjacentHTML.
 */
export function firstRunViewHtml(gitDescribe: string): string {
  const version = gitDescribe.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const view = `#${FIRST_RUN_VIEW_ID}`;
  const hide = "{ display: none !important }";
  return `<div id="${FIRST_RUN_VIEW_ID}" inert style="position:fixed;inset:0;z-index:1500;overflow:hidden">
  <style>
    @media (max-width: ${NARROW_VIEWPORT_MAX_WIDTH_PX}px) { ${view} [data-pre="e"], ${view} [data-pre="handle"] ${hide} }
    @media (min-width: ${NARROW_VIEWPORT_MAX_WIDTH_PX + 1}px) { ${view}:not([data-sidebar="collapsed"]) [data-pre="c"], ${view}[data-sidebar="collapsed"] [data-pre="e"] ${hide} }
    ${view} [data-pre-logo] { color: #000 } :root[data-theme="dark"] ${view} [data-pre-logo], :root[data-theme$="-dark"] ${view} [data-pre-logo] { color: #fff }
  </style>
  <div class="h-full">
    <div class="bg-surface-primary h-full">
      <div class="bg-surface-primary mobile-layout flex h-full overflow-hidden pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
        <div class="left-sidebar-toggle-host titlebar-safe-left titlebar-safe-left-gutter-4 flex shrink-0 items-center gap-1 fixed top-[env(safe-area-inset-top)] left-[env(safe-area-inset-left)] z-[1050] h-8">
          <button class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium text-muted hover:text-foreground h-6 w-6 shrink-0 mobile-menu-btn"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewbox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-panel-left h-3.5 w-3.5"><rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M9 3v18"></path></svg></button>
        </div>
        <div class="mobile-overlay fixed inset-0 z-40 hidden before:absolute before:inset-0 before:bg-black/50 before:backdrop-blur-sm" data-pre="e"></div>
        <div class="h-full bg-sidebar border-r border-border flex flex-col shrink-0 overflow-hidden relative z-20 transition-[width] duration-200 mobile-sidebar" style="width:${LEFT_SIDEBAR_DEFAULT_WIDTH_PX}px" data-pre="e">
          <div class="bg-sidebar border-border-light font-primary text-muted flex shrink-0 items-center justify-between border-b pr-4 text-[11px] select-none [@media(max-width:768px)_and_(pointer:coarse)]:min-h-11 h-8">
            <div aria-hidden="true" class="left-sidebar-toggle-host titlebar-safe-left titlebar-safe-left-gutter-4 flex shrink-0 items-center gap-1 invisible"><button tabindex="-1" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium text-muted hover:text-foreground h-6 w-6 shrink-0 mobile-menu-btn"></button></div>
            <div class="mr-4 ml-2 flex min-w-0 flex-1 items-center gap-2">
              <button type="button" class="flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left text-inherit transition-opacity"><div class="text-content-secondary min-w-0 flex-1 truncate font-normal tracking-wider text-xs" data-pre-version>${version}</div></button>
            </div>
            <div class="flex shrink-0 items-center gap-1.5">
              <button class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 hover:text-foreground border-border-light text-muted-foreground hover:border-border-medium/80 hover:bg-toggle-bg/70 h-5 w-5 border"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewbox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chart-column h-3.5 w-3.5"><path d="M3 3v16a2 2 0 0 0 2 2h16"></path><path d="M18 17V9"></path><path d="M13 17V5"></path><path d="M8 17v-3"></path></svg></button>
              <button class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 hover:text-foreground border-border-light text-muted-foreground hover:border-border-medium/80 hover:bg-toggle-bg/70 h-5 w-5 border"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewbox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-settings h-3.5 w-3.5"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"></path><circle cx="12" cy="12" r="3"></circle></svg></button>
            </div>
          </div>
          <div class="font-primary bg-surface-primary border-border-light relative flex flex-1 select-none flex-col overflow-hidden border-r">
            <div class="border-dark flex items-center justify-between border-b py-3 pr-3 pl-4">
              <div class="flex min-w-0 items-center gap-2">
                <button class="shrink-0 cursor-pointer border-none bg-transparent p-0"><svg width="134.7754" height="62" viewbox="0 0 134.7754 62" fill="none" xmlns="http://www.w3.org/2000/svg" class="h-5 w-auto" data-pre-logo><path d="M2.208 48 11.376 34.944 2.448 22.272H10.08L15.6 30.528L20.928 22.272H28.752L19.872 34.992L28.992 48H21.36L15.696 39.264L9.984 48H2.208ZM41.856 48.576C39.2 48.576 37.12 47.728 35.616 46.032C34.144 44.304 33.408 41.904 33.408 38.832V22.272H40.608V37.152C40.608 39.136 40.912 40.592 41.52 41.52C42.128 42.416 43.088 42.864 44.4 42.864C45.872 42.864 47.008 42.368 47.808 41.376C48.64 40.352 49.056 38.832 49.056 36.816V22.272H56.256V48H49.68L49.488 40.608L50.4 40.8C50.016 43.36 49.104 45.296 47.664 46.608C46.224 47.92 44.288 48.576 41.856 48.576ZM62.544 48V22.272H69.024L69.264 28.464L68.592 28.176C68.944 26.8 69.472 25.632 70.176 24.672C70.912 23.712 71.792 22.976 72.816 22.464C73.84 21.952 74.96 21.696 76.176 21.696C78.32 21.696 80.048 22.32 81.36 23.568C82.704 24.816 83.568 26.496 83.952 28.608L83.04 28.656C83.328 27.152 83.824 25.888 84.528 24.864C85.264 23.808 86.16 23.024 87.216 22.512C88.272 21.968 89.456 21.696 90.768 21.696C92.56 21.696 94.096 22.064 95.376 22.8C96.656 23.536 97.648 24.64 98.352 26.112C99.056 27.552 99.408 29.328 99.408 31.44V48H92.208V33.456C92.208 31.44 91.904 29.936 91.296 28.944C90.688 27.92 89.696 27.408 88.32 27.408C87.456 27.408 86.72 27.648 86.112 28.128C85.504 28.608 85.024 29.312 84.672 30.24C84.352 31.136 84.192 32.24 84.192 33.552V48H77.712V33.552C77.712 31.568 77.424 30.048 76.848 28.992C76.272 27.936 75.28 27.408 73.872 27.408C73.008 27.408 72.256 27.648 71.616 28.128C71.008 28.608 70.544 29.312 70.224 30.24C69.904 31.168 69.744 32.272 69.744 33.552V48H62.544Z" fill="currentColor"></path><rect x="108.7754" y="13" width="26" height="35" fill="currentColor"></rect></svg></button>
              </div>
              <button class="text-content-secondary hover:bg-hover hover:text-foreground hover:border-border-light flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded border border-transparent bg-transparent px-1.5 text-xs transition-all duration-200"><span class="text-base leading-none">+</span><span>Add Project</span></button>
            </div>
            <div dir="ltr" class="relative overflow-hidden flex-1" style="position:relative">
              <div class="h-full w-full rounded-[inherit] overflow-x-hidden" style="overflow:hidden">
                <div style="min-width:100%; display:table">
                  <div>
                    <div class="group sticky top-0 z-30 py-2 pl-2 pr-1 flex select-none items-center border-l-transparent bg-surface-primary transition-colors duration-150">
                      <button class="group/toggle text-secondary -my-0.5 -ml-0.5 mr-1 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center bg-transparent p-0"><span class="group-hover/toggle:bg-hover group-hover/toggle:border-border-light flex h-5 w-5 items-center justify-center rounded border border-transparent transition-all duration-200"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewbox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-right h-4 w-4 transition-transform duration-200" style="transform:rotate(0deg)"><path d="m9 18 6-6-6-6"></path></svg></span></button>
                      <div class="flex min-w-0 flex-1 items-center pr-1">
                        <span class="text-foreground truncate text-sm font-medium">Chats</span>
                      </div>
                      <button class="text-content-secondary hover:bg-hover hover:border-border-light flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border border-transparent bg-transparent"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewbox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus h-3.5 w-3.5"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg></button>
                    </div>
                  </div>
                  <div class="px-4 py-8 text-center">
                    <p class="text-content-secondary mb-4 text-[13px]">No projects</p>
                    <div class="flex flex-col gap-2">
                      <button class="bg-accent hover:bg-accent-button-hover text-accent-foreground cursor-pointer rounded border-none px-4 py-2 text-[13px] transition-colors duration-200">Start a scratch chat</button>
                      <button class="border-border-light text-content-secondary hover:bg-hover hover:text-foreground cursor-pointer rounded border px-4 py-2 text-[13px] transition-colors duration-200">Add Project</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div class="bg-border-light pointer-events-none absolute inset-y-0 right-0 z-40 w-px"></div>
          </div>
          <div class="absolute right-0 top-0 bottom-0 w-0.5 z-10 cursor-col-resize transition-[background] duration-150 bg-border-light hover:bg-accent" data-pre="handle"></div>
        </div>
        <div class="h-full bg-sidebar border-border flex flex-col shrink-0 overflow-hidden relative z-20 transition-[width] duration-200 mobile-sidebar mobile-sidebar-collapsed border-r-0" style="width:${LEFT_SIDEBAR_COLLAPSED_WIDTH_PX}px" data-pre="c">
          <div class="font-primary bg-surface-primary border-border-light relative flex flex-1 select-none flex-col overflow-hidden border-r-0">
          </div>
        </div>
        <div class="mobile-main-content flex min-w-0 flex-1 flex-col overflow-hidden">
          <div class="mobile-layout flex flex-1 overflow-hidden">
            <div class="bg-surface-primary flex flex-1 flex-col overflow-hidden">
              <div class="bg-sidebar border-border-light flex shrink-0 items-center border-b [@media(max-width:768px)_and_(pointer:coarse)]:min-h-11 h-8" data-pre="c">
                <div aria-hidden="true" class="left-sidebar-toggle-host titlebar-safe-left titlebar-safe-left-gutter-4 flex shrink-0 items-center gap-1 invisible"><button tabindex="-1" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium text-muted hover:text-foreground h-6 w-6 shrink-0 mobile-menu-btn"></button></div>
              </div>
              <div class="flex flex-1 items-center justify-center px-6">
                <p class="text-content-secondary text-sm">Select or add a project to get started.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div data-modal-dialog-overlay="" class="fixed inset-0 z-[1500] before:absolute before:inset-0 before:bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"></div>
  <div role="dialog" class="bg-dark border-border fixed top-[50%] left-[50%] z-[1500] grid w-[90%] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto]" style="max-width: 500px">
    <div class="flex flex-col space-y-1.5 text-left">
      <h2 class="text-foreground text-lg font-semibold leading-none tracking-tight">Choose your own AI providers</h2>
    </div>
    <div class="min-h-0 overflow-y-auto">
      <div class="text-content-secondary flex flex-col gap-4">
        <div class="flex items-center justify-end gap-2">
          <span class="text-content-secondary text-xs" aria-hidden="true">1 / 6</span>
          <div class="flex items-center gap-1" role="img" aria-label="Step 1 of 6">
            <span class="h-1.5 w-1.5 rounded-full bg-accent"></span>
            <span class="h-1.5 w-1.5 rounded-full bg-border-medium"></span>
            <span class="h-1.5 w-1.5 rounded-full bg-border-medium"></span>
            <span class="h-1.5 w-1.5 rounded-full bg-border-medium"></span>
            <span class="h-1.5 w-1.5 rounded-full bg-border-medium"></span>
            <span class="h-1.5 w-1.5 rounded-full bg-border-medium"></span>
          </div>
        </div>
        <div class="flex flex-col gap-3">
          <div class="text-foreground flex items-center gap-2 text-sm font-medium">
            <span class="bg-accent/10 text-accent-text inline-flex h-8 w-8 items-center justify-center rounded-md"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewbox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sparkles h-4 w-4" aria-hidden="true"><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"></path><path d="M20 2v4"></path><path d="M22 4h-4"></path><circle cx="4" cy="20" r="2"></circle></svg></span>
            <span>Choose your own AI providers</span>
          </div>
          <div class="text-content-secondary flex flex-col gap-3 text-sm">
            <p>Xum is provider-agnostic: bring your own keys, mix and match models, or run locally.</p>
            <p class="mt-3 text-xs">No providers configured yet.</p>
            <div class="mt-3">
              <div class="text-foreground mb-2 text-xs font-medium">Available providers</div>
              <div class="grid grid-cols-2 gap-2">
                <button type="button" class="bg-background-secondary border-border-medium text-foreground hover:bg-hover flex w-full cursor-pointer items-center justify-between rounded-md border px-2 py-1 text-left text-xs" title="Not configured"><span class="inline-flex items-center gap-1 whitespace-nowrap"><span class="inline-block h-[1em] w-[1em] align-[-0.125em] [&amp;_svg]:block [&amp;_svg]:h-full [&amp;_svg]:w-full [&amp;_svg]:fill-current [&amp;_svg_.st0]:fill-current text-accent-text"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img" fill="currentColor" fill-rule="evenodd"><title>OpenRouter</title><path d="M16.804 1.957l7.22 4.105v.087L16.73 10.21l.017-2.117-.821-.03c-1.059-.028-1.611.002-2.268.11-1.064.175-2.038.577-3.147 1.352L8.345 11.03c-.284.195-.495.336-.68.455l-.515.322-.397.234.385.23.53.338c.476.314 1.17.796 2.701 1.866 1.11.775 2.083 1.177 3.147 1.352l.3.045c.694.091 1.375.094 2.825.033l.022-2.159 7.22 4.105v.087L16.589 22l.014-1.862-.635.022c-1.386.042-2.137.002-3.138-.162-1.694-.28-3.26-.926-4.881-2.059l-2.158-1.5a21.997 21.997 0 00-.755-.498l-.467-.28a55.927 55.927 0 00-.76-.43C2.908 14.73.563 14.116 0 14.116V9.888l.14.004c.564-.007 2.91-.622 3.809-1.124l1.016-.58.438-.274c.428-.28 1.072-.726 2.686-1.853 1.621-1.133 3.186-1.78 4.881-2.059 1.152-.19 1.974-.213 3.814-.138l.02-1.907z"></path></svg></span><span>OpenRouter</span></span><span class="h-2 w-2 rounded-full bg-border-medium"></span></button>
                <button type="button" class="bg-background-secondary border-border-medium text-foreground hover:bg-hover flex w-full cursor-pointer items-center justify-between rounded-md border px-2 py-1 text-left text-xs" title="Not configured"><span class="inline-flex items-center gap-1 whitespace-nowrap"><span class="inline-block h-[1em] w-[1em] align-[-0.125em] [&amp;_svg]:block [&amp;_svg]:h-full [&amp;_svg]:w-full [&amp;_svg]:fill-current [&amp;_svg_.st0]:fill-current text-accent-text"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg></span><span>GitHub Copilot</span></span><span class="h-2 w-2 rounded-full bg-border-medium"></span></button>
                <button type="button" class="bg-background-secondary border-border-medium text-foreground hover:bg-hover flex w-full cursor-pointer items-center justify-between rounded-md border px-2 py-1 text-left text-xs" title="Not configured"><span class="inline-flex items-center gap-1 whitespace-nowrap"><span class="inline-block h-[1em] w-[1em] align-[-0.125em] [&amp;_svg]:block [&amp;_svg]:h-full [&amp;_svg]:w-full [&amp;_svg]:fill-current [&amp;_svg_.st0]:fill-current text-accent-text"><svg viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M73.6815 64C116.338 64.0001 140.252 85.6012 141.06 117.397L104.22 118.606C103.25 100.98 88.6272 89.4022 73.6815 89.7474C53.1607 90.1795 37.9709 104.782 37.9708 127.938C37.9708 151.093 53.1603 165.437 73.6815 165.437C88.6272 165.436 102.926 154.377 104.543 136.75L141.383 137.615C140.414 169.929 115.046 191.875 73.6815 191.875C32.3167 191.875 0 166.818 0 127.938C0.000151497 88.8837 31.0241 64 73.6815 64ZM256 67.7783V188.742H159.053V67.7783H256Z" fill="currentColor"></path></svg></span><span>Coder</span></span><span class="h-2 w-2 rounded-full bg-border-medium"></span></button>
                <button type="button" class="bg-background-secondary border-border-medium text-foreground hover:bg-hover flex w-full cursor-pointer items-center justify-between rounded-md border px-2 py-1 text-left text-xs" title="Not configured"><span class="inline-flex items-center gap-1 whitespace-nowrap"><span class="inline-block h-[1em] w-[1em] align-[-0.125em] [&amp;_svg]:block [&amp;_svg]:h-full [&amp;_svg]:w-full [&amp;_svg]:fill-current [&amp;_svg_.st0]:fill-current text-accent-text"><svg fill="currentColor" fill-rule="evenodd" height="1em" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg" style="flex: 0 0 auto; line-height: 1;"><title>Bedrock</title><path d="M13.05 15.513h3.08c.214 0 .389.177.389.394v1.82a1.704 1.704 0 011.296 1.661c0 .943-.755 1.708-1.685 1.708-.931 0-1.686-.765-1.686-1.708 0-.807.554-1.484 1.297-1.662v-1.425h-2.69v4.663a.395.395 0 01-.188.338l-2.69 1.641a.385.385 0 01-.405-.002l-4.926-3.086a.395.395 0 01-.185-.336V16.3L2.196 14.87A.395.395 0 012 14.555L2 14.528V9.406c0-.14.073-.27.192-.34l2.465-1.462V4.448c0-.129.062-.249.165-.322l.021-.014L9.77 1.058a.385.385 0 01.407 0l2.69 1.675a.395.395 0 01.185.336V7.6h3.856V5.683a1.704 1.704 0 01-1.296-1.662c0-.943.755-1.708 1.685-1.708.931 0 1.685.765 1.685 1.708 0 .807-.553 1.484-1.296 1.662v2.311a.391.391 0 01-.389.394h-4.245v1.806h6.624a1.69 1.69 0 011.64-1.313c.93 0 1.685.764 1.685 1.707 0 .943-.754 1.708-1.685 1.708a1.69 1.69 0 01-1.64-1.314H13.05v1.937h4.953l.915 1.18a1.66 1.66 0 01.84-.227c.931 0 1.685.764 1.685 1.707 0 .943-.754 1.708-1.685 1.708-.93 0-1.685-.765-1.685-1.708 0-.346.102-.668.276-.937l-.724-.935H13.05v1.806zM9.973 1.856L7.93 3.122V6.09h-.778V3.604L5.435 4.669v2.945l2.11 1.36L9.712 7.61V5.334h.778V7.83c0 .136-.07.263-.184.335L7.963 9.638v2.081l1.422 1.009-.446.646-1.406-.998-1.53 1.005-.423-.66 1.605-1.055v-1.99L5.038 8.29l-2.26 1.34v1.676l1.972-1.189.398.677-2.37 1.429V14.3l2.166 1.258 2.27-1.368.397.677-2.176 1.311V19.3l1.876 1.175 2.365-1.426.398.678-2.017 1.216 1.918 1.201 2.298-1.403v-5.78l-4.758 2.893-.4-.675 5.158-3.136V3.289L9.972 1.856zM16.13 18.47a.913.913 0 00-.908.92c0 .507.406.918.908.918a.913.913 0 00.907-.919.913.913 0 00-.907-.92zm3.63-3.81a.913.913 0 00-.908.92c0 .508.406.92.907.92a.913.913 0 00.908-.92.913.913 0 00-.908-.92zm1.555-4.99a.913.913 0 00-.908.92c0 .507.407.918.908.918a.913.913 0 00.907-.919.913.913 0 00-.907-.92zM17.296 3.1a.913.913 0 00-.907.92c0 .508.406.92.907.92a.913.913 0 00.908-.92.913.913 0 00-.908-.92z"></path></svg></span><span>Bedrock</span></span><span class="h-2 w-2 rounded-full bg-border-medium"></span></button>
                <button type="button" class="bg-background-secondary border-border-medium text-foreground hover:bg-hover flex w-full cursor-pointer items-center justify-between rounded-md border px-2 py-1 text-left text-xs" title="Not configured"><span class="inline-flex items-center gap-1 whitespace-nowrap"><span class="inline-block h-[1em] w-[1em] align-[-0.125em] [&amp;_svg]:block [&amp;_svg]:h-full [&amp;_svg]:w-full [&amp;_svg]:fill-current [&amp;_svg_.st0]:fill-current text-accent-text"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 92.2 65"><path d="M66.5,0H52.4l25.7,65h14.1L66.5,0z M25.7,0L0,65h14.4l5.3-13.6h26.9L51.8,65h14.4L40.5,0C40.5,0,25.7,0,25.7,0z M24.3,39.3l8.8-22.8l8.8,22.8H24.3z"></path></svg></span><span>Anthropic</span></span><span class="h-2 w-2 rounded-full bg-border-medium"></span></button>
                <button type="button" class="bg-background-secondary border-border-medium text-foreground hover:bg-hover flex w-full cursor-pointer items-center justify-between rounded-md border px-2 py-1 text-left text-xs" title="Not configured"><span class="inline-flex items-center gap-1 whitespace-nowrap"><span class="inline-block h-[1em] w-[1em] align-[-0.125em] [&amp;_svg]:block [&amp;_svg]:h-full [&amp;_svg]:w-full [&amp;_svg]:fill-current [&amp;_svg_.st0]:fill-current text-accent-text"><svg width="800px" height="800px" viewBox="0 0 24 24" role="img" xmlns="http://www.w3.org/2000/svg"><title>OpenAI icon</title><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"></path></svg></span><span>OpenAI</span></span><span class="h-2 w-2 rounded-full bg-border-medium"></span></button>
                <button type="button" class="bg-background-secondary border-border-medium text-foreground hover:bg-hover flex w-full cursor-pointer items-center justify-between rounded-md border px-2 py-1 text-left text-xs" title="Not configured"><span class="inline-flex items-center gap-1 whitespace-nowrap"><span class="inline-block h-[1em] w-[1em] align-[-0.125em] [&amp;_svg]:block [&amp;_svg]:h-full [&amp;_svg]:w-full [&amp;_svg]:fill-current [&amp;_svg_.st0]:fill-current text-accent-text"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 65 65"><path d="M32.447 0c.68 0 1.273.465 1.439 1.125a38.904 38.904 0 001.999 5.905c2.152 5 5.105 9.376 8.854 13.125 3.751 3.75 8.126 6.703 13.125 8.855a38.98 38.98 0 005.906 1.999c.66.166 1.124.758 1.124 1.438 0 .68-.464 1.273-1.125 1.439a38.902 38.902 0 00-5.905 1.999c-5 2.152-9.375 5.105-13.125 8.854-3.749 3.751-6.702 8.126-8.854 13.125a38.903 38.903 0 00-1.999 5.906c-.166.66-.759 1.124-1.439 1.124-.68 0-1.272-.464-1.438-1.125a38.96 38.96 0 00-1.999-5.905c-2.152-4.999-5.105-9.374-8.855-13.125-3.749-3.749-8.125-6.702-13.125-8.854a38.904 38.904 0 00-5.905-1.999C.464 33.72 0 33.127 0 32.447c0-.68.465-1.272 1.125-1.438a38.98 38.98 0 005.905-1.999c5-2.152 9.376-5.105 13.125-8.855 3.75-3.749 6.703-8.125 8.855-13.125a38.96 38.96 0 001.999-5.905C31.175.465 31.767 0 32.447 0z"></path></svg></span><span>Google</span></span><span class="h-2 w-2 rounded-full bg-border-medium"></span></button>
                <button type="button" class="bg-background-secondary border-border-medium text-foreground hover:bg-hover flex w-full cursor-pointer items-center justify-between rounded-md border px-2 py-1 text-left text-xs" title="Not configured"><span class="inline-flex items-center gap-1 whitespace-nowrap"><span class="inline-block h-[1em] w-[1em] align-[-0.125em] [&amp;_svg]:block [&amp;_svg]:h-full [&amp;_svg]:w-full [&amp;_svg]:fill-current [&amp;_svg_.st0]:fill-current text-accent-text"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 65 65"><path d="M32.447 0c.68 0 1.273.465 1.439 1.125a38.904 38.904 0 001.999 5.905c2.152 5 5.105 9.376 8.854 13.125 3.751 3.75 8.126 6.703 13.125 8.855a38.98 38.98 0 005.906 1.999c.66.166 1.124.758 1.124 1.438 0 .68-.464 1.273-1.125 1.439a38.902 38.902 0 00-5.905 1.999c-5 2.152-9.375 5.105-13.125 8.854-3.749 3.751-6.702 8.126-8.854 13.125a38.903 38.903 0 00-1.999 5.906c-.166.66-.759 1.124-1.439 1.124-.68 0-1.272-.464-1.438-1.125a38.96 38.96 0 00-1.999-5.905c-2.152-4.999-5.105-9.374-8.855-13.125-3.749-3.749-8.125-6.702-13.125-8.854a38.904 38.904 0 00-5.905-1.999C.464 33.72 0 33.127 0 32.447c0-.68.465-1.272 1.125-1.438a38.98 38.98 0 005.905-1.999c5-2.152 9.376-5.105 13.125-8.855 3.75-3.749 6.703-8.125 8.855-13.125a38.96 38.96 0 001.999-5.905C31.175.465 31.767 0 32.447 0z"></path></svg></span><span>Google Vertex AI</span></span><span class="h-2 w-2 rounded-full bg-border-medium"></span></button>
                <button type="button" class="bg-background-secondary border-border-medium text-foreground hover:bg-hover flex w-full cursor-pointer items-center justify-between rounded-md border px-2 py-1 text-left text-xs" title="Not configured"><span class="inline-flex items-center gap-1 whitespace-nowrap"><span class="inline-block h-[1em] w-[1em] align-[-0.125em] [&amp;_svg]:block [&amp;_svg]:h-full [&amp;_svg]:w-full [&amp;_svg]:fill-current [&amp;_svg_.st0]:fill-current text-accent-text"><svg xmlns="http://www.w3.org/2000/svg" viewBox="195 50 452 495"><g><polygon points="557.09,211.99 565.4,538.36 631.96,538.36 640.28,93.18"></polygon><polygon points="640.28,56.91 538.72,56.91 379.35,284.53 430.13,357.05"></polygon><polygon points="201.61,538.36 303.17,538.36 353.96,465.84 303.17,393.31"></polygon><polygon points="201.61,211.99 430.13,538.36 531.69,538.36 303.17,211.99"></polygon></g></svg></span><span>xAI</span></span><span class="h-2 w-2 rounded-full bg-border-medium"></span></button>
                <button type="button" class="bg-background-secondary border-border-medium text-foreground hover:bg-hover flex w-full cursor-pointer items-center justify-between rounded-md border px-2 py-1 text-left text-xs" title="Not configured"><span class="inline-flex items-center gap-1 whitespace-nowrap"><span class="inline-block h-[1em] w-[1em] align-[-0.125em] [&amp;_svg]:block [&amp;_svg]:h-full [&amp;_svg]:w-full [&amp;_svg]:fill-current [&amp;_svg_.st0]:fill-current text-accent-text"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M6.7 4.7C2.8 4.7 0 9.8 0 14c0 2.6 1.3 5.3 4.3 5.3 2.2 0 3.7-1.3 6.3-5.9l1.5-2.7c1.4 2.1 2.2 3.7 3 5 1.4 2.4 2.6 3.6 4.5 3.6 2.8 0 4.4-2.4 4.4-5.4 0-4.6-3-9.2-6.5-9.2-2 0-3.6 1.5-5.2 3.6-1.7-2.3-3.1-3.6-5.6-3.6Zm0 2.6c1.5 0 2.6 1.1 4.1 3.1l-2 3.4c-2 3.1-2.8 3.5-4 3.5-1.5 0-2.2-1.4-2.2-3.2 0-3.2 2-6.8 4.1-6.8Zm10.8-.3c2.2 0 4.1 3.7 4.1 7 0 2.1-.7 3.3-2 3.3-1.2 0-1.8-.7-3.1-2.8l-3-4.7c1.4-1.9 2.7-2.8 4-2.8Z"></path></svg></span><span>Meta</span></span><span class="h-2 w-2 rounded-full bg-border-medium"></span></button>
                <button type="button" class="bg-background-secondary border-border-medium text-foreground hover:bg-hover flex w-full cursor-pointer items-center justify-between rounded-md border px-2 py-1 text-left text-xs" title="Not configured"><span class="inline-flex items-center gap-1 whitespace-nowrap"><span class="inline-block h-[1em] w-[1em] align-[-0.125em] [&amp;_svg]:block [&amp;_svg]:h-full [&amp;_svg]:w-full [&amp;_svg]:fill-current [&amp;_svg_.st0]:fill-current text-accent-text"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 509.64"><path d="M440.898 139.167c-4.001-1.961-5.723 1.776-8.062 3.673-.801.612-1.479 1.407-2.154 2.141-5.848 6.246-12.681 10.349-21.607 9.859-13.048-.734-24.192 3.368-34.04 13.348-2.093-12.307-9.048-19.658-19.635-24.37-5.54-2.449-11.141-4.9-15.02-10.227-2.708-3.795-3.447-8.021-4.801-12.185-.861-2.509-1.725-5.082-4.618-5.512-3.139-.49-4.372 2.142-5.601 4.349-4.925 9.002-6.833 18.921-6.647 28.962.432 22.597 9.972 40.597 28.932 53.397 2.154 1.47 2.707 2.939 2.032 5.082-1.293 4.41-2.832 8.695-4.186 13.105-.862 2.817-2.157 3.429-5.172 2.205-10.402-4.346-19.391-10.778-27.332-18.553-13.481-13.044-25.668-27.434-40.873-38.702a177.614 177.614 0 00-10.834-7.409c-15.512-15.063 2.032-27.434 6.094-28.902 4.247-1.532 1.478-6.797-12.251-6.736-13.727.061-26.285 4.653-42.288 10.777-2.34.92-4.801 1.593-7.326 2.142-14.527-2.756-29.608-3.368-45.367-1.593-29.671 3.305-53.368 17.329-70.788 41.272-20.928 28.785-25.854 61.482-19.821 95.59 6.34 35.943 24.683 65.704 52.876 88.974 29.239 24.123 62.911 35.943 101.32 33.677 23.329-1.346 49.307-4.468 78.607-29.27 7.387 3.673 15.142 5.144 28.008 6.246 9.911.92 19.452-.49 26.839-2.019 11.573-2.449 10.773-13.166 6.586-15.124-33.915-15.797-26.47-9.368-33.24-14.573 17.235-20.39 43.213-41.577 53.369-110.222.8-5.448.121-8.877 0-13.287-.061-2.692.553-3.734 3.632-4.041 8.494-.981 16.742-3.305 24.314-7.471 21.975-12.002 30.84-31.719 32.933-55.355.307-3.612-.061-7.348-3.879-9.245v-.003zM249.4 351.89c-32.872-25.838-48.814-34.352-55.4-33.984-6.155.368-5.048 7.41-3.694 12.002 1.415 4.532 3.264 7.654 5.848 11.634 1.785 2.634 3.017 6.551-1.784 9.493-10.587 6.55-28.993-2.205-29.856-2.635-21.421-12.614-39.334-29.269-51.954-52.047-12.187-21.924-19.267-45.435-20.435-70.542-.308-6.061 1.478-8.207 7.509-9.307 7.94-1.471 16.127-1.778 24.068-.615 33.547 4.9 62.108 19.902 86.054 43.66 13.666 13.531 24.007 29.699 34.658 45.496 11.326 16.778 23.514 32.761 39.026 45.865 5.479 4.592 9.848 8.083 14.035 10.656-12.62 1.407-33.673 1.714-48.075-9.676zm15.899-102.519c.521-2.111 2.421-3.658 4.722-3.658a4.74 4.74 0 011.661.305c.678.246 1.293.614 1.786 1.163.861.859 1.354 2.083 1.354 3.368 0 2.695-2.154 4.837-4.862 4.837a4.748 4.748 0 01-4.738-4.034 5.01 5.01 0 01.077-1.981zm47.208 26.915c-2.606.996-5.2 1.778-7.707 1.88-4.679.244-9.787-1.654-12.556-3.981-4.308-3.612-7.386-5.631-8.679-11.941-.554-2.695-.247-6.858.246-9.246 1.108-5.144-.124-8.451-3.754-11.451-2.954-2.449-6.711-3.122-10.834-3.122-1.539 0-2.954-.673-4.001-1.224-1.724-.856-3.139-3-1.785-5.634.432-.856 2.525-2.939 3.018-3.305 5.6-3.185 12.065-2.144 18.034.244 5.54 2.266 9.727 6.429 15.759 12.307 6.155 7.102 7.263 9.063 10.773 14.39 2.771 4.163 5.294 8.451 7.018 13.348.877 2.561.071 4.74-2.341 6.277-.981.625-2.109 1.044-3.191 1.458z"></path></svg></span><span>DeepSeek</span></span><span class="h-2 w-2 rounded-full bg-border-medium"></span></button>
                <button type="button" class="bg-background-secondary border-border-medium text-foreground hover:bg-hover flex w-full cursor-pointer items-center justify-between rounded-md border px-2 py-1 text-left text-xs" title="Not configured"><span class="inline-flex items-center gap-1 whitespace-nowrap"><span class="inline-block h-[1em] w-[1em] align-[-0.125em] [&amp;_svg]:block [&amp;_svg]:h-full [&amp;_svg]:w-full [&amp;_svg]:fill-current [&amp;_svg_.st0]:fill-current text-accent-text"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M21 13A9 9 0 1 1 11 3a7.5 7.5 0 0 0 10 10Z"></path></svg></span><span>Moonshot AI</span></span><span class="h-2 w-2 rounded-full bg-border-medium"></span></button>
                <button type="button" class="bg-background-secondary border-border-medium text-foreground hover:bg-hover flex w-full cursor-pointer items-center justify-between rounded-md border px-2 py-1 text-left text-xs" title="Not configured"><span class="inline-flex items-center gap-1 whitespace-nowrap"><span class="inline-block h-[1em] w-[1em] align-[-0.125em] [&amp;_svg]:block [&amp;_svg]:h-full [&amp;_svg]:w-full [&amp;_svg]:fill-current [&amp;_svg_.st0]:fill-current text-accent-text"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd"><path d="M12.105 2 9.927 4.953H.653L2.83 2h9.275ZM23.254 19.048 21.078 22h-9.242l2.174-2.952h9.244ZM24 2 9.264 22H0L14.736 2H24Z"></path></svg></span><span>Z.ai</span></span><span class="h-2 w-2 rounded-full bg-border-medium"></span></button>
                <button type="button" class="bg-background-secondary border-border-medium text-foreground hover:bg-hover flex w-full cursor-pointer items-center justify-between rounded-md border px-2 py-1 text-left text-xs" title="Not configured"><span class="inline-flex items-center gap-1 whitespace-nowrap"><span class="inline-block h-[1em] w-[1em] align-[-0.125em] [&amp;_svg]:block [&amp;_svg]:h-full [&amp;_svg]:w-full [&amp;_svg]:fill-current [&amp;_svg_.st0]:fill-current text-accent-text"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img" fill="currentColor" fill-rule="evenodd"><title>Ollama</title><path d="M7.905 1.09c.216.085.411.225.588.41.295.306.544.744.734 1.263.191.522.315 1.1.362 1.68a5.054 5.054 0 012.049-.636l.051-.004c.87-.07 1.73.087 2.48.474.101.053.2.11.297.17.05-.569.172-1.134.36-1.644.19-.52.439-.957.733-1.264a1.67 1.67 0 01.589-.41c.257-.1.53-.118.796-.042.401.114.745.368 1.016.737.248.337.434.769.561 1.287.23.934.27 2.163.115 3.645l.053.04.026.019c.757.576 1.284 1.397 1.563 2.35.435 1.487.216 3.155-.534 4.088l-.018.021.002.003c.417.762.67 1.567.724 2.4l.002.03c.064 1.065-.2 2.137-.814 3.19l-.007.01.01.024c.472 1.157.62 2.322.438 3.486l-.006.039a.651.651 0 01-.747.536.648.648 0 01-.54-.742c.167-1.033.01-2.069-.48-3.123a.643.643 0 01.04-.617l.004-.006c.604-.924.854-1.83.8-2.72-.046-.779-.325-1.544-.8-2.273a.644.644 0 01.18-.886l.009-.006c.243-.159.467-.565.58-1.12a4.229 4.229 0 00-.095-1.974c-.205-.7-.58-1.284-1.105-1.683-.595-.454-1.383-.673-2.38-.61a.653.653 0 01-.632-.371c-.314-.665-.772-1.141-1.343-1.436a3.288 3.288 0 00-1.772-.332c-1.245.099-2.343.801-2.67 1.686a.652.652 0 01-.61.425c-1.067.002-1.893.252-2.497.703-.522.39-.878.935-1.066 1.588a4.07 4.07 0 00-.068 1.886c.112.558.331 1.02.582 1.269l.008.007c.212.207.257.53.109.785-.36.622-.629 1.549-.673 2.44-.05 1.018.186 1.902.719 2.536l.016.019a.643.643 0 01.095.69c-.576 1.236-.753 2.252-.562 3.052a.652.652 0 01-1.269.298c-.243-1.018-.078-2.184.473-3.498l.014-.035-.008-.012a4.339 4.339 0 01-.598-1.309l-.005-.019a5.764 5.764 0 01-.177-1.785c.044-.91.278-1.842.622-2.59l.012-.026-.002-.002c-.293-.418-.51-.953-.63-1.545l-.005-.024a5.352 5.352 0 01.093-2.49c.262-.915.777-1.701 1.536-2.269.06-.045.123-.09.186-.132-.159-1.493-.119-2.73.112-3.67.127-.518.314-.95.562-1.287.27-.368.614-.622 1.015-.737.266-.076.54-.059.797.042zm4.116 9.09c.936 0 1.8.313 2.446.855.63.527 1.005 1.235 1.005 1.94 0 .888-.406 1.58-1.133 2.022-.62.375-1.451.557-2.403.557-1.009 0-1.871-.259-2.493-.734-.617-.47-.963-1.13-.963-1.845 0-.707.398-1.417 1.056-1.946.668-.537 1.55-.849 2.485-.849zm0 .896a3.07 3.07 0 00-1.916.65c-.461.37-.722.835-.722 1.25 0 .428.21.829.61 1.134.455.347 1.124.548 1.943.548.799 0 1.473-.147 1.932-.426.463-.28.7-.686.7-1.257 0-.423-.246-.89-.683-1.256-.484-.405-1.14-.643-1.864-.643zm.662 1.21l.004.004c.12.151.095.37-.056.49l-.292.23v.446a.375.375 0 01-.376.373.375.375 0 01-.376-.373v-.46l-.271-.218a.347.347 0 01-.052-.49.353.353 0 01.494-.051l.215.172.22-.174a.353.353 0 01.49.051zm-5.04-1.919c.478 0 .867.39.867.871a.87.87 0 01-.868.871.87.87 0 01-.867-.87.87.87 0 01.867-.872zm8.706 0c.48 0 .868.39.868.871a.87.87 0 01-.868.871.87.87 0 01-.867-.87.87.87 0 01.867-.872zM7.44 2.3l-.003.002a.659.659 0 00-.285.238l-.005.006c-.138.189-.258.467-.348.832-.17.692-.216 1.631-.124 2.782.43-.128.899-.208 1.404-.237l.01-.001.019-.034c.046-.082.095-.161.148-.239.123-.771.022-1.692-.253-2.444-.134-.364-.297-.65-.453-.813a.628.628 0 00-.107-.09L7.44 2.3zm9.174.04l-.002.001a.628.628 0 00-.107.09c-.156.163-.32.45-.453.814-.29.794-.387 1.776-.23 2.572l.058.097.008.014h.03a5.184 5.184 0 011.466.212c.086-1.124.038-2.043-.128-2.722-.09-.365-.21-.643-.349-.832l-.004-.006a.659.659 0 00-.285-.239h-.004z"></path></svg></span><span>Ollama</span></span><span class="h-2 w-2 rounded-full bg-border-medium"></span></button>
              </div>
              <div class="text-content-secondary mt-2 flex items-center gap-2 text-xs">
                <span class="h-2 w-2 rounded-full bg-green-500"></span>
                <span>Configured</span>
                <span class="bg-border-medium h-2 w-2 rounded-full"></span>
                <span>Not configured</span>
              </div>
            </div>
            <p class="mt-3">Configure keys and endpoints in <button type="button" class="text-accent-text underline">Settings → Providers</button>.</p>
          </div>
        </div>
      </div>
    </div>
    <div class="flex gap-3 pt-4 justify-between">
      <div></div>
      <div class="flex items-center gap-3">
        <button class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 bg-accent text-accent-foreground shadow hover:bg-accent-button-hover h-9 px-4 py-2 min-w-24">Next</button>
        <button class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 bg-border-medium text-foreground shadow-sm hover:bg-border-darker h-9 px-4 py-2 min-w-24">Skip</button>
      </div>
    </div>
    <button type="button" class="text-muted hover:text-foreground absolute top-4 right-4 rounded-sm transition-colors focus:outline-none disabled:pointer-events-none"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewbox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x h-4 w-4" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg><span class="sr-only">Close</span></button>
  </div>
</div>`;
}

/** The view for this build: the static title bar shows the version the live one shows. */
export const FIRST_RUN_VIEW_HTML = firstRunViewHtml(VERSION.git_describe);

/** The <template> that holds FIRST_RUN_VIEW_HTML on the served "/" (PR 4b). */
export const FIRST_RUN_TEMPLATE_ID = "xum-pre-template";

/**
 * The served "/"'s `<script type="application/json">` with the app's modules,
 * `{"script": href, "preload": [href, ...]}`: server.ts writes it, the early script loads from it, and
 * scripts/perf/firstLoadJs.ts counts it. Not in src/common, so the renderer build stays byte-identical.
 */
export const FIRST_RUN_MODULES_ID = "xum-pre-modules";

/**
 * The early script (plan section 5.6), for an inline <script> on the served "/" after the slashless
 * redirect, the <base> tag and the module list (PR 4b injects them). Its only timer is the 1,000 ms
 * abort of its two POSTs. With the paint-cache key set or a hidden tab it loads the app at once,
 * with no API call. A failed, 401 or aborted POST loads the app with no view, as today. The view
 * shows only when the wizard opens on the providers step as captured: not viewed and no configured
 * provider (a configured one changes that step's text). The app then loads two frames later, or at
 * once when the tab turns hidden. A failed module script removes the view.
 * SECURITY AUDIT: no request or user data; the view comes from a template clone, never HTML.
 */
export const FIRST_RUN_EARLY_SCRIPT = `(() => {
  const path = location.pathname;
  if (!path.startsWith("//") && !path.endsWith("/")) return; // the redirect navigates away
  let loaded = false;
  const loadApp = () => {
    if (loaded) return;
    loaded = true;
    let list;
    try {
      list = JSON.parse(document.getElementById(${JSON.stringify(FIRST_RUN_MODULES_ID)}).textContent);
      if (typeof list.script !== "string" || !Array.isArray(list.preload)) throw new Error("bad list");
    } catch (error) { // no list, no app to load: at least drop the view
      document.getElementById(${JSON.stringify(FIRST_RUN_VIEW_ID)})?.remove();
      return console.error("first-run view: no usable module list", error);
    }
    for (const href of list.preload) {
      const link = document.createElement("link");
      Object.assign(link, { rel: "modulepreload", crossOrigin: "", href });
      document.head.appendChild(link);
    }
    const script = document.createElement("script");
    Object.assign(script, { type: "module", crossOrigin: "", src: list.script });
    script.addEventListener("error", () => document.getElementById(${JSON.stringify(FIRST_RUN_VIEW_ID)})?.remove());
    // Unlike the deferred tag it replaces, a dynamic module runs once loaded: wait for #root.
    const start = () => document.head.appendChild(script);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  };
  const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  if (read(${JSON.stringify(ONBOARDING_VIEWED_KEY)}) === "true" || document.visibilityState === "hidden") return loadApp();
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && loadApp());
  const token = new URLSearchParams(location.search).get("token")?.trim() || read(${JSON.stringify(AUTH_TOKEN_KEY)});
  const headers = token ? { Authorization: "Bearer " + token } : {};
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 1000);
  const post = (route) =>
    fetch(new URL("api/" + route, document.baseURI), { method: "POST", headers, signal: abort.signal }).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    });
  Promise.all([post("splashScreens/getViewedSplashScreens"), post("providers/getConfig")])
    .then(([viewed, config]) => {
      clearTimeout(timer);
      const providers = Object.values(config ?? {});
      const show =
        Array.isArray(viewed) &&
        !viewed.includes("onboarding-wizard-v1") && // ONBOARDING_WIZARD_SPLASH_ID
        !providers.some((p) => p?.isConfigured === true);
      const insert = () => {
        const template = document.getElementById(${JSON.stringify(FIRST_RUN_TEMPLATE_ID)});
        if (!show || loaded || !template) return loadApp();
        const clone = template.content.cloneNode(true);
        // The app's saved sidebar choice, a JSON boolean (owner decision 10-14). Else the width picks.
        const sidebar = read(${JSON.stringify(LEFT_SIDEBAR_COLLAPSED_KEY)});
        const state = sidebar === "true" ? "collapsed" : sidebar === "false" ? "expanded" : null;
        if (state) clone.getElementById(${JSON.stringify(FIRST_RUN_VIEW_ID)}).dataset.sidebar = state;
        document.body.appendChild(clone);
        requestAnimationFrame(() => requestAnimationFrame(loadApp));
      };
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", insert);
      else insert();
    })
    .catch(loadApp);
})();`;
