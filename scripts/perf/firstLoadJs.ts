#!/usr/bin/env bun
/**
 * Report the JS a renderer build loads before the app starts ("first load"): index.html's
 * module scripts and modulepreloads plus their static imports, transitively (`import()` loads
 * later). Why (T3, #5971): later PRs cut first-load JS for browser mode and need one
 * deterministic number, plus a guard that keeps modules they made lazy off the first load.
 * Served sizes are the `.br`/`.gz` siblings from scripts/precompress-static.ts, because
 * `xum server` sends those bytes. It skips files under 1 KiB, which are then sent raw.
 *
 * Usage: bun scripts/perf/firstLoadJs.ts [distDir] [--json] [--forbid <substring>]...
 * Exit codes: 0 ok, 1 a forbidden source is on the first load, 2 unusable input.
 */
import * as fs from "fs";
import * as path from "path";

// Source-map path substrings never allowed on the first load. Later T3 PRs add the module
// they make lazy (e.g. `node_modules/lottie-web/`) so it cannot come back.
export const FIRST_LOAD_FORBIDDEN_SOURCES: readonly string[] = [
  "node_modules/lottie-web/",
  "node_modules/ghostty-web/",
];

function fail(message: string): never {
  console.error(`firstLoadJs: ${message}`);
  process.exit(2);
}

/** Resolves an asset reference and asserts it is an existing file inside dist. */
function resolveAsset(distDir: string, resolved: string, referrer: string): string {
  const relative = path.relative(distDir, resolved);
  const inside = !relative.startsWith("..") && !path.isAbsolute(relative);
  if (!inside || !fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
    fail(`${referrer} references ${resolved}, which is not a file inside ${distDir}`);
  }
  return resolved;
}

