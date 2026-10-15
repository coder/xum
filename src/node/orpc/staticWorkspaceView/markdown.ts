/**
 * The static workspace view's markdown subset (T3 #5971, Option C step 4). Not wired in yet: the
 * early script of a later PR draws the newest transcript rows (workspace.history.tail) with it
 * before the app JS loads, and the live renderer replaces them.
 *
 * It draws what the live renderer (MarkdownCore, MarkdownComponents) draws for paragraphs, inline
 * code, flat lists and fenced code with a language (plain `.line-number`/`.code-line` rows, as
 * before Shiki highlights them). For anything else it returns null, and the caller shows no view:
 * a wrong view is worse than none, because the live paint would replace it.
 */

/**
 * Markdown the subset cannot draw like the live renderer. Block rules run on each line outside a
 * fence, inline rules on the text outside code spans. The renderer and its tests share this list.
 */
export const UNSUPPORTED_MARKDOWN = {
  block: {
    setextUnderline: /^(=+|-+)[ \t]*$/, // also a `---` thematic break
    emptyListItem: /^([-*+]|\d{1,9}[.)])[ \t]*$/,
    indent: /^[ \t]/, // indented code, nested lists, list continuations
    hardBreak: / {2,}$/,
  },
  inline: {
    // An allow list, not a deny list: every other character can start markdown (headings, quotes,
    // tables, emphasis, ~strike~, links, HTML, entities, escapes, math, $skill links), so a form
    // nobody listed still gets no view. Tabs fall out too (a list marker may end with one).
    markup: /[^\p{L}\p{N} .,;:!?'"()/%+=_\n-]/u,
    emphasis: /(^|\W)_|_(\W|$)/, // `_` only inside a word, as in snake_case
    autolink: /https?:\/\/|www\./i,
  },
  fence: {
    // Math draws KaTeX and mermaid a diagram. The live view adds a Run button to shell blocks when
    // a terminal can open (MarkdownComponents RUNNABLE_SHELL_LANGUAGES).
    language: /^(math|mermaid|bash|sh|shell|zsh|fish|powershell|pwsh|cmd|batch)$/i,
  },
} as const;

const toJs = (rules: Record<string, RegExp>) =>
  `[${Object.values(rules)
    .map((re) => `new RegExp(${JSON.stringify(re.source)}, ${JSON.stringify(re.flags)})`)
    .join(", ")}]`;

/**
 * A browser function source, `(doc, text, breaks) => DocumentFragment | null`, for the early
 * script. `breaks` draws soft line breaks as <br>, as user rows do (preserveLineBreaks).
 * SECURITY AUDIT: `text` is transcript text (attacker-controlled: repo content, model and tool
 * output). Every node comes from createElement, and text goes only into text nodes (`append` of a
 * string, `textContent`). No HTML parsing anywhere: noHtmlSinks.test.ts fails on any sink in this
 * folder. Attribute values are constants or the fence language, which must match `[\w+-]+`.
 */
export const RENDER_MARKDOWN_JS = renderMarkdownJs(UNSUPPORTED_MARKDOWN);

