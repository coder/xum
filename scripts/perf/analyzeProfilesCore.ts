/**
 * Offline CPU-profile analyzer: hotspot leaderboard, baseline/candidate diff and folded stacks.
 *
 * Pure logic only; the CLI next to it (`analyzeProfiles.ts`) finds files, reads them and loads
 * source maps. Inputs are V8 CPU profiles: the perf E2E `chrome-cpu-profile.json` files from
 * `.github/workflows/perf-profiles.yml` and `.cpuprofile` files from Node, Bun or Chrome DevTools.
 *
 * Timing model: sample i weighs `timeDeltas[i]` microseconds. Sampled time (the sum of weights) and
 * wall duration (`endTime - startTime`) are kept apart. Diffs normalize by wall duration, because
 * scenario runs of different length would otherwise rank as regressions.
 */
import { z } from "zod";

export type Category =
  | "app"
  | "node_modules"
  | "internal"
  | "extension"
  | "gc"
  | "program"
  | "idle";

const CATEGORIES: readonly Category[] = [
  "app",
  "node_modules",
  "internal",
  "extension",
  "gc",
  "program",
  "idle",
];

/** A V8 call frame. Line and column are 0-based, -1 when unknown. */
export interface Frame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

/** One distinct call stack (root to leaf, without the synthetic `(root)` frame) and its samples. */
export interface ProfileStack {
  frames: Frame[];
  weightUs: number;
  count: number;
}

/**
 * The normalized model every input reader produces, and the extension point of this analyzer.
 * Today only V8 CPU profiles are read (`readCpuProfile`). Future inputs, such as Long Animation
 * Frame script attributions and backend loop-delay rings from the flight recorder bundle, become
 * additional readers that return this same model; the analysis and outputs stay unchanged.
 */
export interface NormalizedProfile {
  label: string;
  wallDurationMs: number;
  stacks: ProfileStack[];
}

export interface ReadProfile {
  profile: NormalizedProfile;
  warnings: string[];
}

export type ProfileRead =
  | ({ ok: true } & ReadProfile)
  | { ok: false; label: string; reason: string };

const CallFrameSchema = z.object({
  functionName: z.string(),
  url: z.string(),
  lineNumber: z.number().int(),
  columnNumber: z.number().int(),
  scriptId: z.union([z.string(), z.number()]).optional(),
});

const CpuProfileSchema = z.object({
  nodes: z
    .array(
      z.object({
        id: z.number().int(),
        callFrame: CallFrameSchema,
        hitCount: z.number().int().nonnegative().optional(),
        children: z.array(z.number().int()).optional(),
        parent: z.number().int().optional(),
        positionTicks: z
          .array(z.object({ line: z.number().int(), ticks: z.number().int() }))
          .optional(),
      })
    )
    .min(1),
  startTime: z.number(),
  endTime: z.number(),
  samples: z.array(z.number().int()),
  timeDeltas: z.array(z.number()),
});

type CpuProfile = z.infer<typeof CpuProfileSchema>;

function isRootFrame(frame: Frame): boolean {
  return frame.functionName === "(root)" && frame.url === "";
}

/** Checks the node graph; returns each node's parent index (-1 for roots) or a failure reason. */
function linkParents(
  profile: CpuProfile
): { parents: Int32Array; index: Map<number, number> } | string {
  const index = new Map<number, number>();
  for (const [i, node] of profile.nodes.entries()) {
    if (index.has(node.id)) return `duplicate node id ${node.id}`;
    index.set(node.id, i);
  }
  const parents = new Int32Array(profile.nodes.length).fill(-1);
  const setParent = (childIndex: number, parentIndex: number): string | undefined => {
    const current = parents[childIndex];
    if (current !== -1 && current !== parentIndex) {
      return `node ${profile.nodes[childIndex].id} has more than one parent`;
    }
    parents[childIndex] = parentIndex;
    return undefined;
  };
  for (const [i, node] of profile.nodes.entries()) {
    for (const child of node.children ?? []) {
      const childIndex = index.get(child);
      if (childIndex === undefined) return `node ${node.id} links unknown node ${child}`;
      const error = setParent(childIndex, i);
      if (error) return error;
    }
  }
  // Some writers (Node's legacy format, trimmed exports) link nodes by `parent` instead.
  for (const [i, node] of profile.nodes.entries()) {
    if (node.parent === undefined) continue;
    const parentIndex = index.get(node.parent);
    if (parentIndex === undefined) return `node ${node.id} has unknown parent ${node.parent}`;
    const error = setParent(i, parentIndex);
    if (error) return error;
  }
  // Cycle check: walk up from every node; 1 = on the current walk, 2 = known to reach a root.
  const state = new Uint8Array(profile.nodes.length);
  for (let start = 0; start < profile.nodes.length; start++) {
    const walk: number[] = [];
    let at = start;
    while (at !== -1 && state[at] !== 2) {
      if (state[at] === 1) return `cycle through node ${profile.nodes[at].id}`;
      state[at] = 1;
      walk.push(at);
      at = parents[at];
    }
    for (const visited of walk) state[visited] = 2;
  }
  return { parents, index };
}

function describeZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue.path.slice(0, 4).map(String).join(".");
  return `${path === "" ? "profile" : path}: ${issue.message}`;
}

/** Reads one parsed V8 CPU profile into the normalized model, or explains why it is unusable. */
export function readCpuProfile(json: unknown, label: string): ProfileRead {
  const fail = (reason: string): ProfileRead => ({ ok: false, label, reason });
  const parsed = CpuProfileSchema.safeParse(json);
  if (!parsed.success) return fail(`not a valid CPU profile: ${describeZodError(parsed.error)}`);
  const profile = parsed.data;
  if (profile.endTime < profile.startTime) return fail("endTime is before startTime");
  if (profile.samples.length !== profile.timeDeltas.length) {
    return fail(
      `samples (${profile.samples.length}) and timeDeltas (${profile.timeDeltas.length}) differ in length`
    );
  }
  const linked = linkParents(profile);
  if (typeof linked === "string") return fail(linked);
  const { parents, index } = linked;

  const weightUs = new Float64Array(profile.nodes.length);
  const counts = new Uint32Array(profile.nodes.length);
  let negativeDeltas = 0;
  for (const [i, sample] of profile.samples.entries()) {
    const nodeIndex = index.get(sample);
    if (nodeIndex === undefined) return fail(`sample ${i} references unknown node ${sample}`);
    let delta = profile.timeDeltas[i];
    // Chrome reorders a few samples, which shows up as small negative deltas (about -1 ms). They
    // count as zero time; the warning keeps the correction visible.
    if (delta < 0) {
      negativeDeltas++;
      delta = 0;
    }
    weightUs[nodeIndex] += delta;
    counts[nodeIndex]++;
  }

  const stacks: ProfileStack[] = [];
  for (let i = 0; i < profile.nodes.length; i++) {
    if (counts[i] === 0) continue;
    const frames: Frame[] = [];
    for (let at = i; at !== -1; at = parents[at]) {
      const { functionName, url, lineNumber, columnNumber } = profile.nodes[at].callFrame;
      const frame = { functionName, url, lineNumber, columnNumber };
      if (!isRootFrame(frame)) frames.push(frame);
    }
    frames.reverse();
    stacks.push({ frames, weightUs: weightUs[i], count: counts[i] });
  }
  const warnings =
    negativeDeltas > 0
      ? [`${negativeDeltas} negative timeDeltas clamped to 0 (sample reordering)`]
      : [];
  return {
    ok: true,
    profile: { label, wallDurationMs: (profile.endTime - profile.startTime) / 1000, stacks },
    warnings,
  };
}

const CPU_PROFILE_KEYS = new Set(["nodes", "startTime", "endTime", "samples", "timeDeltas"]);

/**
 * Cheap discovery probe on the first bytes of a `.json` file: true when the top-level object's first
 * key is a CPU-profile key. Lets the CLI skip traces and summaries without parsing them in full.
 */
export function looksLikeCpuProfile(prefix: string): boolean {
  const match = /^\uFEFF?\s*\{\s*"([^"\\]*)"/.exec(prefix);
  return match !== null && CPU_PROFILE_KEYS.has(match[1]);
}

/** An original position from a source map. `source` is already a stable identity; line is 0-based. */
export interface SourceLocation {
  source: string;
  line: number;
  /** 0-based original column, when the map has one. */
  column?: number;
  name?: string;
}

