import type { CSSProperties, ReactNode } from "react";
import React, { useContext, useEffect, useId, useRef, useState } from "react";
import katex from "katex";
import { render as renderPele, type MathMarkup, type RenderOptions } from "pele";
import assert from "@/common/utils/assert";
import { StreamingContext } from "./StreamingContext";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { isDesktopViewportFocused } from "@/browser/utils/ui/keybinds";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useResizeObserver } from "@/browser/hooks/useResizeObserver";
import { transcriptMermaidSources } from "@/browser/utils/messages/transcriptQuoteAttributes";
import { MERMAID_DIAGRAM_ZOOM_KEY } from "@/common/constants/storage";
import {
  MERMAID_BUTTON_HEIGHT,
  MERMAID_BUTTON_INSET,
  MERMAID_CONTAINER_STYLE,
  MERMAID_FRAME_STYLE,
  MERMAID_PENDING_STYLE,
  MERMAID_PENDING_TEXT,
} from "./MermaidPendingFrame";

const DEFAULT_ZOOM = 1;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;
// Below this container width Pele may turn wide layouts vertical, so the diagram also drops
// the height clamp that would shrink a tall layout until its labels are unreadable.
const NARROW_DIAGRAM_WIDTH = 640;

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

/** What Pele emits in one namespace. Names are lowercase, like the HTML parser makes them. */
interface PeleNamespace {
  elements: ReadonlySet<string>;
  /** HTML integration points: the HTML parser would build their element children as HTML. */
  textOnlyElements: ReadonlySet<string>;
  /** Their values must pass isPeleCss. Most are presentation attributes, which are CSS. */
  cssAttributes: ReadonlySet<string>;
  /** Ids and id lists. Each id must start with the diagram's idPrefix. */
  idAttributes: ReadonlySet<string>;
  /** Names and label text, which the browser never reads as CSS. */
  textAttributes: ReadonlySet<string>;
}

/**
 * Everything Pele 1.9 emits with peleRenderOptions. The sanitizer removes every other element and
 * attribute, every value that fails isPeleCss, and every id outside the diagram's idPrefix. A
 * blocklist leaks: <set> can write a javascript: href, the HTML parser ends the <svg> at an
 * SVG-namespace <p>, and fill, mask or marker-end can load a url(). Mermaid.sanitization.test.ts
 * fails when the sanitizer removes anything from a sample of every diagram type, so run it after
 * a Pele or KaTeX upgrade.
 */
const PELE_OUTPUT = new Map<string | null, PeleNamespace>([
  [
    SVG_NS,
    {
      // Pele also emits <a> and <image>, but only with the links and images that
      // peleRenderOptions turns off.
      elements: new Set([
        "circle",
        "defs",
        "desc",
        "ellipse",
        "g",
        "lineargradient",
        "path",
        "polygon",
        "rect",
        "stop",
        "svg",
        "text",
        "title",
        "tspan",
      ]),
      textOnlyElements: new Set(["desc", "title"]),
      cssAttributes: new Set([
        "baseline-shift",
        "cx",
        "cy",
        "d",
        "fill",
        "fill-opacity",
        "font-family",
        "font-size",
        "font-style",
        "font-weight",
        "gradientunits",
        "height",
        "offset",
        "opacity",
        "overflow",
        "points",
        "r",
        "rx",
        "ry",
        "stop-color",
        "stroke",
        "stroke-dasharray",
        "stroke-linecap",
        "stroke-linejoin",
        "stroke-width",
        "style",
        "text-anchor",
        "text-decoration",
        "transform",
        "viewbox",
        "width",
        "x",
        "x1",
        "x2",
        "y",
      ]),
      // An id outside the diagram's idPrefix could shadow an app global such as window.api, or
      // an element the app looks up with getElementById, or another diagram's gradient.
      idAttributes: new Set(["aria-describedby", "aria-labelledby", "id"]),
      // data-id holds label text such as "feat(api): add".
      textAttributes: new Set([
        "aria-roledescription",
        "class",
        "data-icon",
        "data-id",
        "role",
        "xml:space",
        "xmlns",
      ]),
    },
  ],
  // The <div> that Pele wraps around each math label.
  [
    XHTML_NS,
    {
      elements: new Set(["div"]),
      textOnlyElements: new Set(),
      cssAttributes: new Set(["style"]),
      idAttributes: new Set(),
      textAttributes: new Set(["xmlns"]),
    },
  ],
  [
    MATHML_NS,
    {
      // KaTeX's MathML output (MathNodeType in katex/src/mathMLTree.ts), minus mglyph, which
      // loads an image. The name matters, not only the namespace: inside <mtext> the HTML parser
      // that inserts the SVG builds HTML elements, so a MathML-namespace <img> there becomes a
      // real image.
      elements: new Set([
        "math",
        "semantics",
        "annotation",
        "mrow",
        "mi",
        "mn",
        "mo",
        "mtext",
        "mspace",
        "msup",
        "msub",
        "msubsup",
        "mfrac",
        "mroot",
        "msqrt",
        "mover",
        "munder",
        "munderover",
        "mtable",
        "mtr",
        "mtd",
        "mlabeledtr",
        "menclose",
        "mstyle",
        "mpadded",
        "mphantom",
      ]),
      textOnlyElements: new Set(),
      // What KaTeX's MathML builders set (setAttribute in katex/src), minus href, which
      // `trust: false` turns off.
      cssAttributes: new Set([
        "accent",
        "accentunder",
        "columnalign",
        "columnlines",
        "columnspacing",
        "depth",
        "display",
        "displaystyle",
        "encoding",
        "fence",
        "height",
        "largeop",
        "linebreak",
        "linethickness",
        "lspace",
        "mathbackground",
        "mathcolor",
        "mathsize",
        "mathvariant",
        "maxsize",
        "minsize",
        "notation",
        "rowlines",
        "rowspacing",
        "rspace",
        "scriptlevel",
        "separator",
        "stretchy",
        "style",
        "voffset",
        "width",
      ]),
      idAttributes: new Set(),
      // A numbered environment gives its mtd cells a class.
      textAttributes: new Set(["class", "xmlns"]),
    },
  ],
]);

