/**
 * THROWAWAY prototype (T3 #5971, Option C step 4, P2). Not a product file: it lives only on the
 * branches proto/t3-c4-p2-fetch and proto/t3-c4-p2-embed.
 *
 * A static first view of the seeded workspace page (`/workspace/<id>`), drawn by an inline early
 * script before the app JS loads (JS-after-paint, as #6600 does for "/"). Two data paths:
 * - "fetch": the script POSTs api/workspace/getInfo and api/workspace/getFullReplay itself.
 * - "embed": the server embeds a bounded tail in a `type="application/json"` script.
 * Phones only (coarse pointer, <= 480 px, collapsed left sidebar): the chrome tree is a capture of
 * the live 412 px touch page (scripts/perf/protoP2Chrome.ts).
 *
 * SECURITY AUDIT: transcript text is attacker-controlled (repo content, model and tool output).
 * The renderer builds every node with createElement/createElementNS and puts text only in text
 * nodes (`textContent`, `append(string)`), never through innerHTML, outerHTML, insertAdjacentHTML or
 * a template parse. Attribute values come only from the trusted capture tree, never from data.
 * Links and any markdown it does not support make it show no view at all. The embedded JSON goes
 * through escapeJsonForHtmlScript (`<` as \u003c), so it cannot close its <script>.
 */
import { AUTH_TOKEN_KEY, LEFT_SIDEBAR_COLLAPSED_KEY } from "@/common/constants/storage";
import type { MuxMessage } from "@/common/types/message";
import { WORKSPACE_VIEW_TREE_JSON } from "./workspaceFirstViewChrome";

export type WorkspaceViewMode = "fetch" | "embed" | "off";

/** Default per branch: proto/t3-c4-p2-fetch says "fetch", proto/t3-c4-p2-embed says "embed". */
const BRANCH_DEFAULT: WorkspaceViewMode = "fetch";

/** Read once at server start. XUM_PROTO_P2_VIEW=fetch|embed|off overrides the branch default. */
export function readWorkspaceViewMode(env: NodeJS.ProcessEnv): WorkspaceViewMode {
  const v = env.XUM_PROTO_P2_VIEW?.trim();
  return v === "fetch" || v === "embed" || v === "off" ? v : BRANCH_DEFAULT;
}

/** WorkspaceMenuBar's PHONE_HEADER_QUERY width: the layout the chrome tree was captured in. */
const PHONE_MAX_WIDTH_PX = 480;

export const WORKSPACE_VIEW_ID = "xum-pre-ws";
export const WORKSPACE_VIEW_DATA_ID = "xum-pre-ws-data";
/** Same id as "/" (FIRST_RUN_MODULES_ID), so scripts/perf/firstLoadJs.ts counts it the same way. */
export const WORKSPACE_VIEW_MODULES_ID = "xum-pre-modules";

/** Rows the view draws: the newest 40 of the epoch. */
export const WORKSPACE_VIEW_MAX_ROWS = 40;

export interface WorkspaceViewRow {
  id: string;
  role: "user" | "assistant";
  /** null: the row has parts the view cannot draw, so the script shows no view. */
  text: string | null;
  ts: number | null;
  /** The raw model string, e.g. "anthropic:claude-sonnet-4-5". */
  model: string | null;
}

export interface WorkspaceViewData {
  workspaceId: string;
  title: string;
  project: string;
  rows: WorkspaceViewRow[];
}

/** The embed variant's server-side mapping (the fetch variant does the same in the browser). */
export function toWorkspaceViewRows(messages: readonly MuxMessage[]): WorkspaceViewRow[] {
  return messages.slice(-WORKSPACE_VIEW_MAX_ROWS).map((m) => {
    const drawable =
      (m.role === "user" || m.role === "assistant") &&
      m.metadata?.synthetic !== true &&
      m.parts.length > 0 &&
      m.parts.every((p) => p.type === "text");
    return {
      id: m.id,
      role: m.role === "user" ? "user" : "assistant",
      text: drawable ? m.parts.map((p) => (p.type === "text" ? p.text : "")).join("") : null,
      ts: m.metadata?.timestamp ?? null,
      model: m.metadata?.model ?? null,
    };
  });
}

