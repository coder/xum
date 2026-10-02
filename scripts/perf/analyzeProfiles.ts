#!/usr/bin/env bun
/**
 * Offline CPU-profile analyzer: hotspot leaderboard, baseline/candidate diff and folded stacks.
 *
 * Local only: it reads profiles and source maps from disk and never uses the network (http(s)
 * source maps are ignored). The logic lives in analyzeProfilesCore.ts and sourceMap.ts next to this
 * file, where the tests cover it; keep this file to argument parsing, file discovery and I/O.
 *
 * Nightly perf profiles:
 *   gh run download <id> -R coder/xum -n perf-artifacts-<id> -D /tmp/perf-<id>
 *   make perf-analyze PROFILES=/tmp/perf-<id>
 *
 * Source maps for nightly profiles: CI does not upload the bundles' .map files, so rebuild the run's
 * headSha the way CI checks it out. A shallow, tag-free checkout is required: src/version.ts embeds
 * `git describe`, so a clone with tags produces different bundle hashes and no map matches.
 *   git init /tmp/xum-<sha> && cd /tmp/xum-<sha>
 *   git fetch --depth 1 --no-tags https://github.com/coder/xum <sha> && git checkout --detach FETCH_HEAD
 *   bun install --frozen-lockfile && make build-renderer && cd -
 *   # Back in a checkout that has this analyzer (the nightly's commit may predate it):
 *   make perf-analyze PROFILES=/tmp/perf-<id> PERF_ANALYZE_ARGS="--map-dir /tmp/xum-<sha>/dist"
 */
import {
  existsSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  analyzeProfiles,
  buildReport,
  createFrameIdentifier,
  looksLikeCpuProfile,
  readCpuProfile,
  renderFolded,
  renderJson,
  renderMarkdown,
  type InputSummary,
  type ReadProfile,
  type ReportOptions,
  type SourceResolver,
} from "./analyzeProfilesCore";
import {
  parseSourceMap,
  mapFrame,
  relativeInside,
  stableSourceId,
  type SourceMapConsumer,
} from "./sourceMap";

const USAGE = `Usage: bun scripts/perf/analyzeProfiles.ts [options] <paths...>

Ranks CPU-profile hotspots (self and total time per function) across V8 CPU profiles, or
compares a baseline set with a candidate set. Offline: no network access.

Paths are files or directories (searched recursively). Explicit files are always parsed. In
directories, *.cpuprofile files are read, and *.json files only when their first bytes look like
a CPU profile (other JSON, such as traces and summaries, is counted as ignored).

Options:
  --baseline <path>    Baseline profile file or directory (repeatable). Enables diff mode: the
                       positional paths become the candidate set, and each function is compared
                       by self ms per second of wall time (ms/s).
  --format <fmt>       markdown (default), json, or folded.
                       folded prints "frame;frame;frame <sampleCount>" lines (root to leaf) for
                       flamegraph.pl or speedscope; weights are sample counts, not time. Not
                       available in diff mode.
  --out <file>         Write the output to <file> instead of stdout.
  --top <n>            Rows in the leaderboard or diff (default 25).
  --sort <key>         Leaderboard order: self (default) or total.
  --include-idle       Count (idle) in shares, the leaderboard and folded output.
  --min-change <ms/s>  Diff mode: hide rows whose |change| is below this (default 1). It filters
                       small changes, not statistical noise.
  --map-dir <dir>      Directory with source maps named <script basename>.map, for example a local
                       build of the same commit (repeatable). Local scripts are also mapped through
                       their sourceMappingURL comment or a sibling .map file.
  --help               Show this help.

Exit status: 0 on success, 1 when no valid profile was read on a required side, 2 on usage errors.`;