function peleNamespace(namespace: string | null): PeleNamespace {
  const rules = PELE_OUTPUT.get(namespace);
  assert(rules, `Pele emits no element in namespace ${String(namespace)}`);
  return rules;
}

/**
 * Lowercases A-Z only, like the HTML parser. String.toLowerCase maps the Kelvin sign U+212A to k,
 * so a name that the browser does not read as stroke would match stroke.
 */
function asciiLowerCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

// The CSS functions in Pele's output, plus the color functions a chart's styles can use.
const PELE_CSS_FUNCTIONS = new Set([
  "calc",
  "color-mix",
  "hsl",
  "hsla",
  "rgb",
  "rgba",
  "rotate",
  "translate",
  "var",
]);

/** Pele derives every id from idPrefix, such as `${idPrefix}-title` for an accTitle. */
function isDiagramId(id: string, idPrefix: string): boolean {
  return id.startsWith(`${idPrefix}-`);
}

/**
 * A CSS value that loads nothing: only printable ASCII, tab, LF and CR, no escape, comment,
 * at-rule or IE expression, and only PELE_CSS_FUNCTIONS. With an idPrefix, url(#id) may also
 * point at an element of the same diagram, as Pele's fill attribute does. A style attribute gets
 * no idPrefix: there Chromium fetches the page itself for url(#id) in background-image, cursor or
 * border-image-source.
 */