/**
 * The inline early script. Steps:
 * 1. Not a `/workspace/<id>` URL, a hidden tab, a wide window, or a saved expanded sidebar: load the
 *    app at once with no view.
 * 2. Get the data (embedded JSON, or two POSTs with a 1,000 ms abort). Missing, 401, error, or a
 *    row it cannot draw: load the app at once with no view.
 * 3. On DOMContentLoaded, build the view in `#xum-pre-ws` (inert, fixed above the app), scroll its
 *    transcript to the bottom, and load the app two frames later.
 * 4. Handoff: a MutationObserver removes the view in the same task in which the live transcript
 *    (`[data-loaded=true]` with the last row id) appears in #root. A failed module script removes it.
 *    PROTOTYPE SHORTCUT: a 15 s timer removes it too (auth modal, startup error). Production
 *    replaces it with app-driven removal paths, as for "/".
 */
export function workspaceViewEarlyScript(mode: "fetch" | "embed"): string {
  return `(() => {
  const m = /\\/workspace\\/([^/]+)$/.exec(location.pathname);
  let loaded = false;
  const view = () => document.getElementById(${JSON.stringify(WORKSPACE_VIEW_ID)});
  const loadApp = () => {
    if (loaded) return;
    loaded = true;
    let list;
    try {
      list = JSON.parse(document.getElementById(${JSON.stringify(WORKSPACE_VIEW_MODULES_ID)}).textContent);
    } catch (error) {
      view()?.remove();
      return console.error("workspace view: no usable module list", error);
    }
    for (const href of list.preload) {
      const link = document.createElement("link");
      Object.assign(link, { rel: "modulepreload", crossOrigin: "", href });
      document.head.appendChild(link);
    }
    const script = document.createElement("script");
    Object.assign(script, { type: "module", crossOrigin: "", src: list.script });
    script.addEventListener("error", () => view()?.remove());
    const start = () => document.head.appendChild(script);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  };
  const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  // The chrome tree is the phone layout (pointer: coarse, <= 480 px, WorkspaceMenuBar PHONE_HEADER_QUERY).
  // Any other layout class (desktop, a narrow desktop window, a tablet) gets no view.
  if (!m || document.visibilityState === "hidden" || innerWidth > ${PHONE_MAX_WIDTH_PX} ||
      !matchMedia("(pointer: coarse)").matches ||
      read(${JSON.stringify(LEFT_SIDEBAR_COLLAPSED_KEY)}) === "false") return loadApp();
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && loadApp());
  const workspaceId = decodeURIComponent(m[1]);

  // ---- renderer: createElement / createElementNS / text nodes only (SECURITY AUDIT above) ----
  const T = ${WORKSPACE_VIEW_TREE_JSON};
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs) => {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };
  const build = (n, svg, slots) => {
    if (typeof n === "string") return document.createTextNode(n);
    if (!Array.isArray(n)) return slots[n.s] ? slots[n.s]() : document.createTextNode("");
    const isSvg = svg || n[0] === "svg";
    const e = isSvg ? document.createElementNS(NS, n[0]) : document.createElement(n[0]);
    if (n[1]) for (const k in n[1]) e.setAttribute(k, n[1][k]);
    for (let i = 2; i < n.length; i++) e.appendChild(build(n[i], isSvg, slots));
    return e;
  };
  // Markdown the subset cannot draw like the live renderer throws: then no view at all, not a mismatch.
  const unsupported = (what) => { throw new Error("unsupported markdown: " + what); };
  const INLINE_NO = /\\*\\*|__|~~|\\]\\(|<[a-z/!]|&[#\\w]+;|https?:\\/\\/|www\\.|(^|\\s)[*_]\\S/i;
  const BLOCK_NO = /^(\\s{4}| {0,3}(#|>|\\||<|-{3,}|={3,}|\\*{3,})|\\s+([-*+]|\\d+[.)])\\s)/;
  const inline = (parent, text) => {
    const parts = text.split("\`");
    if (parts.length % 2 === 0) unsupported("unclosed code span");
    parts.forEach((p, i) => {
      if (i % 2 === 0 && INLINE_NO.test(p)) unsupported("inline");
      if (i % 2) { const c = document.createElement("code"); c.textContent = p; parent.append(c); }
      else if (p) parent.append(p);
    });
  };
  const codeBlock = (code, lang) => {
    const lines = code.split("\\n").filter((l, i, a) => i < a.length - 1 || l !== "");
    const wrap = el("div", { class: "code-block-wrapper" + (lines.length === 1 ? " code-block-single-line" : "") });
    const box = el("div", { class: "code-block-container", "data-code-language": lang });
    lines.forEach((line, i) => {
      const num = el("div", { class: "line-number" });
      num.textContent = String(i + 1);
      const row = el("div", { class: "code-line" });
      const c = document.createElement("code");
      c.textContent = line;
      row.appendChild(c);
      box.append(num, row);
    });
    wrap.append(box, build(T.copy, false, {}));
    return wrap;
  };
  const OL = /^\\d+[.)]\\s+/, UL = /^[-*+]\\s+/, FENCE = /^ {0,3}(\`\`\`|~~~)\\s*([\\w+-]*)\\s*$/;
  const markdown = (src) => {
    const lines = src.replace(/\\r\\n?/g, "\\n").split("\\n");
    const frag = document.createDocumentFragment();
    for (let i = 0; i < lines.length; ) {
      const fence = FENCE.exec(lines[i]);
      if (fence) {
        // No language: a <pre> block. mermaid: a diagram. Both render through other components.
        if (!fence[2] || fence[2] === "mermaid") unsupported("fence " + fence[2]);
        const code = [];
        for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) code.push(lines[i]);
        i++;
        frag.append(codeBlock(code.join("\\n"), fence[2]));
      } else if (!lines[i].trim()) i++;
      else if (OL.test(lines[i]) || UL.test(lines[i])) {
        const ordered = OL.test(lines[i]), re = ordered ? OL : UL;
        const list = el(ordered ? "ol" : "ul", {
          class: "list-inside " + (ordered ? "list-decimal" : "list-disc") + " whitespace-normal [li_&]:pl-6",
          "data-streamdown": ordered ? "ordered-list" : "unordered-list",
        });
        while (i < lines.length && re.test(lines[i])) {
          const li = el("li", { class: "py-1 [&>p]:inline", "data-streamdown": "list-item" });
          inline(li, lines[i++].replace(re, ""));
          list.append(li);
        }
        frag.append(list);
      } else {
        if (BLOCK_NO.test(lines[i])) unsupported("block");
        const buf = [];
        while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !OL.test(lines[i]) && !UL.test(lines[i])) {
          if (buf.length && BLOCK_NO.test(lines[i])) unsupported("block");
          buf.push(lines[i++]);
        }
        const p = document.createElement("p");
        inline(p, buf.join("\\n"));
        frag.append(p);
      }
    }
    return frag;
  };
  // formatTimestamp (src/browser/utils/ui/dateTime.ts): "8:13 PM" today, else "Oct 23, 8:13 PM", en-US.
  // Written out by hand: the first Intl formatter costs tens of ms at 4x CPU (ICU setup).
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const stamp = (ts) => {
    if (ts == null) return "";
    const d = new Date(ts), h = d.getHours();
    const time = ((h % 12) || 12) + ":" + String(d.getMinutes()).padStart(2, "0") + " " + (h < 12 ? "AM" : "PM");
    return d.toDateString() === new Date().toDateString() ? time : MONTHS[d.getMonth()] + " " + d.getDate() + ", " + time;
  };
  // PROTOTYPE stand-in for formatModelStringForDisplay (src/common/utils/ai/modelDisplay.ts):
  // "anthropic:claude-sonnet-4-5" -> "Sonnet 4.5", else the id after the provider. The captured icon
  // is Anthropic's. Production: the tail procedure sends the server-formatted label and provider.
  const modelLabel = (model) => {
    const id = String(model ?? "").replace(/^[\\w-]+:/, "");
    const c = /^claude-([a-z]+)-(\\d+)(?:-(\\d))?(?:-|$)/.exec(id);
    return c ? c[1][0].toUpperCase() + c[1].slice(1) + " " + c[2] + (c[3] ? "." + c[3] : "") : id;
  };
  const draw = (data) => {
    performance.mark("xum-pre-ws:start");
    const rows = () => {
      performance.mark("xum-pre-ws:rows");
      const f = document.createDocumentFragment();
      for (const r of data.rows) f.append(build(r.role === "user" ? T.user : T.assistant, false, {
        md: () => markdown(r.text),
        ts: () => document.createTextNode(stamp(r.ts)),
        model: () => document.createTextNode(modelLabel(r.model)),
      }));
      performance.measure("xum-pre-ws:rows", "xum-pre-ws:rows");
      return f;
    };
    const root = el("div", { id: ${JSON.stringify(WORKSPACE_VIEW_ID)}, inert: "", style: "position:fixed;inset:0;z-index:1500;overflow:hidden" });
    root.appendChild(build(T.chrome, false, {
      title: () => document.createTextNode(data.title),
      project: () => document.createTextNode(data.project),
      rows,
    }));
    performance.mark("xum-pre-ws:built");
    document.body.appendChild(root);
    performance.measure("xum-pre-ws:build", "xum-pre-ws:start", "xum-pre-ws:built");
    performance.measure("xum-pre-ws:render", "xum-pre-ws:start");
  };
  // The live app opens at the bottom. In the first frame, not in the build task: the layout this
  // read forces is the one the frame needs anyway, and the build task stays short.
  const scrollToBottom = () => {
    performance.mark("xum-pre-ws:layout");
    const scroller = view()?.querySelector('[class*="@container/transcript"]');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    performance.measure("xum-pre-ws:layout", "xum-pre-ws:layout");
  };
  const handoff = (lastId) => {
    const done = () => {
      const live = document.querySelector('#root [data-testid=message-window][data-loaded="true"]');
      if (!live || !live.querySelector('[data-message-id="' + CSS.escape(lastId) + '"]')) return false;
      view()?.remove();
      performance.mark("xum-pre-ws:handoff");
      return true;
    };
    const mo = new MutationObserver(() => done() && mo.disconnect());
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-loaded"] });
    setTimeout(() => { mo.disconnect(); view()?.remove(); }, 15000); // PROTOTYPE SHORTCUT, see above
  };
  const show = (data) => {
    if (loaded || !data || data.workspaceId !== workspaceId || !Array.isArray(data.rows) || data.rows.length === 0 ||
        data.rows.some((r) => typeof r.text !== "string")) return loadApp();
    const go = () => {
      if (loaded) return;
      try { draw(data); } catch (error) { view()?.remove(); console.error("workspace view:", error); return loadApp(); }
      handoff(data.rows[data.rows.length - 1].id);
      requestAnimationFrame(() => { scrollToBottom(); requestAnimationFrame(loadApp); });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go);
    else go();
  };
${mode === "embed" ? EMBED_READ : FETCH_READ}
})();`;
}

