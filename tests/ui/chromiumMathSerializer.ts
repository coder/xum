/**
 * happy-dom builds <math> as an HTML element, so its XMLSerializer declares the XHTML namespace
 * before KaTeX's MathML xmlns attribute, and sanitizeMermaidSvg then drops the math label.
 * Chromium builds a MathML element and writes only KaTeX's xmlns. The returned class writes what
 * Chromium writes, so Mermaid tests can render math labels under happy-dom.
 */
export function chromiumMathSerializer(base: typeof XMLSerializer): typeof XMLSerializer {
  return class extends base {
    serializeToString(node: Node): string {
      return super
        .serializeToString(node)
        .replace(/^<math xmlns="http:\/\/www\.w3\.org\/1999\/xhtml" /, "<math ");
    }
  };
}