export type SourceResolver = (frame: Frame) => SourceLocation | undefined;

export interface FrameInfo {
  /** `location:name:line`; identical frames across profiles and runs share it. */
  key: string;
  name: string;
  /** Original source when mapped, otherwise the script URL. */
  location: string;
  /** 1-based; 0 when unknown. */
  line: number;
  /**
   * 1-based column: the original column of a mapped frame, the generated column of an unmapped
   * script frame, 0 when unknown. Minified code (bundles, and one-line dependencies behind a map)
   * puts many functions on one line, often with the same short or anonymous name, so keys need it.
   */
  column: number;
  category: Category;
  mapped: boolean;
  /** Script URL of the frame, also kept for mapped frames. */
  url: string;
}

function classifyFrame(frame: { functionName: string; url: string; source?: string }): Category {
  const { functionName, url } = frame;
  if (url === "") {
    if (functionName === "(garbage collector)") return "gc";
    if (functionName === "(program)") return "program";
    if (functionName === "(idle)") return "idle";
    // V8 natives (`RegExp: ...`) and injected evaluate() code have no script URL.
    return "internal";
  }
  if (/^(chrome|moz)-extension:\/\//.test(url)) return "extension";
  if (/^(node:|internal\/|electron\/|chrome:|devtools:)/.test(url) || url.includes("/js2c/")) {
    return "internal";
  }
  return /(^|[/\\])node_modules[/\\]/.test(frame.source ?? url) ? "node_modules" : "app";
}

/**
 * Script URL as a frame identity. Loopback dev and test servers listen on a random port per run
 * (the perf E2E server window loads `http://127.0.0.1:<port>/main-<hash>.js`), so the port is
 * dropped; otherwise the same function would never match across runs.
 */
function normalizeScriptUrl(url: string): string {
  return url.replace(/^(https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])):\d+(?=\/|$)/i, "$1");
}

