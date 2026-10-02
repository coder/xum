// Bootstrap Happy DOM (DOMParser) before the module under test runs.
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../../../tests/ui/dom";
import type { ArtifactReadResult } from "@/common/orpc/schemas/artifacts";
import { ARTIFACT_ASSET_LIMITS, createArtifactAssetLoader } from "./artifactAssets";
import { buildArtifactCsp } from "./artifactCsp";
import {
  buildSandboxedHtmlDocument,
  buildSandboxedSvgDocument,
  finalizeSandboxedDocument,
  inlineArtifactHtmlAssets,
  parseArtifactHtml,
} from "./artifactDocument";

const CSP = buildArtifactCsp({ allowCdn: true });
const OPTIONS = { csp: CSP, bridgeScript: "/*bridge*/" };

function firstHeadChildren(srcdoc: string) {
  const doc = new window.DOMParser().parseFromString(srcdoc, "text/html");
  return Array.from(doc.head.children);
}

function expectCspFirst(srcdoc: string) {
  const [meta, script] = firstHeadChildren(srcdoc);
  expect(meta?.tagName).toBe("META");
  expect(meta?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
  expect(meta?.getAttribute("content")).toBe(CSP);
  expect(script?.tagName).toBe("SCRIPT");
  expect(script?.textContent).toBe("/*bridge*/");
}

describe("artifact CSP", () => {
  test("matches the agreed policy exactly", () => {
    expect(buildArtifactCsp({ allowCdn: true })).toBe(
      "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://unpkg.com https://cdn.tailwindcss.com https://code.jquery.com https://cdn.jsdelivr.net/npm/; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'"
    );
    expect(buildArtifactCsp({ allowCdn: false })).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'"
    );
  });
});

describe("buildSandboxedHtmlDocument", () => {
  let cleanupDom: (() => void) | null = null;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanupDom?.();
    cleanupDom = null;
  });

  test("puts the CSP meta first in <head> for every document shape", () => {
    for (const html of [
      "<p>fragment only</p>",
      "<!doctype html><html><head><script>alert(1)</script><meta charset=utf-8></head><body></body></html>",
      "<script>before head</script><head><title>x</title></head>",
      "<html><body><meta http-equiv='Content-Security-Policy' content=\"script-src *\"></body></html>",
      "<head></head>",
      "",
      "<!-- comment --><html lang=en>text",
    ]) {
      const srcdoc = buildSandboxedHtmlDocument(html, OPTIONS);
      expect(srcdoc.startsWith("<!DOCTYPE html>\n<html")).toBe(true);
      expectCspFirst(srcdoc);
    }
  });

  test("keeps the artifact's own markup", () => {
    const srcdoc = buildSandboxedHtmlDocument("<h1 id=t>Hello</h1>", OPTIONS);
    const doc = new window.DOMParser().parseFromString(srcdoc, "text/html");
    expect(doc.getElementById("t")?.textContent).toBe("Hello");
  });

  test("wraps SVG in an HTML document and rejects non-SVG input", () => {
    const srcdoc = buildSandboxedSvgDocument(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="4"/></svg>',
      OPTIONS
    );
    expect(srcdoc).not.toBeNull();
    expectCspFirst(srcdoc!);
    expect(srcdoc).toContain("<circle");
    expect(buildSandboxedSvgDocument("<html><body>nope</body></html>", OPTIONS)).toBeNull();
  });
});