function isPeleCss(value: string, idPrefix: string | null): boolean {
  // Pele writes only ASCII in CSS. Past it, the regexes below read CSS unlike the browser: \s
  // matches &#160;, but Chromium reads url(&#160;#id) as a relative URL and requests it.
  if (/[^\t\n\r\x20-\x7e]/.test(value)) return false;
  // CSS whitespace is space, tab, LF, CR and FF, not \s.
  const rest = value.replace(
    /(?<![\w-])url\([ \t\n\r\f]*(["']?)#([\w-]+)\1[ \t\n\r\f]*\)/gi,
    (url, _quote, id: string) => (idPrefix !== null && isDiagramId(id, idPrefix) ? "" : url)
  );
  return !/\\|\/\*|@|expression/i.test(rest) && usesOnlyPeleFunctions(rest);
}

/** Every ( in css follows the name of one of PELE_CSS_FUNCTIONS. */
function usesOnlyPeleFunctions(css: string): boolean {
  // Names and single characters other than CSS whitespace, so each character is matched once. A
  // scan that restarts at every character of a run takes seconds on a 50,000-character chart, on
  // the renderer thread. Skipping whitespace allows SVG's transform syntax, as in rotate (3).
  const tokens = css.match(/[\w-]+|[^ \t\n\r\f]/g) ?? [];
  return tokens.every(
    (token, index) =>
      token !== "(" || PELE_CSS_FUNCTIONS.has(asciiLowerCase(tokens[index - 1] ?? ""))
  );
}

/** An id, or an id list such as aria-labelledby, kept only when every id is the diagram's own. */
function keptIdValue(name: string, value: string, idPrefix: string): string | null {
  // The browser splits an id list at ASCII whitespace, including the tab that &#9; writes, and
  // skips empty ids. \S+ also splits at other whitespace, such as &#160;, so it is stricter.
  const ids = value.match(/\S+/g);
  // An id holds one value, so whitespace there is not a separator but part of the id.
  if (name === "id" && ids?.[0] !== value) return null;
  return ids?.every((id) => isDiagramId(id, idPrefix)) ? value : null;
}

/** The value to keep for an attribute, or null to remove the attribute. */
function keptAttributeValue(
  rules: PeleNamespace,
  name: string,
  value: string,
  idPrefix: string
): string | null {
  if (rules.textAttributes.has(name)) return value;
  if (rules.idAttributes.has(name)) return keptIdValue(name, value, idPrefix);
  if (!rules.cssAttributes.has(name)) return null;
  // A style is kept or removed whole, never split into declarations: a splitter that tokenizes
  // quotes, escapes or comments unlike the browser turns an inert string into live declarations.
  // Pele writes no style that fails, so its diagrams lose nothing.
  return isPeleCss(value, name === "style" ? null : idPrefix) ? value : null;
}

/** Applies PELE_OUTPUT to the attributes of an element that removeUnknownElements kept. */
function sanitizeAttributes(element: Element, idPrefix: string): void {
  const rules = peleNamespace(element.namespaceURI);
  for (const attribute of Array.from(element.attributes)) {
    // Lowercase like the HTML parser, which turns an XML FILL attribute into fill.
    const name = asciiLowerCase(attribute.name);
    const value = keptAttributeValue(rules, name, attribute.value, idPrefix);
    if (value === null) element.removeAttributeNode(attribute);
    else attribute.value = value;
  }
}

/** A <math> tree that holds only the elements KaTeX emits. */
function isKatexMathml(math: Element | null): boolean {
  // mutation-equivalent: isPeleMathLabel passes a div's only child, so math is never null
  if (math === null || asciiLowerCase(math.localName) !== "math") return false;
  const { elements } = peleNamespace(MATHML_NS);
  // Lowercase like the HTML parser does with MathML tag names.
  return [math, ...Array.from(math.querySelectorAll("*"))].every(
    (element) =>
      element.namespaceURI === MATHML_NS &&
      element.prefix === null &&
      elements.has(asciiLowerCase(element.localName))
  );
}

/** Pele wraps the MathML that renderMathLabel returns in exactly this shape. */
function isPeleMathLabel(foreignObject: Element): boolean {
  const div = foreignObject.firstElementChild;
  return (
    foreignObject.getAttribute("class") === "pele-math" &&
    foreignObject.childElementCount === 1 &&
    // mutation-equivalent: the check above leaves foreignObject one child, so div is never null
    div?.namespaceURI === XHTML_NS &&
    div.prefix === null &&
    peleNamespace(XHTML_NS).elements.has(div.localName) &&
    div.childElementCount === 1 &&
    Array.from(div.attributes, (attribute) => attribute.name).join() === "xmlns,style" &&
    isKatexMathml(div.firstElementChild)
  );
}

/**
 * Removes every SVG element that Pele does not emit and the element children of its text-only
 * elements, keeping only Pele's math labels as foreignObject. Pele writes no namespace prefix,
 * and the HTML parser knows no s:foreignobject, so a serializer that kept the prefix would let
 * a label's div leave the <svg>.
 */
function removeUnknownElements(parent: Element): void {
  const svg = peleNamespace(SVG_NS);
  for (const child of Array.from(parent.children)) {
    const svgName =
      child.namespaceURI === SVG_NS && child.prefix === null ? asciiLowerCase(child.localName) : "";
    if (svgName === "foreignobject" && isPeleMathLabel(child)) continue;
    if (!svg.elements.has(svgName)) {
      child.remove();
    } else if (svg.textOnlyElements.has(svgName)) {
      for (const element of Array.from(child.children)) element.remove();
    } else {
      removeUnknownElements(child);
    }
  }
}

/**
 * Keeps only element and text children. Pele emits no comments, processing instructions or
 * CDATA. The HTML parser that inserts the output ends `<!-->` and `<?x >` at their first `>`,
 * so markup that the XML parser read as their data becomes live elements.
 */
function removeNonElementNodes(elements: Element[]): void {
  for (const element of elements) {
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType !== child.ELEMENT_NODE && child.nodeType !== child.TEXT_NODE) {
        child.remove();
      }
    }
  }
}

/** Sanitizes the SVG that Pele rendered with idPrefix. Null when it is not well-formed SVG. */
export function sanitizeMermaidSvg(svg: string, idPrefix: string): string | null {
  assert(/^[\w-]+$/.test(idPrefix), "idPrefix is a plain id, as Mermaid builds it");
  // Pele emits well-formed SVG, so anything that fails a strict parse is not its output:
  // fail closed.
  const xmlDoc = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (xmlDoc.querySelector("parsererror") !== null) {
    return null;
  }
  const svgRoot = xmlDoc.documentElement;
  if (svgRoot.namespaceURI !== SVG_NS || asciiLowerCase(svgRoot.tagName) !== "svg") {
    return null;
  }

  // Defense in depth: keep only the elements, text and attribute values Pele emits.
  removeUnknownElements(svgRoot);
  const elements: Element[] = [svgRoot, ...Array.from(svgRoot.querySelectorAll("*"))];
  removeNonElementNodes(elements);
  for (const element of elements) sanitizeAttributes(element, idPrefix);

  return svgRoot.outerHTML;
}

/** Typesets a `$$...$$` label as MathML. Null makes Pele show the TeX source. */
function renderMathLabel(tex: string, size: number): MathMarkup | null {
  let markup: string;
  try {
    markup = katex.renderToString(tex, { displayMode: true, output: "mathml", throwOnError: true });
  } catch {
    return null;
  }

  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;left:-9999px;visibility:hidden;display:inline-block;white-space:nowrap";
  probe.style.fontSize = `${size}px`;
  // SECURITY AUDIT: tex is untrusted chart text. KaTeX escapes it, and its default
  // `trust: false` rejects \href, \url, \includegraphics and \html*. sanitizeMermaidSvg()
  // still checks the markup Pele embeds.
  probe.innerHTML = markup;
  document.body.append(probe);
  try {
    const math = probe.querySelector("math");
    assert(math, "KaTeX MathML output has a <math> element");
    const { width, height } = math.getBoundingClientRect();
    // Not outerHTML: sanitizeMermaidSvg() parses the SVG as strict XML, which has no HTML
    // named entities.
    return { html: new XMLSerializer().serializeToString(math), width, height };
  } finally {
    probe.remove();
  }
}

const DIAGRAM_FONT_SIZE = 14;

/**
 * Xum's Pele options. Mermaid.sanitization.test.ts renders with them, so every option that
 * changes Pele's output belongs here.
 */
export function peleRenderOptions(
  diagram: Pick<RenderOptions, "idPrefix" | "maxWidth" | "fontFamily" | "fontFamilyMono">
): RenderOptions {
  return {
    ...diagram,
    fontSize: DIAGRAM_FONT_SIZE,
    directionBreakpoint: NARROW_DIAGRAM_WIDTH,
    // Diagram text is untrusted model output: no clickable links, and no images,
    // which would fetch from the network as soon as the SVG is inserted.
    links: false,
    images: false,
    math: renderMathLabel,
  };
}

/** Renders untrusted chart text to sanitized SVG markup. Throws Pele's parse errors. */
async function renderMermaidSvg(
  chart: string,
  idPrefix: string,
  maxWidth: number | undefined
): Promise<string> {
  const rootStyle = window.getComputedStyle(document.documentElement);
  // Measure with the same fonts the .mermaid-container CSS draws with.
  const fontFamily = rootStyle.getPropertyValue("--font-primary").trim() || undefined;
  const fontFamilyMono = rootStyle.getPropertyValue("--font-monospace").trim() || undefined;

  // Pele measures labels with canvas when it renders, so the fonts must be loaded first
  // or boxes are sized for the fallback font. fonts.ready does not start loading a face
  // that nothing on the page uses yet, so request each family. A failed load falls back
  // to measuring whatever font is there. happy-dom has no document.fonts.
  if ("fonts" in document) {
    const families = [fontFamily, fontFamilyMono].filter((family) => family !== undefined);
    await Promise.allSettled(
      families.map((family) => document.fonts.load(`${DIAGRAM_FONT_SIZE}px ${family}`))
    );
    await document.fonts.ready;
  }

  const { svg } = renderPele(
    chart,
    peleRenderOptions({ idPrefix, maxWidth, fontFamily, fontFamilyMono })
  );

  const sanitizedSvg = sanitizeMermaidSvg(svg, idPrefix);
  if (!sanitizedSvg) {
    throw new Error("Diagram renderer returned invalid SVG output");
  }
  return sanitizedSvg;
}

/** Zero width (hidden, or not laid out yet) means unknown: render the natural layout. */
function diagramLayout(containerSize: { width: number } | null) {
  const width = containerSize?.width ?? 0;
  const isNarrow = width > 0 && width < NARROW_DIAGRAM_WIDTH;
  const style: CSSProperties = isNarrow ? { ["--diagram-max-height" as string]: "none" } : {};
  return { maxWidth: width > 0 ? width : undefined, style };
}

/**
 * Renders chart at the width of the element that containerRef points to, so each frame
 * (inline and the expand dialog) lays the diagram out for its own width. A chart that
 * fails to render keeps the last valid diagram on screen.
 */
function useDiagramSvg(chart: string, idPrefix: string) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const layout = diagramLayout(useResizeObserver(containerRef));
  // Keep the source and SVG together while a newer chart is pending or invalid.
  const [rendered, setRendered] = useState<{ svg: string; chart: string } | null>(null);
  const [error, setError] = useState<{ chart: string; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;

    const renderDiagram = async () => {
      try {
        const svg = await renderMermaidSvg(chart, idPrefix, layout.maxWidth);
        if (cancelled) return;

        setRendered({ svg, chart });
        setError(null);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Failed to render diagram";
        setError({ chart, message });
      }
    };

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [chart, idPrefix, layout.maxWidth]);

  return { containerRef, layoutStyle: layout.style, rendered, error };
}

