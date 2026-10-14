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
 * wizard's gateway step ("Xum Gateway (evaluation credits)"), the step a new server opens on. On `/`,
 * the server will put it in a <template> and an early script will show it before the app JS runs
 * (PR 4). Until then nothing serves it. The live wizard removes it once it shows the same step.
 *
 * Captured from the live page at 412 px (61 elements), then edited:
 * - The app shell's <main> is a <div>. The boot loader's <main> in #root stays the only landmark.
 * - The shell's root is `h-full`: outside #root, which globals.css sizes to the viewport, its
 *   nested `h-full` would resolve against an auto height and collapse to the content height.
 * - Radix runtime artifacts are gone: focus guards, generated ids, aria-hidden, tabindex,
 *   pointer-events. The disabled attributes are gone too: the live buttons are enabled, and
 *   `disabled:opacity-50` made the copy look disabled.
 * - The root is `inert`, so no part of the copy takes focus or clicks before the handoff.
 * - The root is `fixed`, so it is a stacking context: its z-index is the live overlay's 1500
 *   (`z-[1500]`), or the iOS standalone `.ios-status-bar-band` (1001) would paint over the copy.
 * - The left sidebar and the shell header come from the live 1200 px first paint (owner decision
 *   10-14), with runtime attributes and Radix ScrollArea pieces gone. Both sidebar states are here:
 *   the <style> shows the one App.tsx starts with (collapsed at or below
 *   `NARROW_VIEWPORT_MAX_WIDTH_PX`) or the saved one the early script sets in `data-sidebar`. A
 *   saved custom width is not copied (leftover).
 * - The logo's fill follows `data-theme` (set before the app by index.html), as ProjectSidebar picks
 *   its dark or light logo from the theme.
 * - The live wizard focuses its first button and shows a focus ring. The inert copy has none.
 * tests/ui/onboarding/firstRunViewParity.test.ts fails when the overlay or the dialog drifts from
 * the live wizard in tags, classes or text.
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
    @media (max-width: ${NARROW_VIEWPORT_MAX_WIDTH_PX}px) { ${view}:not([data-sidebar="expanded"]) [data-pre="e"], ${view} [data-pre="handle"] ${hide} }
    @media (min-width: ${NARROW_VIEWPORT_MAX_WIDTH_PX + 1}px) { ${view}:not([data-sidebar="collapsed"]) [data-pre="c"] ${hide} }
    ${view}[data-sidebar="collapsed"] [data-pre="e"], ${view}[data-sidebar="expanded"] [data-pre="c"] ${hide}
    ${view} [data-pre-logo] { color: #000 } :root[data-theme="dark"] ${view} [data-pre-logo], :root[data-theme$="-dark"] ${view} [data-pre-logo] { color: #fff }
  </style>
  <div class="h-full">
    <div class="bg-surface-primary h-full">
      <div class="bg-surface-primary mobile-layout flex h-full overflow-hidden pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
        <div class="mobile-overlay fixed inset-0 z-40 hidden before:absolute before:inset-0 before:bg-black/50 before:backdrop-blur-sm" data-pre="e"></div>
        <div class="h-full bg-sidebar border-r border-border flex flex-col shrink-0 overflow-hidden relative z-20 transition-[width] duration-200 mobile-sidebar" style="width:${LEFT_SIDEBAR_DEFAULT_WIDTH_PX}px" data-pre="e">
          <div class="bg-sidebar border-border-light font-primary text-muted titlebar-safe-left titlebar-safe-left-gutter-4 flex shrink-0 items-center justify-between border-b px-4 text-[11px] select-none h-8">
            <div class="mr-4 flex min-w-0 flex-1 items-center gap-2">
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
            <button class="text-muted border-dark hover:bg-hover hover:text-foreground mt-auto flex h-6 w-full cursor-pointer items-center justify-center border-t border-none bg-transparent p-0 text-xs transition-all duration-200 focus-visible:ring-accent focus-visible:ring-1 focus-visible:ring-inset">«</button>
            <div class="bg-border-light pointer-events-none absolute inset-y-0 right-0 z-40 w-px"></div>
          </div>
          <div class="absolute right-0 top-0 bottom-0 w-0.5 z-10 cursor-col-resize transition-[background] duration-150 bg-border-light hover:bg-accent" data-pre="handle"></div>
        </div>
        <div class="h-full bg-sidebar border-r border-border flex flex-col shrink-0 overflow-hidden relative z-20 transition-[width] duration-200 mobile-sidebar mobile-sidebar-collapsed" style="width:${LEFT_SIDEBAR_COLLAPSED_WIDTH_PX}px" data-pre="c">
          <div class="font-primary bg-surface-primary border-border-light relative flex flex-1 select-none flex-col overflow-hidden border-r">
            <button class="text-muted hover:bg-hover hover:text-foreground flex w-full flex-1 cursor-pointer items-center justify-center bg-transparent p-0 text-xs transition-all duration-200 focus-visible:ring-accent focus-visible:ring-1 focus-visible:ring-inset">»</button>
            <div class="bg-border-light pointer-events-none absolute inset-y-0 right-0 z-40 w-px"></div>
          </div>
        </div>
        <div class="mobile-main-content flex min-w-0 flex-1 flex-col overflow-hidden">
          <div class="mobile-layout flex flex-1 overflow-hidden">
            <div class="bg-surface-primary flex flex-1 flex-col overflow-hidden">
              <div class="bg-sidebar border-border-light flex shrink-0 items-center border-b px-4 py-2 " data-pre="c">
                <button type="button" class="border-border-medium bg-background-secondary text-foreground hover:bg-hover rounded-md border px-3 py-1.5 text-sm transition-colors " aria-label="Open sidebar menu">Open sidebar</button>
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
      <h2 class="text-foreground text-lg font-semibold leading-none tracking-tight">Xum Gateway (evaluation credits)</h2>
    </div>
    <div class="min-h-0 overflow-y-auto">
      <div class="text-content-secondary flex flex-col gap-4">
        <div class="flex items-center justify-end gap-2">
          <span class="text-content-secondary text-xs" aria-hidden="true">1 / 7</span>
          <div class="flex items-center gap-1" role="img" aria-label="Step 1 of 7">
            <span class="h-1.5 w-1.5 rounded-full bg-accent"></span>
            <span class="h-1.5 w-1.5 rounded-full bg-border-medium"></span>
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
            <span>Xum Gateway (evaluation credits)</span>
          </div>
          <div class="text-content-secondary flex flex-col gap-3 text-sm">
            <p>Xum Gateway enables you to use free AI tokens from <a href="https://coder.com" target="_blank" rel="noopener noreferrer" class="text-accent-text underline">Coder</a>.</p>
            <p>OSS contributors with GitHub accounts older than 12 months (or GitHub Pro members) can use this to get free evaluation credits.</p>
            <div class="mt-3 flex flex-wrap gap-2">
              <button class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 bg-accent text-accent-foreground shadow hover:bg-accent-button-hover h-9 px-4 py-2">Login with Xum Gateway</button>
            </div>
            <p class="mt-3">You can also receive those credits through:</p>
            <ul class="ml-4 list-disc space-y-1">
              <li>early adopters can request credits tied to their GH logins on our <a href="https://discord.gg/VfZXvtnR" target="_blank" rel="noopener noreferrer" class="text-accent-text underline">Discord</a></li>
              <li>vouchers which you can <a href="https://gateway.xum.cdr.dev" target="_blank" rel="noopener noreferrer" class="text-accent-text underline">claim here</a></li>
            </ul>
            <p class="mt-3">You can enable this in <button type="button" class="text-accent-text underline">Settings → Providers</button>.</p>
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

/** `{"script": href, "preload": [href, ...]}`, the app's modules: scripts/perf/firstLoadJs.ts reads it too. */
const FIRST_RUN_MODULES_ID = "xum-pre-modules";

/**
 * The early script (plan section 5.6), for an inline <script> on the served "/" after the slashless
 * redirect, the <base> tag and the module list (PR 4b injects them). Its only timer is the 1,000 ms
 * abort of its two POSTs. With the paint-cache key set or a hidden tab it loads the app at once,
 * with no API call. A failed, 401 or aborted POST loads the app with no view, as today. The view
 * shows only when the wizard opens on the gateway step as captured: not viewed, no configured
 * provider, and no gateway coupon (a coupon swaps that step's panel). The app then loads two frames
 * later, or at once when the tab turns hidden. A failed module script removes the view.
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
        !providers.some((p) => p?.isConfigured === true) &&
        config?.["mux-gateway"]?.couponCodeSet !== true;
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
