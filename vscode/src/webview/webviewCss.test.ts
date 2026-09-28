import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

import { __unstable__loadDesignSystem, compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import * as esbuild from "esbuild";

/*
 * Guards the VS Code webview stylesheet against drift from the desktop styles.
 *
 * The webview renders shared desktop components, but ships its own stylesheet
 * (vscode/src/webview/webview.css). When a component the webview bundles (or can import)
 * uses a Tailwind utility or CSS custom property that the desktop styles define but the
 * webview stylesheet does not, the webview renders it unstyled (for example transparent
 * tooltips when the tooltip tokens were missing). All checks below compare against the
 * desktop globals.css, so tokens that are undefined on desktop too (Radix runtime vars,
 * story-only vars) are not reported.
 */

const vscodeDir = path.resolve(import.meta.dir, "..", "..");
const repoRoot = path.resolve(vscodeDir, "..");
const desktopCssPath = path.join(repoRoot, "src", "browser", "styles", "globals.css");
const webviewCssPath = path.join(vscodeDir, "src", "webview", "webview.css");

const FIX_HINT =
  "Share the desktop definition with the webview instead of copying it: tokens live in " +
  "src/browser/styles/theme-dark.css, transcript rules and utilities in the other shared files " +
  "under src/browser/styles/ imported by vscode/src/webview/webview.css.";

interface EsbuildConfigModule {
  webviewBuild: esbuild.BuildOptions;
  compileWebviewCss: () => Promise<{ css: string; dependencies: string[] }>;
}

// Reuse the real bundle config so the checked sources include exactly the ones the webview ships.
const esbuildConfig = createRequire(import.meta.url)(
  path.join(vscodeDir, "esbuild.config.js")
) as EsbuildConfigModule;

async function getBundledSourceFiles(): Promise<string[]> {
  const result = await esbuild.build({
    ...esbuildConfig.webviewBuild,
    absWorkingDir: vscodeDir,
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const files = Object.keys(result.metafile.inputs)
    .filter(
      (input) => /\.tsx?$/.test(input) && !input.includes("node_modules") && !input.includes(":")
    )
    .map((input) => path.resolve(vscodeDir, input));
  // Sanity check: an empty list would make every check pass vacuously.
  expect(files).toContain(path.join(vscodeDir, "src", "webview", "App.tsx"));
  return files;
}

// Every non-test, non-story renderer module, whether or not the webview imports it today.
// Webview work keeps pulling in more desktop components (for example the composer adopting
// src/browser/features/ChatInput/), so the guard covers what the bundle CAN import, not only
// what it imports now: a later import must not reintroduce drift.
function getImportableRendererFiles(): string[] {
  const browserDir = path.join(repoRoot, "src", "browser");
  const files = fs
    .readdirSync(browserDir, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !/\.(test|stories)\.tsx?$/.test(file))
    .map((file) => path.join(browserDir, file));
  expect(files).toContain(path.join(browserDir, "features", "ChatInput", "index.tsx"));
  return files;
}

function readCandidates(files: string[]): string[] {
  const scanner = new Scanner({});
  return scanner.scanFiles(
    files.map((file) => ({
      content: fs.readFileSync(file, "utf8"),
      extension: path.extname(file).slice(1),
    }))
  );
}

// All tests need the same bundle scan; compute it once.
interface BundledSources {
  files: string[];
  candidates: string[];
  // Candidates from the modules the webview bundles today (a subset of `candidates`).
  bundledCandidates: Set<string>;
}
let bundledSources: Promise<BundledSources> | null = null;
function loadBundledSources(): Promise<BundledSources> {
  bundledSources ??= getBundledSourceFiles().then((bundled) => {
    const files = [...new Set([...bundled, ...getImportableRendererFiles()])];
    return {
      files,
      candidates: readCandidates(files),
      bundledCandidates: new Set(readCandidates(bundled)),
    };
  });
  return bundledSources;
}

// Desktop globals.css compiled against the webview candidates, so theme tree-shaking matches.
let desktopCompiledCss: Promise<string> | null = null;
function loadDesktopCss(): Promise<string> {
  desktopCompiledCss ??= (async () => {
    const { candidates } = await loadBundledSources();
    const compiler = await compile(fs.readFileSync(desktopCssPath, "utf8"), {
      base: path.dirname(desktopCssPath),
      from: desktopCssPath,
      onDependency: () => undefined,
    });
    return compiler.build(candidates);
  })();
  return desktopCompiledCss;
}

let webviewCompiledCss: Promise<string> | null = null;
function loadWebviewCss(): Promise<string> {
  webviewCompiledCss ??= esbuildConfig.compileWebviewCss().then((result) => result.css);
  return webviewCompiledCss;
}

/*
 * Classes the desktop stylesheet defines for desktop-only surfaces. The class-selector check
 * skips them because the webview never renders those surfaces. Exact names, not prefixes: a new
 * desktop class used by an importable module fails the guard until someone decides whether the
 * webview needs it. The check also fails when a listed name stops being desktop-only.
 */
const DESKTOP_ONLY_CLASSES = new Set([
  // Electron titlebar insets and drag regions: VS Code owns the window chrome.
  "titlebar-drag",
  "titlebar-no-drag",
  "titlebar-safe-left",
  "titlebar-safe-left-gutter-4",
  "titlebar-safe-right",
  "titlebar-safe-right-gutter-2",
  "titlebar-safe-right-gutter-3",
  "titlebar-safe-right-minus-sidebar",
  // Mobile app shell: these rules live in the desktop shell's (max-width: 768px) and
  // (pointer: coarse) media blocks (sidebar overlay, sticky header, touch rows). The webview has
  // no app shell and does not bundle these components.
  "mobile-bottom-inset-host",
  "mobile-header-spacer",
  "mobile-hide-right-sidebar",
  "mobile-layout",
  "mobile-main-content",
  "mobile-menu-btn",
  "mobile-overlay",
  "mobile-sidebar",
  "mobile-sidebar-collapsed",
  "mobile-sticky-header",
  "mobile-touch-row",
  // Project sidebar only: the webview shows one workspace and no project sidebar.
  "react-colorful",
  "section-color-picker",
  "subagent-connector-active",
  "subagent-connector-elbow-active",
  "workspace-status-dot-active",
  // First-run tutorial overlay: desktop only.
  "tutorial-highlight",
]);

function classSelectors(css: string): Set<string> {
  return new Set([...css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((match) => match[1]));
}

function declaredCustomProperties(css: string): Set<string> {
  const declared = new Set<string>();
  for (const match of css.matchAll(/(--[\w-]+)\s*:/g)) declared.add(match[1]);
  for (const match of css.matchAll(/@property\s+(--[\w-]+)/g)) declared.add(match[1]);
  return declared;
}

// Only fallback-free references: `var(--x, fallback)` still renders when --x is undefined.
function referencedCustomProperties(text: string): Set<string> {
  return new Set([...text.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((match) => match[1]));
}

describe("webview stylesheet", () => {
  test("compiles every desktop utility used by webview-importable components", async () => {
    const { candidates } = await loadBundledSources();

    const desktop = await __unstable__loadDesignSystem(fs.readFileSync(desktopCssPath, "utf8"), {
      base: path.dirname(desktopCssPath),
    });
    const webview = await __unstable__loadDesignSystem(fs.readFileSync(webviewCssPath, "utf8"), {
      base: path.dirname(webviewCssPath),
    });

    const desktopCss = desktop.candidatesToCss(candidates);
    const webviewCss = webview.candidatesToCss(candidates);
    const missing = candidates.filter((_, i) => desktopCss[i] != null && webviewCss[i] == null);

    if (missing.length > 0) {
      throw new Error(
        `Utilities used by webview-importable components compile on desktop but not in the webview: ` +
          `${missing.sort().join(", ")}. ${FIX_HINT}`
      );
    }
  }, 30_000);

  test("defines every desktop custom property the webview references", async () => {
    const { files: sourceFiles } = await loadBundledSources();

    const webviewCss = await loadWebviewCss();
    const desktopCss = await loadDesktopCss();

    const references = referencedCustomProperties(webviewCss);
    for (const file of sourceFiles) {
      for (const name of referencedCustomProperties(fs.readFileSync(file, "utf8")))
        references.add(name);
    }

    const desktopDeclared = declaredCustomProperties(desktopCss);
    const webviewDeclared = declaredCustomProperties(webviewCss);
    const missing = [...references].filter(
      (name) => desktopDeclared.has(name) && !webviewDeclared.has(name)
    );

    if (missing.length > 0) {
      throw new Error(
        `Custom properties referenced by the webview are declared on desktop but not in the webview: ` +
          `${missing.sort().join(", ")}. ${FIX_HINT}`
      );
    }
  }, 30_000);

  // Plain classes (keyframe animations, base resets, hand-written rules in globals.css) are
  // not Tailwind utilities, so the utility check cannot see them, and the webview compiles its
  // own @source scan, so a class the bundle uses from an unscanned module is caught here too.
  test("defines every desktop class selector used by webview-importable components", async () => {
    const { candidates, bundledCandidates } = await loadBundledSources();
    const desktopClasses = classSelectors(await loadDesktopCss());
    const webviewClasses = classSelectors(await loadWebviewCss());

    const missing = [
      ...new Set(
        candidates.filter(
          (candidate) =>
            /^-?[_a-zA-Z][\w-]*$/.test(candidate) &&
            desktopClasses.has(candidate) &&
            !webviewClasses.has(candidate) &&
            !DESKTOP_ONLY_CLASSES.has(candidate)
        )
      ),
    ];
    if (missing.length > 0) {
      throw new Error(
        `Classes used by webview-importable components have desktop rules but none in the webview: ` +
          `${missing.sort().join(", ")}. ${FIX_HINT} If the class only matters on desktop, add it ` +
          `to DESKTOP_ONLY_CLASSES with a reason.`
      );
    }

    // A listed class stops being desktop-only once the webview bundle renders it (for example a
    // shared component starts using it): its desktop rule must then exist in the webview too.
    const stale = [...DESKTOP_ONLY_CLASSES].filter(
      (name) => webviewClasses.has(name) || !desktopClasses.has(name) || bundledCandidates.has(name)
    );
    if (stale.length > 0) {
      throw new Error(
        `DESKTOP_ONLY_CLASSES lists classes that are no longer desktop-only (rendered by the ` +
          `webview bundle, defined in the webview, or gone from the desktop CSS): ` +
          `${stale.sort().join(", ")}. Remove them from the list and give the webview their rule.`
      );
    }
  }, 30_000);
});