/** Builds a caching frame identifier. The resolver is only asked about frames with a script URL. */
export function createFrameIdentifier(resolve?: SourceResolver): (frame: Frame) => FrameInfo {
  const cache = new Map<string, FrameInfo>();
  return (frame) => {
    const cacheKey = `${frame.url}\0${frame.lineNumber}\0${frame.columnNumber}\0${frame.functionName}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const mapped = frame.url !== "" && resolve !== undefined ? resolve(frame) : undefined;
    const name = mapped?.name ?? (frame.functionName === "" ? "(anonymous)" : frame.functionName);
    const location = mapped?.source ?? normalizeScriptUrl(frame.url);
    const line = mapped ? mapped.line + 1 : Math.max(frame.lineNumber + 1, 0);
    const column = mapped
      ? (mapped.column ?? -1) + 1
      : frame.url === ""
        ? 0
        : Math.max(frame.columnNumber + 1, 0);
    const info: FrameInfo = {
      key: column > 0 ? `${location}:${name}:${line}:${column}` : `${location}:${name}:${line}`,
      name,
      location,
      line,
      column,
      category: classifyFrame({ ...frame, source: mapped?.source }),
      mapped: mapped !== undefined,
      url: frame.url,
    };
    cache.set(cacheKey, info);
    return info;
  };
}

export interface Entry {
  info: FrameInfo;
  selfUs: number;
  totalUs: number;
  selfSamples: number;
}

export interface ProfileStats {
  label: string;
  wallMs: number;
  sampledMs: number;
  samples: number;
  warnings: string[];
}

export interface Analysis {
  profiles: ProfileStats[];
  wallMs: number;
  sampledUs: number;
  categoryUs: Record<Category, number>;
  entries: Map<string, Entry>;
  /** Self time in app script frames that are not source mapped (`.js` bundles). */
  unmappedBundleUs: number;
}

function isBundleScript(info: FrameInfo): boolean {
  return info.category === "app" && !info.mapped && /\.[cm]?js([?#].*)?$/.test(info.url);
}

/** Sums every profile into one leaderboard. Profile warnings come from `readCpuProfile`. */
export function analyzeProfiles(
  reads: ReadProfile[],
  identify: (frame: Frame) => FrameInfo
): Analysis {
  const categoryUs = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  const entries = new Map<string, Entry>();
  const profiles: ProfileStats[] = [];
  let wallMs = 0;
  let sampledUs = 0;
  let unmappedBundleUs = 0;
  const entryFor = (info: FrameInfo): Entry => {
    let entry = entries.get(info.key);
    if (!entry) {
      entry = { info, selfUs: 0, totalUs: 0, selfSamples: 0 };
      entries.set(info.key, entry);
    }
    return entry;
  };
  for (const { profile, warnings } of reads) {
    let profileUs = 0;
    let samples = 0;
    for (const stack of profile.stacks) {
      if (stack.frames.length === 0) continue;
      const infos = stack.frames.map(identify);
      const leaf = infos[infos.length - 1];
      profileUs += stack.weightUs;
      samples += stack.count;
      categoryUs[leaf.category] += stack.weightUs;
      if (isBundleScript(leaf)) unmappedBundleUs += stack.weightUs;
      // Total time counts each key once per sample, so recursion (A -> B -> A) is not doubled.
      const seen = new Set<string>();
      for (const info of infos) {
        if (seen.has(info.key)) continue;
        seen.add(info.key);
        entryFor(info).totalUs += stack.weightUs;
      }
      const leafEntry = entryFor(leaf);
      leafEntry.selfUs += stack.weightUs;
      leafEntry.selfSamples += stack.count;
    }
    wallMs += profile.wallDurationMs;
    sampledUs += profileUs;
    profiles.push({
      label: profile.label,
      wallMs: profile.wallDurationMs,
      sampledMs: profileUs / 1000,
      samples,
      warnings,
    });
  }
  return { profiles, wallMs, sampledUs, categoryUs, entries, unmappedBundleUs };
}

export interface ReportOptions {
  top: number;
  sort: "self" | "total";
  includeIdle: boolean;
  /** Diff rows with |change| below this many ms/s are hidden. */
  minChange: number;
}

export interface InputSummary {
  read: number;
  skipped: Array<{ path: string; reason: string }>;
  ignored: Array<{ path: string; reason: string }>;
}

export interface LeaderboardRow {
  key: string;
  function: string;
  location: string;
  line: number;
  /** 1-based column (original when mapped, generated when unmapped); 0 when unknown. */
  column: number;
  category: Category;
  selfMs: number;
  /** Share of sampled time (idle excluded unless includeIdle), 0..1. */
  selfShare: number;
  totalMs: number;
  totalShare: number;
  selfSamples: number;
}

export interface SideReport {
  inputs: InputSummary;
  profiles: ProfileStats[];
  totals: {
    wallMs: number;
    sampledMs: number;
    idleMs: number;
    shareBaseMs: number;
    unmappedBundleMs: number;
  };
  categories: Array<{ category: Category; selfMs: number; share: number | null }>;
  leaderboard: LeaderboardRow[];
}

export interface DiffRow {
  key: string;
  function: string;
  location: string;
  line: number;
  /** 1-based column (original when mapped, generated when unmapped); 0 when unknown. */
  column: number;
  category: Category;
  baselineMsPerSec: number;
  candidateMsPerSec: number;
  changeMsPerSec: number;
}

export interface Report {
  version: 1;
  mode: "leaderboard" | "diff";
  options: ReportOptions;
  candidate: SideReport;
  baseline?: SideReport;
  diff?: { rows: DiffRow[]; hiddenBelowThreshold: number };
  warnings: string[];
}

export interface Side {
  inputs: InputSummary;
  analysis: Analysis;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sideReport(side: Side, options: ReportOptions): SideReport {
  const { analysis } = side;
  const base = analysis.sampledUs - (options.includeIdle ? 0 : analysis.categoryUs.idle);
  // Shares stay unrounded so JSON consumers keep full precision; Markdown rounds for display.
  const share = (us: number): number => (base > 0 ? us / base : 0);
  const rows = [...analysis.entries.values()]
    .filter((e) => options.includeIdle || e.info.category !== "idle")
    .sort((a, b) => {
      const diff = options.sort === "total" ? b.totalUs - a.totalUs : b.selfUs - a.selfUs;
      return diff !== 0 ? diff : compareStrings(a.info.key, b.info.key);
    })
    .slice(0, options.top)
    .map(
      (e): LeaderboardRow => ({
        key: e.info.key,
        function: e.info.name,
        location: e.info.location,
        line: e.info.line,
        column: e.info.column,
        category: e.info.category,
        selfMs: round(e.selfUs / 1000),
        selfShare: share(e.selfUs),
        totalMs: round(e.totalUs / 1000),
        totalShare: share(e.totalUs),
        selfSamples: e.selfSamples,
      })
    );
  return {
    inputs: side.inputs,
    profiles: analysis.profiles.map((p) => ({
      ...p,
      wallMs: round(p.wallMs),
      sampledMs: round(p.sampledMs),
    })),
    totals: {
      wallMs: round(analysis.wallMs),
      sampledMs: round(analysis.sampledUs / 1000),
      idleMs: round(analysis.categoryUs.idle / 1000),
      shareBaseMs: round(base / 1000),
      unmappedBundleMs: round(analysis.unmappedBundleUs / 1000),
    },
    categories: CATEGORIES.map((category) => ({
      category,
      selfMs: round(analysis.categoryUs[category] / 1000),
      share:
        category === "idle" && !options.includeIdle ? null : share(analysis.categoryUs[category]),
    })),
    leaderboard: rows,
  };
}

function diffRows(
  baseline: Analysis,
  candidate: Analysis,
  options: ReportOptions
): { rows: DiffRow[]; hiddenBelowThreshold: number } {
  // Rate = self ms per second of wall time. selfUs / wallMs has exactly that unit.
  const rate = (analysis: Analysis, key: string): number => {
    const entry = analysis.entries.get(key);
    return entry && analysis.wallMs > 0 ? entry.selfUs / analysis.wallMs : 0;
  };
  // Keys include the original line, so a function that moved lines between versions shows as one
  // removed and one added row. Matching by name instead would need proof that the name is unique
  // in its file, which sampled frames cannot give (two same-named functions, one sampled per side).
  const keys = new Set([...baseline.entries.keys(), ...candidate.entries.keys()]);
  const rows: DiffRow[] = [];
  let hidden = 0;
  for (const key of keys) {
    const entry = candidate.entries.get(key) ?? baseline.entries.get(key);
    if (!entry || (!options.includeIdle && entry.info.category === "idle")) continue;
    const before = rate(baseline, key);
    const after = rate(candidate, key);
    const change = after - before;
    if (Math.abs(change) < options.minChange) {
      hidden++;
      continue;
    }
    rows.push({
      key,
      function: entry.info.name,
      location: entry.info.location,
      line: entry.info.line,
      column: entry.info.column,
      category: entry.info.category,
      baselineMsPerSec: round(before),
      candidateMsPerSec: round(after),
      changeMsPerSec: round(change),
    });
  }
  rows.sort((a, b) => {
    const diff = Math.abs(b.changeMsPerSec) - Math.abs(a.changeMsPerSec);
    return diff !== 0 ? diff : compareStrings(a.key, b.key);
  });
  return { rows: rows.slice(0, options.top), hiddenBelowThreshold: hidden };
}

/** Builds the report. `warnings` holds input-level warnings from the CLI (for example bad maps). */
export function buildReport(args: {
  candidate: Side;
  baseline?: Side;
  options: ReportOptions;
  warnings?: string[];
}): Report {
  const { candidate, baseline, options } = args;
  const warnings = [...(args.warnings ?? [])];
  const sides: Array<[string, Side]> = baseline
    ? [
        ["baseline", baseline],
        ["candidate", candidate],
      ]
    : [["candidate", candidate]];
  for (const [name, side] of sides) {
    for (const profile of side.analysis.profiles) {
      for (const warning of profile.warnings) warnings.push(`${profile.label}: ${warning}`);
    }
    if (side.analysis.unmappedBundleUs > 0) {
      const unmapped = `${baseline ? `${name} has` : "The profiles have"} ${round(side.analysis.unmappedBundleUs / 1000)} ms of self time in unmapped bundle frames`;
      warnings.push(
        baseline
          ? `${unmapped}; differently hashed or minified bundles make function matching across versions unreliable ` +
              `(pass ${name === "baseline" ? "--baseline-map-dir or --map-dir" : "--map-dir"} with source maps for this side's bundles)`
          : `${unmapped}, which keep bundle names and lines (pass --map-dir with the bundles' source maps)`
      );
    }
    if (baseline && side.analysis.wallMs <= 0) {
      warnings.push(`${name} has zero wall duration, so its rates are reported as 0`);
    }
  }
  return {
    version: 1,
    mode: baseline ? "diff" : "leaderboard",
    options,
    candidate: sideReport(candidate, options),
    ...(baseline
      ? {
          baseline: sideReport(baseline, options),
          diff: diffRows(baseline.analysis, candidate.analysis, options),
        }
      : {}),
    // The same map or profile problem can be reported once per side; list it once.
    warnings: [...new Set(warnings)],
  };
}

