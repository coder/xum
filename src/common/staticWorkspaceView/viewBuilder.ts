import { STATIC_TREE_ATTRIBUTE_VALUES, STATIC_TREE_CLASSES, STATIC_TREE_TAGS } from "./tree";

/** JSON that is safe inside an inline <script>: `<` cannot close it. */
const inline = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");
const VALUE_SOURCES = Object.entries(STATIC_TREE_ATTRIBUTE_VALUES).map(([k, re]) => [k, re.source]);

/**
 * The static workspace view's page-side builder (T3 #5971, Option C step 4). PR5b-2's early script
 * inlines this source; nothing loads it yet. It is a string, as FIRST_RUN_EARLY_SCRIPT is, so no
 * compiler rewrites it into code that needs helpers the page lacks. The tests run this string.
 *
 * It defines `buildWorkspaceView(skeleton, tail, now)`: the phone chrome (phoneChrome.generated.ts)
 * with the tail's rows, or null when a row cannot be drawn (a tool call, math, an "other" row, or a
 * tree that fails checkTree). Text rows only: tool rows are a later step.
 * Slots: title gets the tail's title, each row its tree, timestamp and model label. The others
 * (headerActions, mode, model, footer, the row actions) get an empty box of the live content's size
 * at 360-480 px on a coarse pointer (measured: 44 px touch targets, 228 px for five row actions), so
 * the header, the composer, the footer and each row's meta line keep their live height and wrap.
 *
 * SECURITY AUDIT: the tail is attacker-controlled (titles, transcript text, model strings). It
 * builds every node with createElement, createElementNS and text nodes only, never innerHTML,
 * outerHTML, insertAdjacentHTML or a template parse. checkTree is the page side of
 * validateStaticTree (tree.ts), as the tail schema requires: a row tree's tags, attributes and
 * classes come from the same allow-list. Every other attribute comes from the trusted capture or
 * from constants here.
 */
export const VIEW_BUILDER_SOURCE = `const buildWorkspaceView = (() => {
  const TAGS = ${inline(STATIC_TREE_TAGS)};
  const VALUES = new Map(${inline(VALUE_SOURCES)}.map(([k, s]) => [k, new RegExp(s)]));
  const CLASSES = new Set(${inline([...STATIC_TREE_CLASSES])});
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const allowed = (tag, name, value) =>
    typeof value === "string" && TAGS[tag].includes(name) &&
    (!VALUES.has(name) || VALUES.get(name).test(value)) &&
    (name !== "class" || value.split(" ").every((c) => CLASSES.has(c)));
  const checkTree = (n, depth) => typeof n === "string" || (
    Array.isArray(n) && n.length >= 2 && depth <= 32 && typeof n[0] === "string" && own(TAGS, n[0]) &&
    typeof n[1] === "object" && n[1] !== null && !Array.isArray(n[1]) &&
    Object.keys(n[1]).every((k) => allowed(n[0], k, n[1][k])) &&
    n.slice(2).every((c) => checkTree(c, depth + 1)));
  const SVG = "http://www.w3.org/2000/svg";
  const build = (n, svg, fill) => {
    if (typeof n === "string") return [document.createTextNode(n)];
    if (!Array.isArray(n)) return fill(n.slot);
    const inSvg = svg || n[0] === "svg";
    const e = inSvg ? document.createElementNS(SVG, n[0]) : document.createElement(n[0]);
    for (const k of Object.keys(n[1])) e.setAttribute(k, n[1][k]);
    for (let i = 2; i < n.length; i++) e.append(...build(n[i], inSvg, fill));
    return [e];
  };
  const text = (s) => [document.createTextNode(s)];
  const box = (w, h, inline) => {
    const e = document.createElement("span");
    e.setAttribute("style", "display:" + (inline ? "inline-block" : "block") + ";width:" + w + "px;height:" + h + "px");
    return [e];
  };
  const SPACERS = { headerActions: () => box(0, 44), footer: () => box(0, 44), model: () => box(154, 44, true) };
  const el = (tag, cls, kids) => {
    const e = document.createElement(tag);
    e.setAttribute("class", cls);
    e.append(...kids);
    return e;
  };
  // formatTimestamp (src/browser/utils/ui/dateTime.ts), the live row's format.
  const time = (ms, now) => {
    const d = new Date(ms);
    const n = new Date(now);
    const today = d.getDate() === n.getDate() && d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear();
    const day = today ? {} : { month: "short", day: "numeric" };
    return d.toLocaleTimeString("en-US", { ...day, hour: "numeric", minute: "2-digit", hour12: true });
  };
  // ModelDisplay: the provider icon's box (empty, so the label keeps its place), the label, the route.
  const ICON = "mr-[0.3em] inline-block h-[1.1em] w-[1.1em] align-[-0.19em]";
  const model = (m) => [
    el("span", ICON, []),
    el("span", "inline", text(m.label)),
    ...(m.via ? [el("span", "text-muted ml-1 inline", text("via " + m.via))] : []),
  ];
  // A row tree is the live markdown-content div around one content div; the slot is that content.
  const content = (tree) =>
    Array.isArray(tree) && tree.length === 3 && Array.isArray(tree[2]) && checkTree(tree, 0) ? tree[2].slice(2) : null;
  const typed = (v, t) => v === null || typeof v === t;
  return (skeleton, tail, now) => {
    if (!tail || typeof tail.title !== "string" || !Array.isArray(tail.rows) || tail.rows.length === 0) return null;
    const rows = [];
    for (const row of tail.rows) {
      const md = row && (row.role === "user" || row.role === "assistant") ? content(row.tree) : null;
      const meta = md && typed(row.timestamp, "number") && (row.model === null ||
        (typeof row.model === "object" && typeof row.model.label === "string" && typed(row.model.via, "string")));
      if (!meta) return null;
      const slots = {
        md: () => md.flatMap((n) => build(n, false, () => [])),
        // MessageWindow draws no time for a missing or zero timestamp.
        ts: () => (row.timestamp ? text(time(row.timestamp, now)) : []),
        model: () => (row.role === "assistant" && row.model ? model(row.model) : []),
        actions: () => box(228, 44, true),
      };
      rows.push(...build(row.role === "user" ? skeleton.user : skeleton.assistant, false, (s) => slots[s]()));
    }
    const chrome = { title: () => text(tail.title), rows: () => rows };
    const fill = (s) => (own(chrome, s) ? chrome[s]() : own(SPACERS, s) ? SPACERS[s]() : []);
    return build(skeleton.chrome, false, fill)[0];
  };
})();
`;
