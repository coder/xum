import { sanitizeMermaidSvg } from "./Mermaid";

import { Window } from "happy-dom";

const testWindow = new Window();
globalThis.DOMParser = testWindow.DOMParser as unknown as typeof DOMParser;

describe("sanitizeMermaidSvg", () => {
  it("returns null for malformed SVG", () => {
    expect(sanitizeMermaidSvg("<svg><g></svg")).toBeNull();
  });

  it("removes active content, foreignObject and unsafe attributes", () => {
    const input =
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' +
      "<script>alert(1)</script>" +
      '<foreignObject><div onclick="evil()">label</div></foreignObject>' +
      '<a href="javascript:alert(1)"><text>link</text></a>' +
      '<a xlink:href="java&#10;script:alert(3)"><text>split-link</text></a>' +
      '<a href="java&#1114112;script:alert(4)"><text>invalid-codepoint</text></a>' +
      '<image src="javascript:alert(2)" />' +
      '<rect width="10" height="10" onclick="steal()" />' +
      "</svg>";

    const sanitized = sanitizeMermaidSvg(input);

    expect(sanitized).not.toBeNull();
    expect(sanitized).not.toContain("<script");
    expect(sanitized).not.toContain("onload=");
    expect(sanitized).not.toContain("onclick=");
    expect(sanitized).not.toContain("javascript:");
    expect(sanitized).not.toContain("java&#10;script:");
    expect(sanitized).not.toContain("&#1114112;");
    expect(sanitized).not.toContain("xlink:href=");
    expect(sanitized).not.toContain("href=");
    expect(sanitized).toContain("<svg");
    expect(sanitized).toContain("<rect");
    expect(sanitized).not.toContain("foreignObject");
    expect(sanitized).not.toContain("label");
  });
});