/** Short display form of a location: script URLs show their file name only. */
function displayLocation(location: string): string {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i.exec(location);
  if (!match) return location;
  const name = match[3].slice(match[3].lastIndexOf("/") + 1);
  if (name === "") return location;
  // http(s) keeps the host, so a bundle served over http and the same bundle read from file://
  // stay distinguishable.
  return /^https?$/i.test(match[1]) ? `${match[2]}/${name}` : name;
}

/** Longest text shown in one Markdown cell; V8 names regex natives by their whole pattern. */
const MAX_CELL_CHARS = 80;

/**
 * Makes untrusted text (function names, paths, error messages from profiles) safe for a terminal:
 * C0/C1 control characters become visible `\xHH`, so an embedded OSC 52 or CSI sequence cannot
 * rewrite the clipboard or the displayed report. Newlines are kept for callers that fold them.
 */
export function escapeControl(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(
    /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,
    (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`
  );
}

function cell(text: string): string {
  const safe = escapeControl(text);
  const short = safe.length > MAX_CELL_CHARS ? `${safe.slice(0, MAX_CELL_CHARS - 1)}…` : safe;
  const clean = short
    .replace(/[\r\n]+/g, " ")
    .replace(/`/g, "'")
    .replace(/\|/g, "\\|");
  return clean === "" ? "" : `\`${clean}\``;
}

function where(location: string, line: number, column = 0): string {
  if (location === "") return "";
  if (line <= 0) return displayLocation(location);
  return column > 0
    ? `${displayLocation(location)}:${line}:${column}`
    : `${displayLocation(location)}:${line}`;
}

function ms(value: number): string {
  return value.toFixed(1);
}

function pct(share: number | null): string {
  return share === null ? "-" : `${(share * 100).toFixed(1)}%`;
}

function inputLine(name: string, side: SideReport): string {
  const { inputs } = side;
  return (
    `${name}: ${inputs.read} profile(s) read, ${inputs.skipped.length} skipped (malformed), ` +
    `${inputs.ignored.length} ignored (not a CPU profile). ` +
    `Sampled ${ms(side.totals.sampledMs)} ms over ${ms(side.totals.wallMs)} ms of wall time.`
  );
}

function skippedLines(name: string, side: SideReport): string[] {
  return side.inputs.skipped.map(
    (s) => `- ${name}: ${cell(s.path)}: ${escapeControl(s.reason).replace(/[\r\n]+/g, " ")}`
  );
}

export function renderMarkdown(report: Report): string {
  const lines: string[] = [];
  const { options } = report;
  const idleNote = options.includeIdle
    ? "Shares include idle time."
    : "Shares exclude idle time (--include-idle includes it).";
  if (report.baseline && report.diff) {
    lines.push("# CPU profile diff", "");
    lines.push(inputLine("Baseline", report.baseline), "");
    lines.push(inputLine("Candidate", report.candidate), "");
    lines.push(
      "Rates are self ms per second of wall time (ms/s). " +
        `Rows with |change| < ${options.minChange} ms/s are hidden (${report.diff.hiddenBelowThreshold} hidden); ` +
        "this threshold filters small changes, not statistical noise. " +
        "A function whose source line moved between versions shows as one removed and one added row.",
      ""
    );
    lines.push(
      "| # | Function | Location | Category | Baseline ms/s | Candidate ms/s | Change ms/s |"
    );
    lines.push("|---:|---|---|---|---:|---:|---:|");
    for (const [i, row] of report.diff.rows.entries()) {
      const sign = row.changeMsPerSec > 0 ? "+" : "";
      lines.push(
        `| ${i + 1} | ${cell(row.function)} | ${cell(where(row.location, row.line, row.column))} | ${row.category} | ` +
          `${row.baselineMsPerSec.toFixed(2)} | ${row.candidateMsPerSec.toFixed(2)} | ${sign}${row.changeMsPerSec.toFixed(2)} |`
      );
    }
    if (report.diff.rows.length === 0)
      lines.push("| | No changes above the threshold. | | | | | |");
  } else {
    const side = report.candidate;
    lines.push("# CPU profile hotspots", "");
    lines.push(inputLine("Profiles", side), "");
    lines.push(idleNote, "");
    lines.push("## Categories", "", "| Category | Self ms | Share |", "|---|---:|---:|");
    for (const c of side.categories)
      lines.push(`| ${c.category} | ${ms(c.selfMs)} | ${pct(c.share)} |`);
    lines.push("", `## Top ${options.top} by ${options.sort} time`, "");
    lines.push(
      "| # | Function | Location | Category | Self ms | Self % | Total ms | Total % | Samples |"
    );
    lines.push("|---:|---|---|---|---:|---:|---:|---:|---:|");
    for (const [i, row] of side.leaderboard.entries()) {
      lines.push(
        `| ${i + 1} | ${cell(row.function)} | ${cell(where(row.location, row.line, row.column))} | ${row.category} | ` +
          `${ms(row.selfMs)} | ${pct(row.selfShare)} | ${ms(row.totalMs)} | ${pct(row.totalShare)} | ${row.selfSamples} |`
      );
    }
  }
  const skipped = [
    ...(report.baseline ? skippedLines("baseline", report.baseline) : []),
    ...skippedLines(report.baseline ? "candidate" : "skipped", report.candidate),
  ];
  if (skipped.length > 0) lines.push("", "## Skipped files", "", ...skipped);
  if (report.warnings.length > 0) {
    lines.push(
      "",
      "## Warnings",
      "",
      ...report.warnings.map((w) => `- ${escapeControl(w).replace(/[\r\n]+/g, " ")}`)
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderJson(report: Report): string {
  // JSON.stringify escapes C0 controls but not DEL or C1 (U+0080-U+009F, e.g. the CSI U+009B),
  // which some terminals act on. `\uXXXX` escapes keep every parsed value unchanged.
  // eslint-disable-next-line no-control-regex
  const text = JSON.stringify(report, null, 2).replace(
    /[\u007f-\u009f]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
  return `${text}\n`;
}

function foldedLabel(info: FrameInfo): string {
  // The full location, not displayLocation's file name: labels are the stack identity in folded
  // output, so two scripts named index.js must not render (and aggregate) as one frame.
  const location =
    info.location === ""
      ? ""
      : info.line > 0
        ? `${info.location}:${info.line}${info.column > 0 ? `:${info.column}` : ""}`
        : info.location;
  const label = location === "" ? info.name : `${info.name} (${location})`;
  // `;` separates frames and the last space separates the count, so names must not break lines or
  // add frames. Spaces inside a label are fine.
  // Percent-escape instead of substituting, so distinct labels (`a;b`, `a,b`) never collide.
  // Control characters are escaped too: folded output is often printed to a terminal.
  // eslint-disable-next-line no-control-regex
  return label.replace(
    /[%;\u0000-\u001f\u007f-\u009f]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`
  );
}

/**
 * Folded stacks (`root;...;leaf <sampleCount>`), the input format of flamegraph.pl and speedscope.
 * Weights are sample counts, not microseconds. Stacks ending in idle are left out unless
 * includeIdle; the synthetic `(root)` frame is never included.
 */
export function renderFolded(
  profiles: NormalizedProfile[],
  identify: (frame: Frame) => FrameInfo,
  includeIdle: boolean
): string {
  const counts = new Map<string, number>();
  for (const profile of profiles) {
    for (const stack of profile.stacks) {
      if (stack.frames.length === 0 || stack.count === 0) continue;
      const infos = stack.frames.map(identify);
      if (!includeIdle && infos[infos.length - 1].category === "idle") continue;
      const line = infos.map(foldedLabel).join(";");
      counts.set(line, (counts.get(line) ?? 0) + stack.count);
    }
  }
  const lines = [...counts.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([stack, count]) => `${stack} ${count}`);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
