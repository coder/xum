import assert from "node:assert";
import { AUTH_TOKEN_KEY, LEFT_SIDEBAR_COLLAPSED_KEY } from "@/common/constants/storage";
import {
  WORKSPACE_VIEW_APP_STARTED_ATTR,
  WORKSPACE_VIEW_ID,
  WORKSPACE_VIEW_WORKSPACE_ATTR,
} from "@/common/constants/workspaceView";
import { PHONE_CHROME_WIDTHS } from "@/common/staticWorkspaceView/phoneChrome";
import { PHONE_CHROME_JSON } from "@/common/staticWorkspaceView/phoneChrome.generated";
import { VIEW_BUILDER_SOURCE } from "@/common/staticWorkspaceView/viewBuilder";
import { FIRST_RUN_MODULES_ID } from "@/node/orpc/firstRunView";

const q = (value: string) => JSON.stringify(value);
/** The app loads at this point when the tail has not answered: a slow tail never holds it longer. */
export const WORKSPACE_VIEW_APP_WAIT_MS = 1_000;
/** Above the row-tree client's 1,500 ms request deadline, so a cold worker can still answer. */
export const WORKSPACE_VIEW_TAIL_ABORT_MS = 1_600;

/**
 * The early script of the static workspace view (T3 #5971, Option C step 4), inline on a phone's
 * `/workspace/<id>` page. Outside a phone layout (a coarse pointer and PHONE_CHROME_WIDTHS), on a
 * hidden tab or with the left sidebar saved as expanded, it loads the app at once. Else it POSTs
 * workspace.history.tail with the app's token (the `?token=` parameter, else the saved one, as
 * API.tsx reads them), and the app loads two frames after the view paints, or after
 * WORKSPACE_VIEW_APP_WAIT_MS. A null tail, a row it cannot draw, a 401 or an abort give no view.
 * It inserts the view only while the app has not started (main.tsx sets the attribute right before
 * its first render), so a late answer never covers the live app. A resize out of the phone widths
 * and a failed app module remove the view. The app removes it at handoff (workspaceViewHandoff).
 * SECURITY AUDIT: the page carries no request or workspace data. The script reads the workspace id
 * from the URL and uses it only in the POST body and an attribute; buildWorkspaceView draws the
 * tail with text nodes and allow-listed trees only (viewBuilder.ts).
 */
export const WORKSPACE_VIEW_EARLY_SCRIPT = `(() => {
  const m = /\\/workspace\\/([^/]+)$/.exec(location.pathname);
  let loaded = false;
  // A failed app (an unusable module list, a module error) can come before a late tail answer,
  // which then must not insert a view that nothing would remove.
  let failed = false;
  const view = () => document.getElementById(${q(WORKSPACE_VIEW_ID)});
  const fail = () => { failed = true; view()?.remove(); };
  // The app's modules download while the tail is in flight; only running them waits. Else a page
  // with no view would start its downloads one tail round trip late (measured: LCP +218 ms on a
  // tool-heavy seed, +32 ms with these preloads). Low priority, so the tail answer comes first.
  let list = null;
  const preload = () => {
    if (list !== null) return list;
    try {
      list = JSON.parse(document.getElementById(${q(FIRST_RUN_MODULES_ID)}).textContent);
      if (typeof list.script !== "string" || !Array.isArray(list.preload)) throw new Error("bad list");
    } catch (error) {
      fail();
      console.error("workspace view: no usable module list", error);
      return (list = false);
    }
    for (const href of [...list.preload, list.script]) {
      const link = document.createElement("link");
      Object.assign(link, { rel: "modulepreload", crossOrigin: "", fetchPriority: "low", href });
      document.head.appendChild(link);
    }
    return list;
  };
  const loadApp = () => {
    if (loaded) return;
    loaded = true;
    if (!preload()) return;
    const script = document.createElement("script");
    Object.assign(script, { type: "module", crossOrigin: "", src: list.script });
    script.addEventListener("error", fail);
    const start = () => document.head.appendChild(script);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  };
  const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const phone = () => innerWidth >= ${PHONE_CHROME_WIDTHS.min} && innerWidth <= ${PHONE_CHROME_WIDTHS.max};
  let workspaceId = null;
  try { workspaceId = m && decodeURIComponent(m[1]); } catch {}
  if (!workspaceId || document.visibilityState === "hidden" || !phone() || !matchMedia("(pointer: coarse)").matches ||
      read(${q(LEFT_SIDEBAR_COLLAPSED_KEY)}) === "false") return loadApp();
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && loadApp());
  addEventListener("resize", () => phone() || view()?.remove());
  ${VIEW_BUILDER_SOURCE}
  const SKELETON = ${PHONE_CHROME_JSON};
  preload();
  const token = new URLSearchParams(location.search).get("token")?.trim() || read(${q(AUTH_TOKEN_KEY)});
  const headers = { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) };
  const abort = new AbortController();
  const abortTimer = setTimeout(() => abort.abort(), ${WORKSPACE_VIEW_TAIL_ABORT_MS});
  const appTimer = setTimeout(loadApp, ${WORKSPACE_VIEW_APP_WAIT_MS});
  const url = new URL("api/workspace/history/tail", document.baseURI);
  fetch(url, { method: "POST", headers, body: JSON.stringify({ workspaceId }), signal: abort.signal })
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
    .then((tail) => {
      clearTimeout(abortTimer);
      const insert = () => {
        const built = failed || document.documentElement.hasAttribute(${q(WORKSPACE_VIEW_APP_STARTED_ATTR)}) || !phone()
          ? null : buildWorkspaceView(SKELETON, tail, Date.now());
        if (!built) return loadApp();
        const root = document.createElement("div");
        root.id = ${q(WORKSPACE_VIEW_ID)};
        root.setAttribute(${q(WORKSPACE_VIEW_WORKSPACE_ATTR)}, workspaceId);
        root.setAttribute("inert", "");
        root.setAttribute("style", "position:fixed;inset:0;z-index:1500;overflow:hidden");
        root.append(built);
        document.body.appendChild(root);
        const log = root.querySelector("[data-transcript-message]")?.closest(".overflow-y-auto");
        if (log) log.scrollTop = log.scrollHeight; // the live view opens at the newest row
        clearTimeout(appTimer);
        requestAnimationFrame(() => requestAnimationFrame(loadApp));
      };
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", insert);
      else insert();
    })
    .catch(loadApp);
})();`;

// An inline script ends at the first "</script" and changes parse state at "<!--" or "<script".
// The skeleton JSON escapes "<" (\u003c), and no line of the script or the builder may hold one.
assert(!/<\/script|<!--|<script/i.test(WORKSPACE_VIEW_EARLY_SCRIPT), "unsafe inline script");