describe("inlineArtifactHtmlAssets", () => {
  let cleanupDom: (() => void) | null = null;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanupDom?.();
    cleanupDom = null;
  });

  function ok(
    path: string,
    kind: "image" | "text",
    content: string,
    size = content.length
  ): ArtifactReadResult {
    return {
      status: "ok",
      path,
      kind,
      size,
      modifiedMs: 1,
      encoding: kind === "image" ? "base64" : "utf8",
      content,
    };
  }

  test("inlines relative images, CSS and scripts; blocks non-CDN absolute URLs", async () => {
    const files: Record<string, ArtifactReadResult> = {
      "site/img/a.png": ok("site/img/a.png", "image", "AAAA"),
      "site/style.css": ok("site/style.css", "text", "body{color:red}"),
      "site/app.js": ok("site/app.js", "text", "window.ok=1"),
    };
    const reads: string[] = [];
    const loader = createArtifactAssetLoader("site/index.html", (path) => {
      reads.push(path);
      return Promise.resolve(files[path] ?? null);
    });
    const doc = parseArtifactHtml(
      [
        '<link rel="stylesheet" href="style.css">',
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Inter">',
        '<script src="app.js"></script>',
        '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>',
        '<script src="https://evil.example/x.js"></script>',
        '<img src="img/a.png"><img src="../../outside.png"><img src="missing.png">',
      ].join("")
    );
    const notices = await inlineArtifactHtmlAssets(doc, loader, { allowCdn: true });

    expect(doc.querySelector("style")?.textContent).toBe("body{color:red}");
    expect(doc.querySelector("script:not([src])")?.textContent).toBe("window.ok=1");
    expect(doc.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(reads.sort()).toEqual([
      "site/app.js",
      "site/img/a.png",
      "site/missing.png",
      "site/style.css",
    ]);
    expect(notices.sort()).toEqual([
      "Asset not loaded (not found): missing.png",
      "Asset not loaded (not relative): ../../outside.png",
      "External asset blocked: https://evil.example/x.js",
    ]);
  });

  test("flags CDN URLs as blocked when CDN scripts are off", async () => {
    const loader = createArtifactAssetLoader("index.html", () => Promise.resolve(null));
    const doc = parseArtifactHtml('<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>');
    expect(await inlineArtifactHtmlAssets(doc, loader, { allowCdn: false })).toEqual([
      "External asset blocked: https://cdn.jsdelivr.net/npm/chart.js",
    ]);
  });

  test("stops reading after the asset count cap", async () => {
    let reads = 0;
    const loader = createArtifactAssetLoader("index.html", (path) => {
      reads += 1;
      return Promise.resolve(ok(path, "image", "AA"));
    });
    const imgs = Array.from(
      { length: ARTIFACT_ASSET_LIMITS.maxAssets + 3 },
      (_, i) => `<img src="i${i}.png">`
    );
    const notices = await inlineArtifactHtmlAssets(parseArtifactHtml(imgs.join("")), loader, {
      allowCdn: true,
    });
    expect(reads).toBe(ARTIFACT_ASSET_LIMITS.maxAssets);
    expect(notices).toHaveLength(3);
  });

  test("skips assets over the per-asset size cap", async () => {
    const loader = createArtifactAssetLoader("index.html", (path) =>
      Promise.resolve(ok(path, "image", "AA", ARTIFACT_ASSET_LIMITS.maxAssetBytes + 1))
    );
    const doc = parseArtifactHtml('<img src="big.png">');
    expect(await inlineArtifactHtmlAssets(doc, loader, { allowCdn: true })).toEqual([
      "Asset not loaded (too large): big.png",
    ]);
  });

  test("an inlined asset containing </script> or </style> stays one element", async () => {
    const files: Record<string, string> = {
      "app.js": 'const m = "</script><b>escaped</b>"; window.ok = 1;',
      "app.css": '.a::after { content: "</STYLE><i>x</i>"; }',
    };
    const loader = createArtifactAssetLoader("index.html", (path) =>
      Promise.resolve(files[path] == null ? null : ok(path, "text", files[path]))
    );
    const doc = parseArtifactHtml(
      '<head><link rel="stylesheet" href="app.css"><script src="app.js"></script></head><body></body>'
    );
    await inlineArtifactHtmlAssets(doc, loader, { allowCdn: true });
    const reparsed = new window.DOMParser().parseFromString(
      finalizeSandboxedDocument(doc, OPTIONS),
      "text/html"
    );
    const scripts = Array.from(reparsed.querySelectorAll("script")).filter(
      (s) => s.textContent !== "/*bridge*/"
    );
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.textContent).toContain("window.ok = 1;");
    expect(reparsed.querySelectorAll("style")).toHaveLength(1);
    expect(reparsed.querySelector("b, i")).toBeNull();
  });

  test("an inlined defer script moves to the end of <body> and keeps document order", async () => {
    const loader = createArtifactAssetLoader("index.html", (path) =>
      Promise.resolve(ok(path, "text", `/*${path}*/`))
    );
    const doc = parseArtifactHtml(
      '<head><script defer src="a.js"></script><script src="now.js"></script>' +
        '<script defer type="module" src="m.js"></script><script defer src="b.js"></script>' +
        '</head><body><p id="first">x</p></body>'
    );
    await inlineArtifactHtmlAssets(doc, loader, { allowCdn: true });
    const bodyScripts = Array.from(doc.body.querySelectorAll("script"));
    expect(bodyScripts.map((s) => s.textContent)).toEqual(["/*a.js*/", "/*b.js*/"]);
    expect(bodyScripts.every((s) => !s.hasAttribute("defer"))).toBe(true);
    expect(doc.body.lastElementChild?.textContent).toBe("/*b.js*/");
    // Non-deferred and module scripts stay where they were.
    expect(Array.from(doc.head.querySelectorAll("script")).map((s) => s.textContent)).toEqual([
      "/*now.js*/",
      "/*m.js*/",
    ]);
  });
});
