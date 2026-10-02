import { classifyArtifactReference } from "./artifactPaths";
import { isArtifactCdnUrl, type ArtifactCspOptions } from "./artifactCsp";
import { toImageDataUrl, type createArtifactAssetLoader } from "./artifactAssets";

/**
 * Builds the srcdoc for sandboxed HTML/SVG artifacts (experiment: "artifacts").
 *
 * SECURITY AUDIT: the document is built by parsing (DOMParser), then inserting the CSP
 * <meta> as the FIRST child of <head>, followed by the bridge <script>. A meta CSP only
 * governs content after it, and because the HTML parser places every artifact node after
 * <head>'s first child, nothing the artifact wrote can run or load before the policy applies.
 * Never build these documents by string concatenation.
 */

export interface SandboxedDocumentOptions {
  csp: string;
  /** Artifact bridge (window.xum); MCP Apps views get only their preamble (mcpAppCsp.ts). */
  bridgeScript?: string;
}

function insertSecurityPreamble(doc: Document, options: SandboxedDocumentOptions) {
  let head = doc.head as HTMLHeadElement | null;
  if (head == null) {
    head = doc.createElement("head");
    doc.documentElement.insertBefore(head, doc.documentElement.firstChild);
  }
  const meta = doc.createElement("meta");
  meta.setAttribute("http-equiv", "Content-Security-Policy");
  meta.setAttribute("content", options.csp);
  head.insertBefore(meta, head.firstChild);
  if (options.bridgeScript !== undefined) {
    const script = doc.createElement("script");
    script.textContent = options.bridgeScript;
    meta.after(script);
  }
}

function serialize(doc: Document): string {
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}

export function parseArtifactHtml(html: string): Document {
  return new window.DOMParser().parseFromString(html, "text/html");
}

/** Final step for HTML artifacts: add the CSP + bridge preamble and serialize. */
export function finalizeSandboxedDocument(
  doc: Document,
  options: SandboxedDocumentOptions
): string {
  insertSecurityPreamble(doc, options);
  return serialize(doc);
}

export function buildSandboxedHtmlDocument(
  html: string,
  options: SandboxedDocumentOptions
): string {
  return finalizeSandboxedDocument(parseArtifactHtml(html), options);
}

const SVG_FRAME_STYLE =
  "html,body{margin:0;height:100%}" +
  "body{display:flex;align-items:center;justify-content:center}" +
  "body>svg{max-width:100%;max-height:100%}";

/**
 * Wraps an SVG artifact in a minimal HTML document for the same sandbox (SVG is never
 * rendered in the app DOM). Returns null when the text is not a well-formed <svg> document.
 */
export function buildSandboxedSvgDocument(
  svg: string,
  options: SandboxedDocumentOptions
): string | null {
  const svgDoc = new window.DOMParser().parseFromString(svg, "image/svg+xml");
  const root = svgDoc.documentElement as Element | null;
  if (root?.localName !== "svg" || svgDoc.getElementsByTagName("parsererror").length > 0) {
    return null;
  }
  const doc = document.implementation.createHTMLDocument("");
  const style = doc.createElement("style");
  style.textContent = SVG_FRAME_STYLE;
  doc.head.appendChild(style);
  doc.body.appendChild(doc.importNode(root, true));
  return finalizeSandboxedDocument(doc, options);
}

/**
 * Inline relative images, stylesheets and scripts referenced by an HTML artifact, reading them
 * through the artifacts API. Returns one notice per reference that stays blocked (absolute
 * non-CDN URLs, or relative files that cannot be inlined within the limits).
 */
/**
 * Raw-text elements end at the first `</script` / `</style`, even inside a JS string: the
 * serialized srcdoc would cut an inlined asset there and render the rest as HTML. `<\/` reads
 * the same in JS strings, regexes and CSS strings.
 */
function escapeRawTextEnd(content: string, tag: "script" | "style"): string {
  return content.replace(new RegExp(`</(${tag})`, "gi"), "<\\/$1");
}

export async function inlineArtifactHtmlAssets(
  doc: Document,
  loader: ReturnType<typeof createArtifactAssetLoader>,
  cspOptions: ArtifactCspOptions
): Promise<string[]> {
  // A Set: the same blocked URL referenced twice gets one notice.
  const notices = new Set<string>();
  const blocked = (ref: string, reason?: string) =>
    notices.add(
      reason == null ? `External asset blocked: ${ref}` : `Asset not loaded (${reason}): ${ref}`
    );

  const tasks: Array<Promise<void>> = [];
  // Inlined `defer` scripts: an inline classic script ignores `defer`, so they move to the end
  // of <body> (in document order) to still run after the document is parsed.
  const inlinedDeferred = new Set<Element>();

  for (const img of Array.from(doc.querySelectorAll("img[src]"))) {
    const ref = img.getAttribute("src") ?? "";
    const kind = classifyArtifactReference(ref);
    if (kind === "data") continue;
    if (kind === "external") {
      blocked(ref);
      continue;
    }
    tasks.push(
      loader.load(ref).then((asset) => {
        const dataUrl = asset.status === "ok" ? toImageDataUrl(asset.result) : null;
        if (dataUrl == null) {
          blocked(ref, asset.status === "skipped" ? asset.reason : "not an image");
          return;
        }
        img.setAttribute("src", dataUrl);
      })
    );
  }

  for (const link of Array.from(doc.querySelectorAll("link[href]"))) {
    const rel = (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("stylesheet")) continue;
    const ref = link.getAttribute("href") ?? "";
    const kind = classifyArtifactReference(ref);
    if (kind === "external") {
      if (!isArtifactCdnUrl(ref, "style", cspOptions)) blocked(ref);
      continue;
    }
    if (kind === "data") continue;
    tasks.push(
      loader.load(ref).then((asset) => {
        if (asset.status !== "ok" || asset.result.encoding !== "utf8") {
          blocked(ref, asset.status === "skipped" ? asset.reason : "not text");
          return;
        }
        const style = doc.createElement("style");
        style.textContent = escapeRawTextEnd(asset.result.content, "style");
        link.replaceWith(style);
      })
    );
  }

  for (const script of Array.from(doc.querySelectorAll("script[src]"))) {
    const ref = script.getAttribute("src") ?? "";
    const kind = classifyArtifactReference(ref);
    if (kind === "external") {
      if (!isArtifactCdnUrl(ref, "script", cspOptions)) blocked(ref);
      continue;
    }
    if (kind === "data") continue;
    tasks.push(
      loader.load(ref).then((asset) => {
        if (asset.status !== "ok" || asset.result.encoding !== "utf8") {
          blocked(ref, asset.status === "skipped" ? asset.reason : "not text");
          return;
        }
        script.removeAttribute("src");
        script.textContent = escapeRawTextEnd(asset.result.content, "script");
        if (script.hasAttribute("defer") && script.getAttribute("type") !== "module") {
          inlinedDeferred.add(script);
        }
      })
    );
  }

  await Promise.all(tasks);
  for (const script of Array.from(doc.querySelectorAll("script"))) {
    if (!inlinedDeferred.has(script)) continue;
    script.removeAttribute("defer");
    doc.body.appendChild(script);
  }
  return [...notices];
}
