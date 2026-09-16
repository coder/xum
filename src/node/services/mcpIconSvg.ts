import { SaxesParser } from "saxes";
import { MCP_ICON_LIMITS } from "@/common/constants/mcpIcon";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "title",
  "desc",
]);
const LENGTHS = new Set([
  "width",
  "height",
  "x",
  "y",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x1",
  "y1",
  "x2",
  "y2",
  "stroke-width",
]);
const COLORS = new Set([
  "none",
  "currentColor",
  "transparent",
  "black",
  "white",
  "red",
  "green",
  "blue",
  "gray",
  "silver",
  "maroon",
  "purple",
  "fuchsia",
  "lime",
  "olive",
  "yellow",
  "navy",
  "teal",
  "aqua",
]);
const TRANSFORM_ARITIES: Record<string, readonly number[]> = {
  matrix: [6],
  translate: [1, 2],
  scale: [1, 2],
  rotate: [1, 3],
  skewX: [1],
  skewY: [1],
};

function isNumber(value: string): boolean {
  return /^-?\d{1,6}(\.\d{1,6})?$/.test(value);
}

function numbers(value: string): string[] | null {
  const values = value.trim().split(/[\s,]+/);
  return values.every(isNumber) ? values : null;
}

function isTransform(value: string): boolean {
  const expression = /(matrix|translate|scale|rotate|skewX|skewY)\(([^()]*)\)/g;
  let end = 0;
  for (const match of value.matchAll(expression)) {
    if (!/^[\s,]*$/.test(value.slice(end, match.index))) return false;
    const args = numbers(match[2]);
    if (!args || !TRANSFORM_ARITIES[match[1]].includes(args.length)) return false;
    end = match.index + match[0].length;
  }
  return end > 0 && /^[\s,]*$/.test(value.slice(end));
}

function isAttribute(name: string, value: string): boolean {
  if (value.length > MCP_ICON_LIMITS.svgAttributeMaxChars) return false;
  if (LENGTHS.has(name)) return isNumber(value.replace(/px$/, ""));
  switch (name) {
    case "xmlns":
      return value === SVG_NAMESPACE;
    case "viewBox":
      return numbers(value)?.length === 4;
    case "fill":
    case "stroke":
      return COLORS.has(value) || /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(value);
    case "opacity":
    case "fill-opacity":
    case "stroke-opacity":
      return isNumber(value) && Number(value) >= 0 && Number(value) <= 1;
    // The unchanged Notion logo declares clip-rule; it is inert here because
    // clipPath elements and clipping references remain forbidden.
    case "fill-rule":
    case "clip-rule":
      return value === "nonzero" || value === "evenodd";
    case "stroke-linecap":
      return /^(butt|round|square)$/.test(value);
    case "stroke-linejoin":
      return /^(miter|round|bevel)$/.test(value);
    case "d":
    case "points": {
      if (!/^[0-9eE+\-.,\sMmLlHhVvCcSsQqTtAaZz]*$/.test(value)) return false;
      // Exponents occur in path data, but must not hide non-finite or huge coordinates.
      const coordinates = value.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? [];
      return coordinates.every(
        (coordinate) =>
          Number.isFinite(Number(coordinate)) &&
          Math.abs(Number(coordinate)) < MCP_ICON_LIMITS.svgCoordinateMaxExclusive
      );
    }
    case "transform":
      return isTransform(value);
    default:
      return false;
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * SECURITY AUDIT: librsvg receives only re-serialized, allowlisted geometry,
 * never server XML. CSS, references, foreign namespaces, and external entities
 * cannot reach its resource loaders. This filter itself runs in the killable
 * decode child: parser limits do not replace the parent's absolute deadline.
 */
export function sanitizeMcpIconSvg(xml: string): string | null {
  if (
    Buffer.byteLength(xml, "utf8") > MCP_ICON_LIMITS.svgMaxBytes ||
    /<!|&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml)
  )
    return null;
  try {
    const parser = new SaxesParser({
      xmlns: true,
      defaultXMLVersion: "1.0",
      forceXMLVersion: true,
    });
    const output: string[] = [];
    const stack: string[] = [];
    let nodes = 0;
    const reject = () => {
      throw new Error("Unsupported MCP icon SVG");
    };
    parser.on("error", reject);
    parser.on("doctype", reject);
    parser.on("cdata", reject);
    parser.on("comment", reject);
    parser.on("processinginstruction", reject);
    parser.on("xmldecl", (declaration) => {
      if (
        declaration.version !== "1.0" ||
        (declaration.encoding && declaration.encoding.toLowerCase() !== "utf-8")
      )
        reject();
    });
    parser.on("opentag", (tag) => {
      if (
        ++nodes > MCP_ICON_LIMITS.svgMaxNodes ||
        stack.length >= MCP_ICON_LIMITS.svgMaxDepth ||
        tag.uri !== SVG_NAMESPACE ||
        tag.prefix ||
        !ELEMENTS.has(tag.name)
      )
        reject();
      if (stack.length === 0 ? tag.name !== "svg" : tag.name === "svg") reject();
      const attributes: string[] = [];
      for (const attribute of Object.values(tag.attributes)) {
        if (attribute.prefix || !isAttribute(attribute.name, attribute.value)) reject();
        attributes.push(` ${attribute.name}="${escapeXml(attribute.value)}"`);
      }
      output.push(`<${tag.name}${attributes.join("")}>`);
      stack.push(tag.name);
    });
    parser.on("text", (text) => {
      if (!text.trim()) return;
      if (
        ++nodes > MCP_ICON_LIMITS.svgMaxNodes ||
        !["title", "desc"].includes(stack[stack.length - 1])
      )
        reject();
      output.push(escapeXml(text));
    });
    parser.on("closetag", (tag) => {
      stack.pop();
      output.push(`</${tag.name}>`);
    });
    parser.write(xml).close();
    return output.join("");
  } catch {
    return null;
  }
}