const ATTRIBUTE = /([^\s="'<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function htmlRoots(distDir: string): string[] {
  const indexPath = path.join(distDir, "index.html");
  if (!fs.existsSync(indexPath)) fail(`${indexPath} not found (run make build-renderer first)`);
  const html = fs.readFileSync(indexPath, "utf-8");
  const roots: string[] = [];
  for (const [, tag, rest] of html.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const attrs = new Map<string, string>();
    for (const m of rest.matchAll(ATTRIBUTE)) {
      attrs.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
    }
    const isScript = tag.toLowerCase() === "script";
    const isRoot = isScript
      ? attrs.get("type") === "module"
      : attrs.get("rel")?.toLowerCase().split(/\s+/).includes("modulepreload") === true;
    const href = attrs.get(isScript ? "src" : "href");
    if (!isRoot || href == null) continue; // inline boot scripts, stylesheets, icons
    // vite `base: "./"` writes `./main-<hash>.js`; a leading `/` means the dist root.
    const target = href.startsWith("/") ? path.join(distDir, href) : path.resolve(distDir, href);
    roots.push(resolveAsset(distDir, target, "index.html"));
  }
  if (roots.length === 0) fail(`${distDir}/index.html has no module script or modulepreload`);
  return roots;
}

/** Follows static imports only: dynamic `import()` and `__vite__mapDeps` strings are not first load. */
function firstLoadFiles(distDir: string): Map<string, string> {
  const transpiler = new Bun.Transpiler({ loader: "js" });
  const code = new Map<string, string>();
  const queue = htmlRoots(distDir);
  for (let file = queue.shift(); file != null; file = queue.shift()) {
    if (code.has(file)) continue;
    const source = fs.readFileSync(file, "utf-8");
    code.set(file, source);
    const referrer = path.relative(distDir, file);
    for (const entry of transpiler.scanImports(source)) {
      if (entry.kind !== "import-statement") continue;
      if (!/^\.\.?\//.test(entry.path)) fail(`${referrer} imports bare specifier "${entry.path}"`);
      queue.push(resolveAsset(distDir, path.resolve(path.dirname(file), entry.path), referrer));
    }
  }
  return code;
}

function sourceMapSources(file: string, source: string, referrer: string): string[] {
  const url = /\/\/# sourceMappingURL=(\S+)\s*$/.exec(source)?.[1];
  const mapPath =
    url != null && !url.startsWith("data:") ? path.resolve(path.dirname(file), url) : `${file}.map`;
  if (!fs.existsSync(mapPath))
    fail(`cannot check forbidden sources: ${referrer} has no source map`);
  const { sources } = JSON.parse(fs.readFileSync(mapPath, "utf-8")) as { sources?: unknown };
  if (!Array.isArray(sources)) fail(`source map of ${referrer} has no sources array`);
  return sources.map((entry) => String(entry).replaceAll("\\", "/"));
}

function servedSize(file: string, extension: string, rawBytes: number): [number, boolean] {
  const sibling = fs.statSync(`${file}${extension}`, { throwIfNoEntry: false });
  return sibling?.isFile() ? [sibling.size, true] : [rawBytes, false];
}

const KIB = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** A right-aligned table cell; `*` marks a file served raw for lack of a precompressed sibling. */
function kib(bytes: number, precompressed = true): string {
  return `${KIB.format(bytes / 1024)}${precompressed ? " " : "*"}`.padStart(12);
}

function main(argv: string[]): void {
  let distArg: string | undefined;
  let json = false;
  const patterns = [...FIRST_LOAD_FORBIDDEN_SOURCES];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--forbid" && /^[^-]/.test(argv[i + 1] ?? "")) patterns.push(argv[++i]);
    else if (arg.startsWith("-") || distArg != null) fail(`bad or incomplete argument ${arg}`);
    else distArg = arg;
  }
  const distDir = path.resolve(distArg ?? "dist");
  const relative = (file: string) => path.relative(distDir, file).replaceAll("\\", "/");

  const code = firstLoadFiles(distDir);
  const files = [...code.keys()].map((file) => {
    const rawBytes = fs.statSync(file).size;
    const [brBytes, br] = servedSize(file, ".br", rawBytes);
    const [gzipBytes, gzip] = servedSize(file, ".gz", rawBytes);
    return { file: relative(file), rawBytes, brBytes, gzipBytes, precompressed: { br, gzip } };
  });
  files.sort((a, b) => b.rawBytes - a.rawBytes || a.file.localeCompare(b.file));
  const totals = { files: files.length, rawBytes: 0, brBytes: 0, gzipBytes: 0 };
  for (const f of files)
    for (const key of ["rawBytes", "brBytes", "gzipBytes"] as const) totals[key] += f[key];

  const violations: Array<{ file: string; source: string; pattern: string }> = [];
  for (const [file, source] of patterns.length > 0 ? code : []) {
    for (const mapSource of sourceMapSources(file, source, relative(file))) {
      for (const pattern of patterns.filter((p) => mapSource.includes(p))) {
        violations.push({ file: relative(file), source: mapSource, pattern });
      }
    }
  }

  if (json) {
    const forbidden = { patterns, violations };
    console.log(JSON.stringify({ distDir, files, totals, forbidden }, null, 2));
  } else {
    const width = Math.max(20, ...files.map((f) => f.file.length));
    const line = (name: string, ...cells: string[]) =>
      console.log(name.padEnd(width) + cells.join(""));
    line("file", ...["raw KiB ", "br KiB ", "gz KiB "].map((h) => h.padStart(12)));
    for (const f of files) {
      const { br, gzip } = f.precompressed;
      line(f.file, kib(f.rawBytes), kib(f.brBytes, br), kib(f.gzipBytes, gzip));
    }
    const { rawBytes, brBytes, gzipBytes } = totals;
    line(`total (${totals.files} files)`, kib(rawBytes), kib(brBytes), kib(gzipBytes));
    if (files.some((f) => !f.precompressed.br || !f.precompressed.gzip)) {
      console.log("* no precompressed sibling: xum server sends the raw file");
    }
  }

  for (const v of violations) {
    console.error(`forbidden on first load: ${v.file} has ${v.source} (matches "${v.pattern}")`);
  }
  if (violations.length > 0) process.exit(1);
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