/** The source for a rule set. Only tests pass another set (to prove each rule decides its case). */
export function renderMarkdownJs(rules: typeof UNSUPPORTED_MARKDOWN): string {
  return `(doc, text, breaks) => {
  const BLOCK = ${toJs(rules.block)};
  const INLINE = ${toJs(rules.inline)};
  const [FENCE_LANGUAGE] = ${toJs(rules.fence)};
  const FENCE = /^(\`{3,}|~{3,})(.*)$/, OL = /^(\\d{1,9})([.)]) /, UL = /^([-*+]) /;
  // A block form inside a list item (a heading, a nested list, a fence, extra indentation).
  const nested = (s) => [...BLOCK, FENCE, OL, UL].some((re) => re.test(s));
  const SVG = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, text, ns) => {
    const node = ns ? doc.createElementNS(ns, tag) : doc.createElement(tag);
    for (const name in attrs) node.setAttribute(name, attrs[name]);
    if (text != null) node.textContent = text;
    return node;
  };
  // Text with \`code\` spans, or false when the live renderer would draw it differently.
  const inline = (parent, value) => {
    const parts = value.split("\`");
    if (parts.length % 2 === 0) return false;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i % 2 === 0) {
        if (INLINE.some((re) => re.test(part))) return false;
        part.split("\\n").forEach((piece, j) => {
          if (j > 0) parent.append(breaks ? el("br", {}) : "", "\\n");
          if (piece) parent.append(piece);
        });
      } else {
        if (!part || part.includes("\\n") || (part.startsWith(" ") && part.endsWith(" "))) return false;
        parent.append(el("code", {}, part));
      }
    }
    return true;
  };
  const codeBlock = (lines, language) => {
    const single = lines.length === 1 ? " code-block-single-line" : "";
    const wrapper = el("div", { class: "code-block-wrapper" + single });
    const container = el("div", { class: "code-block-container", "data-code-language": language });
    lines.forEach((line, i) => {
      const row = el("div", { class: "code-line" });
      row.append(el("code", {}, line));
      container.append(el("div", { class: "line-number" }, String(i + 1)), row);
    });
    // CopyButton with CopyIcon (src/browser/components/CopyButton, icons/CopyIcon).
    const button = el("button", { class: "copy-button code-copy-button", "aria-label": "Copy to clipboard" });
    const svg = el("svg", { xmlns: SVG, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2",
      "stroke-linecap": "round", "stroke-linejoin": "round", class: "copy-icon" }, null, SVG);
    svg.append(el("rect", { x: "9", y: "9", width: "13", height: "13", rx: "2", ry: "2" }, null, SVG),
      el("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" }, null, SVG));
    button.append(svg);
    wrapper.append(container, button);
    return wrapper;
  };
  // The live renderer (normalizeMarkdown) also breaks lines at U+2028, U+2029 and U+0085.
  const lines = text.replace(/\\r\\n?|[\\u2028\\u2029\\u0085]/g, "\\n").split("\\n");
  const out = doc.createDocumentFragment();
  let list = null, blankAfterItem = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { blankAfterItem = list !== null; continue; }
    const fence = FENCE.exec(line);
    const language = fence ? fence[2].trim() : "";
    if (fence && /^[\\w+-]+$/.test(language)) {
      if (FENCE_LANGUAGE.test(language)) return null;
      // A closing fence: up to 3 spaces, the same character, at least as long, nothing else.
      const closes = (l) => {
        const m = /^ {0,3}(\`+|~+)[ \\t]*$/.exec(l);
        return m !== null && m[1][0] === fence[1][0] && m[1].length >= fence[1].length;
      };
      const code = [];
      for (i++; i < lines.length && !closes(lines[i]); i++) code.push(lines[i]);
      if (code.length === 0) return null;
      out.append(codeBlock(code, language));
      list = null;
      continue;
    }
    if (BLOCK.some((re) => re.test(line))) return null;
    const ol = OL.exec(line), ul = UL.exec(line);
    if (ol || ul) {
      const kind = ol ? "ordered" : "unordered", marker = ol ? ol[2] : ul[1];
      // A loose list, or a new marker (CommonMark starts a sibling list).
      if (list && (list.marker !== marker || blankAfterItem)) return null;
      if (!list) {
        if (ol && ol[1] !== "1") return null; // the live list would carry a start attribute
        const cls = "list-inside " + (ol ? "list-decimal" : "list-disc") + " whitespace-normal [li_&]:pl-6";
        list = { marker, node: el(ol ? "ol" : "ul", { class: cls, "data-streamdown": kind + "-list" }) };
        out.append(list.node);
      }
      const item = el("li", { class: "py-1 [&>p]:inline", "data-streamdown": "list-item" });
      const content = line.slice((ol || ul)[0].length);
      if (nested(content) || !inline(item, content.trimEnd())) return null;
      list.node.append(item);
      blankAfterItem = false;
      continue;
    }
    if (list && !blankAfterItem) return null; // a lazy continuation line of a list item
    list = null;
    const para = [line.trimEnd()];
    while (i + 1 < lines.length && lines[i + 1].trim() && !FENCE.test(lines[i + 1]) && !OL.test(lines[i + 1]) && !UL.test(lines[i + 1])) {
      if (BLOCK.some((re) => re.test(lines[i + 1]))) return null;
      para.push(lines[++i].trimEnd());
    }
    const p = el("p", {});
    if (!inline(p, para.join("\\n"))) return null;
    out.append(p);
  }
  return out.childNodes.length > 0 ? out : null;
}`;
}