class UsageError extends Error {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function displayPath(path: string): string {
  return relativeInside(process.cwd(), path) ?? path;
}

/** Short label for a discovered file: cwd-relative, else relative to the parent of its argument. */
function labelFor(path: string, root: string): string {
  return (
    relativeInside(process.cwd(), path) ??
    relativeInside(dirname(resolve(root)), resolve(path)) ??
    path
  );
}

/** Reads the first bytes of a file for the CPU-profile probe, without loading the whole file. */
function readPrefix(path: string, bytes = 4096): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

interface Discovery {
  candidates: Array<{ path: string; label: string }>;
  ignored: InputSummary["ignored"];
}

function discover(paths: string[]): Discovery {
  const candidates: Discovery["candidates"] = [];
  const ignored: InputSummary["ignored"] = [];
  // Overlapping arguments (a directory and a file inside it) must not count a file twice.
  const seen = new Set<string>();
  const firstVisit = (path: string): boolean => {
    const real = realpathSync(path);
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  };
  const walk = (dir: string, root: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1
    );
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path, root);
      } else if (entry.isFile() && firstVisit(path)) {
        const ext = extname(entry.name).toLowerCase();
        if (ext === ".cpuprofile") {
          candidates.push({ path, label: labelFor(path, root) });
        } else if (ext === ".json") {
          let probe: boolean;
          try {
            probe = looksLikeCpuProfile(readPrefix(path));
          } catch {
            probe = false;
          }
          if (probe) candidates.push({ path, label: labelFor(path, root) });
          else ignored.push({ path: labelFor(path, root), reason: "not a CPU profile" });
        }
      }
    }
  };
  for (const path of paths) {
    if (!existsSync(path)) throw new UsageError(`path not found: ${path}`);
    if (statSync(path).isDirectory()) walk(path, path);
    else if (firstVisit(path)) candidates.push({ path, label: displayPath(path) });
  }
  return { candidates, ignored };
}

function readSide(paths: string[]): { inputs: InputSummary; reads: ReadProfile[] } {
  const { candidates, ignored } = discover(paths);
  const skipped: InputSummary["skipped"] = [];
  const reads: ReadProfile[] = [];
  for (const { path, label } of candidates) {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch (error) {
      skipped.push({ path: label, reason: `invalid JSON: ${errorMessage(error)}` });
      continue;
    }
    const read = readCpuProfile(json, label);
    if (read.ok) reads.push(read);
    else skipped.push({ path: label, reason: read.reason });
  }
  return { inputs: { read: reads.length, skipped, ignored }, reads };
}

/** Script path for file:// URLs; undefined for anything else. */
function scriptPath(url: string): string | undefined {
  if (!url.startsWith("file:")) return isAbsolute(url) ? url : undefined;
  try {
    return fileURLToPath(url);
  } catch {
    return undefined;
  }
}