const EMBED_READ = `  let data = null;
  try { data = JSON.parse(document.getElementById(${JSON.stringify(WORKSPACE_VIEW_DATA_ID)})?.textContent ?? "null"); } catch {}
  show(data);`;

// getFullReplay is unbounded (the whole epoch): production needs a bounded tail procedure.
const FETCH_READ = `  const token = new URLSearchParams(location.search).get("token")?.trim() || read(${JSON.stringify(AUTH_TOKEN_KEY)});
  const headers = { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 1000);
  const post = (route) =>
    fetch(new URL("api/workspace/" + route, document.baseURI), {
      method: "POST", headers, body: JSON.stringify({ workspaceId }), signal: abort.signal,
    }).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); });
  Promise.all([post("getInfo"), post("getFullReplay")])
    .then(([info, events]) => {
      clearTimeout(timer);
      if (!info || !Array.isArray(events)) return loadApp();
      const rows = events.filter((e) => e && e.type === "message").slice(-${WORKSPACE_VIEW_MAX_ROWS}).map((m) => ({
        id: m.id,
        role: m.role === "user" ? "user" : "assistant",
        text: (m.role === "user" || m.role === "assistant") && m.metadata?.synthetic !== true &&
          Array.isArray(m.parts) && m.parts.length > 0 && m.parts.every((p) => p.type === "text")
          ? m.parts.map((p) => p.text).join("") : null,
        ts: m.metadata?.timestamp ?? null,
        model: m.metadata?.model ?? null,
      }));
      show({ workspaceId, title: info.title || info.name, project: info.projectName, rows });
    })
    .catch(loadApp);`;
