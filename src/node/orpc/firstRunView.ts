import { FIRST_RUN_VIEW_ID } from "@/common/constants/firstRunView";
import { AUTH_TOKEN_KEY, ONBOARDING_VIEWED_KEY } from "@/common/constants/storage";

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
 * tests/ui/onboarding/firstRunViewParity.test.ts fails when the overlay or the dialog drifts from
 * the live wizard in tags, classes or text.
 *
 * SECURITY AUDIT: trusted server text. Every byte is fixed at build time: it holds no user,
 * request, config or repo data, and nothing may be interpolated into it but FIRST_RUN_VIEW_ID.
 * PR 4 inserts it with `template.content.cloneNode(true)`, never with innerHTML, outerHTML or
 * insertAdjacentHTML.
 */
export const FIRST_RUN_VIEW_HTML = `<div id="${FIRST_RUN_VIEW_ID}" inert style="position:fixed;inset:0;z-index:1500;overflow:hidden">
  <div class="h-full">
    <div class="bg-surface-primary h-full">
      <div class="bg-surface-primary mobile-layout flex h-full overflow-hidden pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
        <div class="mobile-main-content flex min-w-0 flex-1 flex-col overflow-hidden">
          <div class="mobile-layout flex flex-1 overflow-hidden">
            <div class="bg-surface-primary flex flex-1 flex-col overflow-hidden">
              <div class="bg-sidebar border-border-light flex shrink-0 items-center border-b px-4 py-2 ">
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
            <span class="bg-accent/10 text-accent inline-flex h-8 w-8 items-center justify-center rounded-md"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewbox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sparkles h-4 w-4" aria-hidden="true"><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"></path><path d="M20 2v4"></path><path d="M22 4h-4"></path><circle cx="4" cy="20" r="2"></circle></svg></span>
            <span>Xum Gateway (evaluation credits)</span>
          </div>
          <div class="text-content-secondary flex flex-col gap-3 text-sm">
            <p>Xum Gateway enables you to use free AI tokens from <a href="https://coder.com" target="_blank" rel="noopener noreferrer" class="text-accent underline">Coder</a>.</p>
            <p>OSS contributors with GitHub accounts older than 12 months (or GitHub Pro members) can use this to get free evaluation credits.</p>
            <div class="mt-3 flex flex-wrap gap-2">
              <button class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 bg-accent text-accent-foreground shadow hover:bg-accent-button-hover h-9 px-4 py-2">Login with Xum Gateway</button>
            </div>
            <p class="mt-3">You can also receive those credits through:</p>
            <ul class="ml-4 list-disc space-y-1">
              <li>early adopters can request credits tied to their GH logins on our <a href="https://discord.gg/VfZXvtnR" target="_blank" rel="noopener noreferrer" class="text-accent underline">Discord</a></li>
              <li>vouchers which you can <a href="https://gateway.xum.cdr.dev" target="_blank" rel="noopener noreferrer" class="text-accent underline">claim here</a></li>
            </ul>
            <p class="mt-3">You can enable this in <button type="button" class="text-accent underline">Settings → Providers</button>.</p>
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

/** The <template> that holds FIRST_RUN_VIEW_HTML on the served "/" (PR 4b). */
export const FIRST_RUN_TEMPLATE_ID = "xum-pre-template";

/**
 * The app's module script and modulepreloads, as the JSON list the early script loads them from:
 * `{"script": href, "preload": [href, ...]}`. scripts/perf/firstLoadJs.ts counts the same list
 * (its FIRST_RUN_MODULES_ID; PR 4b moves this id to src/common/constants/firstRunView.ts).
 */
const FIRST_RUN_MODULES_ID = "xum-pre-modules";

/**
 * The early script (plan section 5.6): JavaScript for an inline <script> on the served "/", after
 * the slashless redirect, the <base> tag and the module list (PR 4b injects all four). It decides
 * whether the wizard will open on its gateway step, and only then shows the static view:
 * 1. The paint-cache key is set (this browser saw the wizard viewed) or the tab is hidden (no frames
 *    there): load the app at once, with no API call and no view.
 * 2. Otherwise POST the viewed splash list and the provider config together, with the URL's or the
 *    stored token. A failure, a 401 (the app then shows its token prompt) or no answer within
 *    1,000 ms (one abort timer: the deadline of a network call, the script's only timer) loads the
 *    app with no view, as today.
 * 3. Show the view when the wizard is not viewed, no provider is configured and no gateway coupon is
 *    set (OnboardingWizardSplash then opens on the gateway step). Load the app two frames later,
 *    after the frame that paints the view, or at once when the tab turns hidden.
 * The app's module script removes the view if it fails to load. The app removes it otherwise.
 * It holds no request or user data, and inserts the view from a template clone, never as HTML.
 */
export const FIRST_RUN_EARLY_SCRIPT = `(() => {
  const path = location.pathname;
  if (!path.startsWith("//") && !path.endsWith("/")) return; // the redirect navigates away
  let loaded = false;
  const loadApp = () => {
    if (loaded) return;
    loaded = true;
    const list = JSON.parse(document.getElementById(${JSON.stringify(FIRST_RUN_MODULES_ID)}).textContent);
    for (const href of list.preload) {
      const link = document.createElement("link");
      Object.assign(link, { rel: "modulepreload", crossOrigin: "", href });
      document.head.appendChild(link);
    }
    const script = document.createElement("script");
    Object.assign(script, { type: "module", crossOrigin: "", src: list.script });
    script.addEventListener("error", () => document.getElementById(${JSON.stringify(FIRST_RUN_VIEW_ID)})?.remove());
    document.head.appendChild(script);
  };
  const read = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  if (read(${JSON.stringify(ONBOARDING_VIEWED_KEY)}) === "true" || document.visibilityState === "hidden") return loadApp();
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && loadApp());
  const token = new URLSearchParams(location.search).get("token") || read(${JSON.stringify(AUTH_TOKEN_KEY)});
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
        document.body.appendChild(template.content.cloneNode(true));
        requestAnimationFrame(() => requestAnimationFrame(loadApp));
      };
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", insert);
      else insert();
    })
    .catch(loadApp);
})();`;