function scriptBasename(url: string): string | undefined {
  const path = url.replace(/[?#].*$/, "");
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "") return undefined;
  try {
    return decodeURIComponent(name);
  } catch {
    // A malformed %-escape in a profiled URL must not abort the run: match the raw name.
    return name;
  }
}

interface MapSource {
  /** Where the map came from, for warnings. */
  origin: string;
  /** Directory that relative `sources` resolve against. */
  dir: string;
  /** True for maps found through --map-dir, so a --map-dir that matches nothing can be reported. */
  fromMapDir: boolean;
  load: () => unknown;
}

function fileMapSource(mapPath: string, fromMapDir = false): MapSource {
  return {
    origin: displayPath(mapPath),
    dir: dirname(mapPath),
    fromMapDir,
    load: () => JSON.parse(readFileSync(mapPath, "utf8")) as unknown,
  };
}

/** Map candidates in lookup order: sourceMappingURL comment, sibling .map, then --map-dir entries. */
function mapSources(url: string, mapDirs: string[]): MapSource[] {
  const sources: MapSource[] = [];
  const script = scriptPath(url);
  if (script !== undefined && existsSync(script) && statSync(script).isFile()) {
    const scriptDir = dirname(script);
    const text = readFileSync(script, "utf8");
    const at = text.lastIndexOf("sourceMappingURL=");
    const comment =
      at >= 0 ? /^\S+/.exec(text.slice(at + "sourceMappingURL=".length))?.[0] : undefined;
    if (comment !== undefined) {
      const inline = /^data:application\/json[^,]*?(;base64)?,(.*)$/.exec(comment);
      if (inline) {
        sources.push({
          origin: `${displayPath(script)} (inline map)`,
          dir: scriptDir,
          fromMapDir: false,
          load: () =>
            JSON.parse(
              inline[1]
                ? Buffer.from(inline[2], "base64").toString("utf8")
                : decodeURIComponent(inline[2])
            ) as unknown,
        });
      } else if (!/^[a-z][a-z0-9+.-]*:/i.test(comment) || comment.startsWith("file:")) {
        // http(s) and other remote maps are never fetched.
        const mapPath = comment.startsWith("file:")
          ? scriptPath(comment)
          : resolve(scriptDir, decodeURIComponent(comment));
        if (mapPath !== undefined && existsSync(mapPath)) sources.push(fileMapSource(mapPath));
      }
    }
    const sibling = `${script}.map`;
    if (existsSync(sibling)) sources.push(fileMapSource(sibling));
  }
  const name = scriptBasename(url);
  if (name !== undefined) {
    for (const dir of mapDirs) {
      const mapPath = join(dir, `${name}.map`);
      if (existsSync(mapPath)) sources.push(fileMapSource(mapPath, true));
    }
  }
  return sources;
}

/**
 * Resolver with one parsed map per script URL. Map problems become warnings, never failures.
 * Call `finish` after the last frame was resolved: it warns when --map-dir matched no script, the
 * usual sign of a build whose bundle hashes differ from the profiled one.
 */
function createResolver(
  mapDirs: string[],
  warnings: string[]
): { resolve: SourceResolver; finish: () => void } {
  const cwd = process.cwd();
  const lookedUp = new Set<string>();
  let mapDirHits = 0;
  const maps = new Map<string, { map: SourceMapConsumer; dir: string } | null>();
  const stableIds = new Map<string, string>();
  const mapFor = (url: string): { map: SourceMapConsumer; dir: string } | null => {
    const cached = maps.get(url);
    if (cached !== undefined) return cached;
    let found: { map: SourceMapConsumer; dir: string } | null = null;
    const name = scriptBasename(url);
    let candidates: MapSource[] = [];
    try {
      candidates = mapSources(url, mapDirs);
    } catch (error) {
      warnings.push(
        `${name ?? url}: cannot read script for its source map: ${errorMessage(error)}`
      );
    }
    if (name !== undefined && /^(file|https?):/i.test(url)) lookedUp.add(name);
    for (const candidate of candidates) {
      let parsed;
      try {
        parsed = parseSourceMap(candidate.load());
      } catch (error) {
        parsed = { ok: false as const, reason: `unreadable source map: ${errorMessage(error)}` };
      }
      if (parsed.ok) {
        found = { map: parsed.map, dir: candidate.dir };
        if (candidate.fromMapDir) mapDirHits++;
        break;
      }
      warnings.push(`${candidate.origin}: ${parsed.reason}; frames keep bundle locations`);
    }
    maps.set(url, found);
    return found;
  };
  const finish = (): void => {
    if (mapDirs.length === 0 || mapDirHits > 0 || lookedUp.size === 0) return;
    const names = [...lookedUp].sort();
    const shown = names.slice(0, 5).map((n) => `${n}.map`);
    const more = names.length > shown.length ? ` and ${names.length - shown.length} more` : "";
    warnings.push(
      `--map-dir matched no profiled script (looked for ${shown.join(", ")}${more}); ` +
        "frames keep bundle locations. Bundle hashes differ when the build is not the profiled " +
        "commit or was built from a clone with tags (see the header of scripts/perf/analyzeProfiles.ts)"
    );
  };
  const resolve: SourceResolver = (frame) => {
    if (/^https?:/i.test(frame.url) && mapDirs.length === 0) return undefined;
    const entry = mapFor(frame.url);
    if (!entry) return undefined;
    const position = mapFrame(entry.map, frame);
    if (!position) return undefined;
    const idKey = `${entry.dir}\0${position.source}`;
    let source = stableIds.get(idKey);
    if (source === undefined) {
      source = stableSourceId(position.source, { mapDir: entry.dir, cwd });
      stableIds.set(idKey, source);
    }
    return {
      source,
      line: position.line,
      ...(position.name !== undefined ? { name: position.name } : {}),
    };
  };
  return { resolve, finish };
}

function parsePositiveNumber(
  value: string | undefined,
  flag: string,
  fallback: number,
  integer: boolean
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < 0 ||
    (integer && (!Number.isInteger(parsed) || parsed === 0))
  ) {
    throw new UsageError(
      `${flag} must be a ${integer ? "positive integer" : "non-negative number"}, got ${value}`
    );
  }
  return parsed;
}