function normalizeDiagramZoom(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_ZOOM;
  }

  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}

// Common button styles
const getButtonStyle = (disabled = false): CSSProperties => ({
  // Theme tokens, not fixed white, so the buttons stay visible in the light themes (#7821).
  background: "var(--color-background)",
  border: "1px solid var(--color-border-subtle)",
  color: disabled ? "var(--color-text-secondary)" : "var(--color-text)",
  height: `${MERMAID_BUTTON_HEIGHT}px`,
  padding: "0 10px",
  cursor: disabled ? "not-allowed" : "pointer",
  borderRadius: "4px",
  fontSize: "16px",
  lineHeight: 1,
  opacity: disabled ? 0.5 : 1,
});

// Modal component for fullscreen diagram view
const DiagramModal: React.FC<{ children: ReactNode; onClose: () => void }> = ({
  children,
  onClose,
}) => {
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (isDesktopViewportFocused(e.target)) return;
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handleEscape, { capture: true });
    return () => window.removeEventListener("keydown", handleEscape, { capture: true });
  }, [onClose]);

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0, 0, 0, 0.9)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px",
      }}
      onClick={onClose}
    >
      <div
        style={{
          position: "relative",
          maxWidth: "90%",
          maxHeight: "90%",
          overflow: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
        <button
          onClick={onClose}
          style={{
            position: "absolute",
            top: "16px",
            right: "16px",
            background: "var(--color-background)",
            border: "1px solid var(--color-border-subtle)",
            color: "var(--color-text)",
            padding: "8px 16px",
            cursor: "pointer",
            borderRadius: "4px",
            fontSize: "14px",
            fontFamily: "var(--font-primary)",
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
};

/** The expand dialog renders its own copy of an already valid chart, at the dialog's width. */
const DialogDiagram: React.FC<{ chart: string; idPrefix: string }> = (props) => {
  const { containerRef, rendered } = useDiagramSvg(props.chart, props.idPrefix);
  return (
    <div
      ref={containerRef}
      className="mermaid-container mermaid-modal"
      style={{
        background: "var(--color-code-bg)",
        padding: "24px",
        borderRadius: "8px",
        minWidth: "80vw",
        minHeight: "60vh",
      }}
      // SECURITY AUDIT: rendered.svg only holds sanitizeMermaidSvg() output.
      dangerouslySetInnerHTML={{ __html: rendered?.svg ?? "" }}
    />
  );
};

// Mermaid diagram component
export const Mermaid: React.FC<{ chart: string }> = ({ chart }) => {
  const { isStreaming } = useContext(StreamingContext);
  const [isModalOpen, setIsModalOpen] = useState(false);
  // Each diagram needs its own prefix: inline SVG ids (markers, clip paths) share the document.
  const idPrefix = `mermaid-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;

  // Debounce chart changes to avoid flickering during streaming
  const [debouncedChart, setDebouncedChart] = useState(chart);
  const {
    containerRef,
    layoutStyle,
    rendered: renderedDiagram,
    error: renderError,
  } = useDiagramSvg(debouncedChart, idPrefix);
  const svg = renderedDiagram?.svg ?? "";
  // An error belongs to the chart that failed, so a newer chart hides it at once instead of
  // flashing it at the end of a stream.
  const error = renderError?.chart === chart ? renderError.message : null;
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedChart(chart), 350);
    return () => clearTimeout(timer);
  }, [chart]);

  const [storedDiagramZoom, setStoredDiagramZoom] = usePersistedState(
    MERMAID_DIAGRAM_ZOOM_KEY,
    DEFAULT_ZOOM,
    { listener: true }
  );
  // The +/- controls are shown as zoom affordances, so scale the rendered SVG
  // itself; changing only max-height is a no-op for diagrams already below the cap.
  const diagramZoom = normalizeDiagramZoom(storedDiagramZoom);
  const atMinZoom = diagramZoom <= MIN_ZOOM;
  const atMaxZoom = diagramZoom >= MAX_ZOOM;

  const handleZoomIn = () => {
    if (!atMaxZoom) {
      setStoredDiagramZoom((prev) => normalizeDiagramZoom(normalizeDiagramZoom(prev) + ZOOM_STEP));
    }
  };

  const handleZoomOut = () => {
    if (!atMinZoom) {
      setStoredDiagramZoom((prev) => normalizeDiagramZoom(normalizeDiagramZoom(prev) - ZOOM_STEP));
    }
  };

  if (error && !isStreaming) {
    return (
      <pre
        style={{
          color: "var(--color-syntax-error)",
          background: "hsl(from var(--color-syntax-error) h s l / 0.1)",
          padding: "12px",
        }}
      >
        Mermaid Error: {error}
      </pre>
    );
  }

  // Keep one stable diagram frame while streaming or while the async Mermaid render is pending.
  // When no SVG has rendered yet, reserve the normal minimum diagram height so the transcript
  // doesn't expand from a short placeholder to a full diagram after debounce/parse/render.
  const displaySvg = svg;
  const showPendingPlaceholder = !displaySvg;

  return (
    <>
      <div style={MERMAID_FRAME_STYLE}>
        <div
          style={{
            position: "absolute",
            top: `${MERMAID_BUTTON_INSET}px`,
            right: `${MERMAID_BUTTON_INSET}px`,
            display: "flex",
            gap: "4px",
          }}
        >
          <TooltipIfPresent tooltip="Zoom out diagram" side="bottom">
            <button onClick={handleZoomOut} disabled={atMinZoom} style={getButtonStyle(atMinZoom)}>
              −
            </button>
          </TooltipIfPresent>
          <TooltipIfPresent tooltip="Zoom in diagram" side="bottom">
            <button onClick={handleZoomIn} disabled={atMaxZoom} style={getButtonStyle(atMaxZoom)}>
              +
            </button>
          </TooltipIfPresent>
          <TooltipIfPresent tooltip="Expand diagram" side="bottom">
            <button onClick={() => setIsModalOpen(true)} style={getButtonStyle()}>
              ⤢
            </button>
          </TooltipIfPresent>
        </div>
        <div
          className="mermaid-container"
          ref={(element) => {
            containerRef.current = element;
            if (!element) return;
            if (renderedDiagram) transcriptMermaidSources.set(element, renderedDiagram.chart);
            else transcriptMermaidSources.delete(element);
          }}
          style={{
            ...MERMAID_CONTAINER_STYLE,
            ["--diagram-zoom" as string]: `${diagramZoom}`,
            ...layoutStyle,
            ...(showPendingPlaceholder ? MERMAID_PENDING_STYLE : {}),
          }}
          // SECURITY AUDIT: displaySvg is produced by sanitizeMermaidSvg(), which strips
          // active SVG/HTML content before insertion. React children are used for the
          // pending placeholder so untrusted chart text is never rendered as HTML.
          {...(!showPendingPlaceholder ? { dangerouslySetInnerHTML: { __html: displaySvg } } : {})}
        >
          {showPendingPlaceholder ? MERMAID_PENDING_TEXT : null}
        </div>
      </div>
      {isModalOpen && renderedDiagram && (
        <DiagramModal onClose={() => setIsModalOpen(false)}>
          <DialogDiagram chart={renderedDiagram.chart} idPrefix={`${idPrefix}-modal`} />
        </DiagramModal>
      )}
    </>
  );
};