function main(): number {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      baseline: { type: "string", multiple: true },
      format: { type: "string" },
      out: { type: "string" },
      top: { type: "string" },
      sort: { type: "string" },
      "include-idle": { type: "boolean" },
      "min-change": { type: "string" },
      "map-dir": { type: "string", multiple: true },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (positionals.length === 0) throw new UsageError("no profile paths given");
  const format = values.format ?? "markdown";
  if (format !== "markdown" && format !== "json" && format !== "folded") {
    throw new UsageError(`--format must be markdown, json or folded, got ${format}`);
  }
  const sort = values.sort ?? "self";
  if (sort !== "self" && sort !== "total")
    throw new UsageError(`--sort must be self or total, got ${sort}`);
  const baselinePaths = values.baseline ?? [];
  if (format === "folded" && baselinePaths.length > 0) {
    throw new UsageError("--format folded has no diff form; drop --baseline");
  }
  const mapDirs = values["map-dir"] ?? [];
  for (const dir of mapDirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory())
      throw new UsageError(`--map-dir is not a directory: ${dir}`);
  }
  const options: ReportOptions = {
    top: parsePositiveNumber(values.top, "--top", 25, true),
    sort,
    includeIdle: values["include-idle"] ?? false,
    minChange: parsePositiveNumber(values["min-change"], "--min-change", 1, false),
  };

  const candidate = readSide(positionals);
  const baseline = baselinePaths.length > 0 ? readSide(baselinePaths) : undefined;
  for (const [name, side] of [
    ["candidate", candidate],
    ["baseline", baseline],
  ] as const) {
    if (side && side.reads.length === 0) {
      const details = side.inputs.skipped.map((s) => `\n  ${s.path}: ${s.reason}`).join("");
      console.error(
        `analyze profiles: no valid CPU profile read for the ${name} side ` +
          `(${side.inputs.skipped.length} skipped, ${side.inputs.ignored.length} ignored)${details}`
      );
      return 1;
    }
  }

  const warnings: string[] = [];
  const resolver = createResolver(mapDirs, warnings);
  const identify = createFrameIdentifier(resolver.resolve);
  let output: string;
  if (format === "folded") {
    output = renderFolded(
      candidate.reads.map((r) => r.profile),
      identify,
      options.includeIdle
    );
    resolver.finish();
    // Folded stdout must stay parseable, so input problems and warnings go to stderr.
    reportToStderr(candidate.inputs, [
      ...warnings,
      ...candidate.reads.flatMap((r) => r.warnings.map((w) => `${r.profile.label}: ${w}`)),
    ]);
  } else {
    // Analyze first: resolving frames fills `warnings` with source map problems.
    const candidateSide = {
      inputs: candidate.inputs,
      analysis: analyzeProfiles(candidate.reads, identify),
    };
    const baselineSide = baseline
      ? { inputs: baseline.inputs, analysis: analyzeProfiles(baseline.reads, identify) }
      : undefined;
    resolver.finish();
    const report = buildReport({
      candidate: candidateSide,
      baseline: baselineSide,
      options,
      warnings,
    });
    output = format === "json" ? renderJson(report) : renderMarkdown(report);
  }
  if (values.out) {
    try {
      writeFileSync(values.out, output);
    } catch (error) {
      console.error(`analyze profiles: cannot write --out ${values.out}: ${errorMessage(error)}`);
      return 1;
    }
  } else {
    process.stdout.write(output);
  }
  return 0;
}

function reportToStderr(inputs: InputSummary, warnings: string[]): void {
  const lines = [
    `analyze profiles: read ${inputs.read} profile(s), skipped ${inputs.skipped.length}, ` +
      `ignored ${inputs.ignored.length} non-profile file(s)`,
    ...inputs.skipped.map((s) => `  skipped ${s.path}: ${s.reason}`),
    ...[...new Set(warnings)].map((w) => `  warning: ${w.replace(/[\r\n]+/g, " ")}`),
  ];
  console.error(lines.join("\n"));
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (error instanceof UsageError || (error instanceof TypeError && "code" in error)) {
      // parseArgs reports unknown flags as a TypeError with an ERR_PARSE_ARGS_* code.
      console.error(`analyze profiles: ${error.message}\n\n${USAGE}`);
      process.exitCode = 2;
    } else {
      console.error(`analyze profiles: crashed: ${errorMessage(error)}`);
      process.exitCode = 1;
    }
  }
}
