import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeProfiles,
  buildReport,
  createFrameIdentifier,
  looksLikeCpuProfile,
  readCpuProfile,
  renderFolded,
  type Category,
  type Frame,
  type NormalizedProfile,
  type Report,
  type ReportOptions,
  type SourceResolver,
} from "./analyzeProfilesCore";
import { mapFrame, parseSourceMap, stableSourceId } from "./sourceMap";

const APP = "file:///app/app.js";

interface NodeSpec {
  id: number;
  name: string;
  url?: string;
  line?: number;
  children?: number[];
}

function cpuProfile(
  nodes: NodeSpec[],
  samples: number[],
  timeDeltas: number[],
  endTime?: number
): Record<string, unknown> {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      callFrame: {
        functionName: n.name,
        scriptId: "1",
        url: n.url ?? "",
        lineNumber: n.line ?? -1,
        columnNumber: n.line === undefined ? -1 : 0,
      },
      hitCount: 0,
      ...(n.children ? { children: n.children } : {}),
    })),
    startTime: 0,
    endTime: endTime ?? timeDeltas.reduce((sum, d) => sum + Math.max(d, 0), 0),
    samples,
    timeDeltas,
  };
}

function read(json: unknown, label = "p"): { profile: NormalizedProfile; warnings: string[] } {
  const result = readCpuProfile(json, label);
  if (!result.ok) throw new Error(result.reason);
  return result;
}

/** root -> A -> B -> A (recursion), plus (idle) and (program) at the top level. Times in µs. */
const TREE = cpuProfile(
  [
    { id: 1, name: "(root)", children: [2, 5, 6] },
    { id: 2, name: "A", url: APP, line: 0, children: [3] },
    { id: 3, name: "B", url: APP, line: 1, children: [4] },
    { id: 4, name: "A", url: APP, line: 0 },
    { id: 5, name: "(idle)" },
    { id: 6, name: "(program)" },
  ],
  [3, 4, 4, 5, 6, 2],
  [100, 200, 300, 1000, 400, 500]
);

const OPTIONS: ReportOptions = { top: 25, sort: "self", includeIdle: false, minChange: 1 };

function leaderboard(
  profiles: unknown[],
  options: Partial<ReportOptions> = {},
  resolve?: SourceResolver
): Report {
  const analysis = analyzeProfiles(
    profiles.map((p, i) => read(p, `p${i}`)),
    createFrameIdentifier(resolve)
  );
  return buildReport({
    candidate: { inputs: { read: profiles.length, skipped: [], ignored: [] }, analysis },
    options: { ...OPTIONS, ...options },
  });
}

describe("leaderboard", () => {
  test("self and total time, samples and shares; recursion counts once in total", () => {
    const report = leaderboard([TREE]);
    const rows = report.candidate.leaderboard.map((r) => [
      r.function,
      r.selfMs,
      r.totalMs,
      r.selfSamples,
      r.selfShare,
      r.totalShare,
    ]);
    // Idle (1.0 ms) is left out of the leaderboard and of the share base (2.5 - 1.0 = 1.5 ms).
    // Shares are unrounded fractions of that base (µs / 1500 µs).
    expect(rows).toEqual([
      ["A", 1, 1.1, 3, 1000 / 1500, 1100 / 1500],
      ["(program)", 0.4, 0.4, 1, 400 / 1500, 400 / 1500],
      ["B", 0.1, 0.6, 1, 100 / 1500, 600 / 1500],
    ]);
    expect(report.candidate.totals).toMatchObject({ sampledMs: 2.5, idleMs: 1, shareBaseMs: 1.5 });
    expect(report.candidate.categories.find((c) => c.category === "app")).toEqual({
      category: "app",
      selfMs: 1.1,
      share: 1100 / 1500,
    });
    // A and B run in an unmapped .js bundle; a leaderboard warns too, not only a diff.
    expect(report.warnings).toEqual([
      expect.stringContaining("1.1 ms of self time in unmapped bundle frames"),
    ]);
  });

  test("--include-idle adds idle to the leaderboard and the share base", () => {
    const report = leaderboard([TREE], { includeIdle: true });
    expect(report.candidate.leaderboard.map((r) => [r.function, r.selfShare])).toEqual([
      ["(idle)", 0.4],
      ["A", 0.4],
      ["(program)", 0.16],
      ["B", 0.04],
    ]);
  });

  test("--sort total ranks by inclusive time and sums across profiles", () => {
    const report = leaderboard([TREE, TREE], { sort: "total", top: 2 });
    expect(report.candidate.leaderboard.map((r) => [r.function, r.totalMs])).toEqual([
      ["A", 2.2],
      ["B", 1.2],
    ]);
    expect(report.candidate.profiles.map((p) => p.samples)).toEqual([6, 6]);
  });
});

describe("readCpuProfile", () => {
  test("clamps negative timeDeltas to zero and warns with the count", () => {
    const result = read(
      cpuProfile(
        [
          { id: 1, name: "(root)", children: [2] },
          { id: 2, name: "A", url: APP, line: 0 },
        ],
        [2, 2, 2],
        [300, -50, 200],
        500
      )
    );
    expect(result.profile.stacks).toEqual([
      { frames: [expect.objectContaining({ functionName: "A" })], weightUs: 500, count: 3 },
    ]);
    expect(result.warnings).toEqual(["1 negative timeDeltas clamped to 0 (sample reordering)"]);
  });

  test("accepts parent links instead of children", () => {
    const json = cpuProfile(
      [
        { id: 1, name: "(root)" },
        { id: 2, name: "A", url: APP, line: 0 },
      ],
      [2],
      [10]
    );
    (json.nodes as Array<Record<string, unknown>>)[1].parent = 1;
    expect(read(json).profile.stacks[0].frames.map((f) => f.functionName)).toEqual(["A"]);
  });

  const root = (children: number[]): NodeSpec => ({ id: 1, name: "(root)", children });
  test.each<[string, unknown, RegExp]>([
    ["schema failure", { nodes: "x", samples: [], timeDeltas: [] }, /not a valid CPU profile/],
    [
      "sample referencing a missing node",
      cpuProfile([root([])], [99], [1]),
      /sample 0 references unknown node 99/,
    ],
    ["length mismatch", cpuProfile([root([])], [1, 1], [1]), /differ in length/],
    [
      "cycle",
      cpuProfile(
        [root([]), { id: 2, name: "A", children: [3] }, { id: 3, name: "B", children: [2] }],
        [2],
        [1]
      ),
      /cycle/,
    ],
    [
      "child of two parents",
      cpuProfile(
        [root([2, 3]), { id: 2, name: "A", children: [3] }, { id: 3, name: "B" }],
        [3],
        [1]
      ),
      /more than one parent/,
    ],
    ["unknown child", cpuProfile([root([7])], [1], [1]), /unknown node 7/],
    ["duplicate id", cpuProfile([root([]), { id: 1, name: "A" }], [1], [1]), /duplicate node id 1/],
    ["end before start", cpuProfile([root([])], [1], [1], -5), /endTime is before startTime/],
  ])("rejects %s with a reason", (_name, json, reason) => {
    const result = readCpuProfile(json, "bad");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });
});

describe("frame category", () => {
  test.each<[{ functionName: string; url: string; source?: string }, Category]>([
    [{ functionName: "(garbage collector)", url: "" }, "gc"],
    [{ functionName: "(program)", url: "" }, "program"],
    [{ functionName: "(idle)", url: "" }, "idle"],
    [{ functionName: "RegExp: ^a+", url: "" }, "internal"],
    [{ functionName: "emit", url: "node:events" }, "internal"],
    [{ functionName: "f", url: "internal/process/task_queues" }, "internal"],
    [{ functionName: "f", url: "node:electron/js2c/renderer_init" }, "internal"],
    [{ functionName: "h", url: "chrome-extension://abc/build/installHook.js" }, "extension"],
    [{ functionName: "f", url: "file:///repo/node_modules/react-dom/index.js" }, "node_modules"],
    [{ functionName: "f", url: "file:///repo/dist/main-abc.js" }, "app"],
    // Mapped frames classify by their original source, not the bundle that inlined them.
    [
      {
        functionName: "f",
        url: "file:///repo/dist/main-abc.js",
        source: "node_modules/react/x.js",
      },
      "node_modules",
    ],
  ])("%j is %s", ({ source, ...frame }, category) => {
    const identify = createFrameIdentifier(
      source === undefined ? undefined : () => ({ source, line: 0 })
    );
    expect(identify({ ...frame, lineNumber: -1, columnNumber: -1 }).category).toBe(category);
  });
});

describe("diff", () => {
  /** One profile with a flat list of functions and one sample each; wall time in µs. */
  function flat(wallUs: number, functions: Array<[string, number]>): Record<string, unknown> {
    return cpuProfile(
      [
        { id: 1, name: "(root)", children: functions.map((_, i) => i + 2) },
        ...functions.map(([name], i) => ({ id: i + 2, name, url: APP, line: i })),
      ],
      functions.map((_, i) => i + 2),
      functions.map(([, us]) => us),
      wallUs
    );
  }

  function side(profiles: unknown[], resolve?: SourceResolver) {
    return {
      inputs: { read: profiles.length, skipped: [], ignored: [] },
      analysis: analyzeProfiles(
        profiles.map((p) => read(p)),
        createFrameIdentifier(resolve)
      ),
    };
  }

  test("ranks per-second rate changes, hides small ones, keeps new and removed functions", () => {
    // Baseline: 1 s wall. Candidate: 2 s wall, so equal self time halves the rate.
    const baseline = side([
      flat(1_000_000, [
        ["X", 10_000],
        ["Y", 5_000],
        ["W", 3_000],
      ]),
    ]);
    const candidate = side([
      flat(2_000_000, [
        ["X", 40_000],
        ["Y", 11_000],
        ["Z", 4_000],
      ]),
    ]);
    const report = buildReport({ baseline, candidate, options: OPTIONS });
    expect(report.mode).toBe("diff");
    expect(
      report.diff?.rows.map((r) => [
        r.function,
        r.baselineMsPerSec,
        r.candidateMsPerSec,
        r.changeMsPerSec,
      ])
    ).toEqual([
      ["X", 10, 20, 10],
      ["W", 3, 0, -3],
      ["Z", 0, 2, 2],
    ]);
    // Y changes by 0.5 ms/s, below the 1 ms/s threshold.
    expect(report.diff?.hiddenBelowThreshold).toBe(1);
    expect([report.baseline?.inputs.read, report.candidate.inputs.read]).toEqual([1, 1]);
    // Both sides use an unmapped .js bundle, so matching across versions is flagged.
    expect(report.warnings.filter((w) => w.includes("unmapped bundle frames"))).toHaveLength(2);
  });

  test("keys keep the line: moved and same-named functions are never merged across sides", () => {
    // Every frame maps to src/a.ts at its bundle line with its own name.
    const resolve: SourceResolver = (frame) => ({
      source: "src/a.ts",
      line: frame.lineNumber,
      name: frame.functionName,
    });
    // "Moved" moves from line 1 to line 2. The baseline samples the "Dup" at line 3 only and the
    // candidate the one at line 4 only: sampled frames cannot tell a move from two functions.
    const baseline = side(
      [
        flat(1_000_000, [
          ["Moved", 10_000],
          ["pad", 0],
          ["Dup", 4_000],
        ]),
      ],
      resolve
    );
    const candidate = side(
      [
        flat(1_000_000, [
          ["pad", 0],
          ["Moved", 10_000],
          ["pad2", 0],
          ["Dup", 6_000],
        ]),
      ],
      resolve
    );
    const report = buildReport({ baseline, candidate, options: OPTIONS });
    expect(report.diff?.rows.map((r) => [r.function, r.line, r.changeMsPerSec])).toEqual([
      ["Moved", 1, -10],
      ["Moved", 2, 10],
      ["Dup", 4, 6],
      ["Dup", 3, -4],
    ]);
  });
});

describe("source maps", () => {
  // Line 0: col 0 -> src/a.ts 0:0, col 5 -> src/a.ts 0:1.
  // Line 1: col 0 -> src/b.ts 1:1 named "realName", col 2 -> unmapped (1-field segment).
  const MAP = {
    version: 3,
    sourceRoot: "src",
    sources: ["a.ts", "b.ts"],
    names: ["realName"],
    mappings: "AAAA,KAAC;ACCAA,E",
  };

  function consumer(map: unknown) {
    const parsed = parseSourceMap(map);
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.map;
  }

  test("looks up the last segment at or before the column", () => {
    const map = consumer(MAP);
    expect([
      map.lookup(0, 0),
      map.lookup(0, 4),
      map.lookup(0, 7),
      map.lookup(1, 0),
      map.lookup(1, 3),
      map.lookup(2, 0),
    ]).toEqual([
      { source: "src/a.ts", line: 0, column: 0, generatedColumn: 0 },
      { source: "src/a.ts", line: 0, column: 0, generatedColumn: 0 },
      { source: "src/a.ts", line: 0, column: 1, generatedColumn: 5 },
      { source: "src/b.ts", line: 1, column: 1, generatedColumn: 0, name: "realName" },
      undefined,
      undefined,
    ]);
  });

  test.each<[string, unknown, RegExp]>([
    ["invalid base64", { ...MAP, mappings: "AA!A" }, /invalid base64/],
    ["3-field segment", { ...MAP, mappings: "AAA" }, /3 fields/],
    ["source index out of range", { ...MAP, mappings: "AEAA" }, /source index/],
    ["index map", { version: 3, sections: [] }, /sections/],
    ["not an object", "x", /not a JSON object/],
  ])("rejects %s", (_name, map, reason) => {
    const parsed = parseSourceMap(map);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(reason);
  });

  test("source identities do not depend on where the maps live", () => {
    // Inside cwd: cwd-relative. Outside: the map's own path minus ../ and URL schemes.
    expect(stableSourceId("../src/a.ts", { mapDir: "/repo/dist", cwd: "/repo" })).toBe("src/a.ts");
    expect(stableSourceId("../src/a.ts", { mapDir: "/elsewhere/wt/dist", cwd: "/repo" })).toBe(
      "src/a.ts"
    );
    expect(stableSourceId("webpack:///./src/a.ts", { cwd: "/repo" })).toBe("src/a.ts");
    expect(
      stableSourceId("../../node_modules/react/x.js", { mapDir: "/x/dist/assets", cwd: "/repo" })
    ).toBe("node_modules/react/x.js");
  });

  test("maps 0-based V8 positions to 1-based keys; unmapped frames keep the bundle line and column", () => {
    const map = consumer(MAP);
    const resolve: SourceResolver = (frame) => {
      const position = map.lookup(frame.lineNumber, frame.columnNumber);
      return position && { source: position.source, line: position.line, name: position.name };
    };
    const identify = createFrameIdentifier(resolve);
    const frame = (columnNumber: number, functionName = "a"): Frame => ({
      functionName,
      url: "file:///dist/main.js",
      lineNumber: 1,
      columnNumber,
    });
    expect(identify(frame(0)).key).toBe("src/b.ts:realName:2");
    // Unmapped: minified functions share bundle lines, so the key carries the 1-based column too.
    expect(identify(frame(3, "e")).key).toBe("file:///dist/main.js:e:2:4");
    expect(identify(frame(3, "e")).key).not.toBe(identify(frame(8, "e")).key);
    expect(identify({ ...frame(7, "f"), lineNumber: 0 }).key).toBe("src/a.ts:f:1");
  });

  test("names a frame after the token before its start column, as V8 reports it", () => {
    // Generated line 0 is `const X=lt=>{...}`: col 6 `X` -> a.ts 0:6 "ChatInputInner",
    // col 8 `lt` -> a.ts 0:20 "props". Line 1 is `function vn(e){...}`: col 9 `vn` -> a.ts 2:9
    // "consume", col 11 `(` -> a.ts 2:11 unnamed. V8 puts the start column at `lt` and at `(`.
    const map = consumer({
      version: 3,
      sources: ["a.ts"],
      names: ["ChatInputInner", "props", "consume"],
      mappings: "MAAMA,EAAcC;SAEXC,EAAE",
    });
    const at = (functionName: string, lineNumber: number, columnNumber: number) =>
      mapFrame(map, { functionName, lineNumber, columnNumber });
    expect([at("X", 0, 8), at("vn", 1, 11), at("", 0, 8)]).toEqual([
      { source: "a.ts", line: 0, column: 20, generatedColumn: 8, name: "ChatInputInner" },
      { source: "a.ts", line: 2, column: 11, generatedColumn: 11, name: "consume" },
      // Anonymous: the token before the start column is not its name.
      { source: "a.ts", line: 0, column: 20, generatedColumn: 8 },
    ]);
    // Sparse map: col 0 -> a.ts 0:0 "other", col 20 -> a.ts 0:20 unnamed (the function start).
    // The nearest named token before col 20 ends 18 characters early, so it is not `fn`'s name.
    const sparse = consumer({
      version: 3,
      sources: ["a.ts"],
      names: ["other"],
      mappings: "AAAAA,oBAAoB",
    });
    expect(mapFrame(sparse, { functionName: "fn", lineNumber: 0, columnNumber: 20 })).toEqual({
      source: "a.ts",
      line: 0,
      column: 20,
      generatedColumn: 20,
    });
    // A function at the start of b.ts in the bundle: the token before it (a.ts "other") belongs to
    // another module. Col 0 -> a.ts 0:0 "other", col 4 -> b.ts 0:0 unnamed.
    const joined = consumer({
      version: 3,
      sources: ["a.ts", "b.ts"],
      names: ["other"],
      mappings: "AAAAA,ICAA",
    });
    expect(mapFrame(joined, { functionName: "f", lineNumber: 0, columnNumber: 4 })).toEqual({
      source: "b.ts",
      line: 0,
      column: 0,
      generatedColumn: 4,
    });
  });
});

test("folded output: one line per distinct stack with sample counts, idle dropped", () => {
  const json = cpuProfile(
    [
      { id: 1, name: "(root)", children: [2, 5, 6] },
      { id: 2, name: "A", url: APP, line: 0, children: [3] },
      // `;` and newlines in names would break the format.
      { id: 3, name: "B;b\nc", url: APP, line: 1, children: [4] },
      { id: 4, name: "A", url: APP, line: 0 },
      { id: 5, name: "(idle)" },
      { id: 6, name: "(program)" },
    ],
    [3, 4, 4, 5, 6, 2],
    [100, 200, 300, 1000, 400, 500]
  );
  expect(renderFolded([read(json).profile], createFrameIdentifier(), false)).toBe(
    [
      "(program) 1",
      "A (app.js:1:1) 1",
      "A (app.js:1:1);B,b c (app.js:2:1) 1",
      "A (app.js:1:1);B,b c (app.js:2:1);A (app.js:1:1) 2",
      "",
    ].join("\n")
  );
});

test.each<[string, boolean]>([
  ['{\n  "nodes": [', true],
  ['\uFEFF{"startTime": 1', true],
  ['{"traceEvents":[', false],
  ['{"schemaVersion": 1, "nodes": []}', false],
  ["[1, 2]", false],
])("looksLikeCpuProfile(%j) is %p", (prefix, expected) => {
  expect(looksLikeCpuProfile(prefix)).toBe(expected);
});

function runCli(args: string[]) {
  const proc = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "analyzeProfiles.ts"), ...args],
    { stdout: "pipe", stderr: "pipe" }
  );
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/** good.cpuprofile (TREE), two malformed profiles and one non-profile JSON file. */
function writeInputs(dir: string): void {
  writeFileSync(join(dir, "good.cpuprofile"), JSON.stringify(TREE));
  writeFileSync(join(dir, "truncated.cpuprofile"), JSON.stringify(TREE).slice(0, 50));
  writeFileSync(
    join(dir, "chrome-cpu-profile.json"),
    JSON.stringify(cpuProfile([{ id: 1, name: "(root)" }], [1, 1], [1]))
  );
  writeFileSync(join(dir, "chrome-trace.json"), '{"traceEvents": []}');
}

test("CLI skips malformed files, ignores other JSON and still reports valid profiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "analyze-profiles-"));
  try {
    writeInputs(dir);
    // The file is also inside the directory argument; it must be read once, not twice.
    const proc = runCli(["--format", "json", dir, join(dir, "good.cpuprofile")]);
    expect(proc.exitCode).toBe(0);
    const report = JSON.parse(proc.stdout) as Report;
    expect(report.candidate.inputs.read).toBe(1);
    expect(
      report.candidate.inputs.skipped.map((s) => [s.path.split("/").pop(), s.reason.split(":")[0]])
    ).toEqual([
      ["chrome-cpu-profile.json", "samples (2) and timeDeltas (1) differ in length"],
      ["truncated.cpuprofile", "invalid JSON"],
    ]);
    expect(report.candidate.inputs.ignored.map((s) => s.path.split("/").pop())).toEqual([
      "chrome-trace.json",
    ]);
    expect(report.candidate.leaderboard[0].function).toBe("A");

    // Without a single valid profile the CLI fails with a message instead of an empty report.
    rmSync(join(dir, "good.cpuprofile"));
    const empty = runCli([dir]);
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toContain("no valid CPU profile read for the candidate side");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI folded output keeps stdout parseable and reports input problems on stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "analyze-profiles-"));
  try {
    const profiles = join(dir, "profiles");
    const maps = join(dir, "maps");
    mkdirSync(profiles);
    mkdirSync(maps);
    writeInputs(profiles);
    // A malformed %-escape in a script URL must not abort the run.
    writeFileSync(
      join(profiles, "escaped.cpuprofile"),
      JSON.stringify(
        cpuProfile(
          [
            { id: 1, name: "(root)", children: [2] },
            { id: 2, name: "E", url: "file:///app/bad%zz.js", line: 0 },
          ],
          [2],
          [100]
        )
      )
    );
    // The map directory holds no map for any profiled script.
    const proc = runCli(["--format", "folded", "--map-dir", maps, profiles]);
    expect(proc.exitCode).toBe(0);
    const lines = proc.stdout.trimEnd().split("\n");
    expect(lines).toContain("E (bad%zz.js:1:1) 1");
    for (const line of lines) expect(line).toMatch(/^\S.* \d+$/);
    expect(proc.stderr).toContain("read 2 profile(s), skipped 2, ignored 1 non-profile file(s)");
    expect(proc.stderr).toMatch(/skipped \S*truncated\.cpuprofile: invalid JSON/);
    expect(proc.stderr).toContain("--map-dir matched no profiled script");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** One-frame profile whose only function is `name` at 0:0 of `url`. */
function oneFrame(url: string, name = "a"): Record<string, unknown> {
  return cpuProfile(
    [
      { id: 1, name: "(root)", children: [2] },
      { id: 2, name, url, line: 0 },
    ],
    [2],
    [1000]
  );
}

/** Map sending generated 0:0 to `source` 0:0. */
function mapTo(source: string): string {
  return JSON.stringify({ version: 3, sources: [source], names: [], mappings: "AAAA" });
}

function locations(stdout: string, side: "candidate" | "baseline" = "candidate"): string[] {
  return (JSON.parse(stdout) as Report)[side]!.leaderboard.map((r) => r.location);
}

test("CLI falls back to a sibling map when the sourceMappingURL comment is malformed", () => {
  const dir = mkdtempSync(join(tmpdir(), "analyze-profiles-"));
  try {
    writeFileSync(join(dir, "main.js"), "function a(){}\n//# sourceMappingURL=bad%zz.map\n");
    writeFileSync(join(dir, "main.js.map"), mapTo("orig.ts"));
    const profile = join(dir, "p.cpuprofile");
    writeFileSync(profile, JSON.stringify(oneFrame(`file://${join(dir, "main.js")}`)));
    const proc = runCli(["--format", "json", profile]);
    expect(proc.exitCode).toBe(0);
    expect(locations(proc.stdout)).toEqual(["orig.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI never looks up --map-dir maps outside the directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "analyze-profiles-"));
  try {
    const maps = join(dir, "maps");
    mkdirSync(maps);
    // `%2e%2e%2f` decodes to `../`: the name must not climb out of `maps`.
    writeFileSync(join(dir, "outside.js.map"), mapTo("outside.ts"));
    const profile = join(dir, "p.cpuprofile");
    writeFileSync(profile, JSON.stringify(oneFrame("http://host/%2e%2e%2foutside.js")));
    const proc = runCli(["--format", "json", "--map-dir", maps, profile]);
    expect(proc.exitCode).toBe(0);
    expect(locations(proc.stdout)).toEqual(["http://host/%2e%2e%2foutside.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI maps each diff side with its own maps when bundle names are stable", () => {
  const dir = mkdtempSync(join(tmpdir(), "analyze-profiles-"));
  try {
    for (const name of ["base", "cand"]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "main.js.map"), mapTo(`${name}.ts`));
      writeFileSync(
        join(dir, `${name}.cpuprofile`),
        JSON.stringify(oneFrame("file:///gone/main.js"))
      );
    }
    const sides = ["--baseline", join(dir, "base.cpuprofile"), join(dir, "cand.cpuprofile")];
    const separate = runCli([
      "--format",
      "json",
      "--map-dir",
      join(dir, "cand"),
      "--baseline-map-dir",
      join(dir, "base"),
      ...sides,
    ]);
    expect(separate.exitCode).toBe(0);
    expect([locations(separate.stdout, "baseline"), locations(separate.stdout)]).toEqual([
      ["base.ts"],
      ["cand.ts"],
    ]);
    // Sharing --map-dir cannot tell the two main.js.map files apart: the first wins, with a warning.
    const shared = runCli([
      "--format",
      "json",
      "--map-dir",
      join(dir, "cand"),
      "--map-dir",
      join(dir, "base"),
      ...sides,
    ]);
    const report = JSON.parse(shared.stdout) as Report;
    expect(locations(shared.stdout, "baseline")).toEqual(["cand.ts"]);
    expect(report.warnings.some((w) => w.includes("--baseline-map-dir"))).toBe(true);
    // A --baseline-map-dir without the profiled map leaves the baseline unmapped (it never falls back
    // to --map-dir) and names the flag that matched nothing.
    mkdirSync(join(dir, "empty"));
    const unmatched = runCli([
      "--format",
      "json",
      "--map-dir",
      join(dir, "cand"),
      "--baseline-map-dir",
      join(dir, "empty"),
      ...sides,
    ]);
    expect(unmatched.exitCode).toBe(0);
    expect([locations(unmatched.stdout, "baseline"), locations(unmatched.stdout)]).toEqual([
      ["file:///gone/main.js"],
      ["cand.ts"],
    ]);
    expect((JSON.parse(unmatched.stdout) as Report).warnings).toContainEqual(
      expect.stringContaining("--baseline-map-dir matched no profiled script")
    );
    // Without --baseline there is no baseline side for the option to map.
    const noBaseline = runCli([
      "--baseline-map-dir",
      join(dir, "base"),
      join(dir, "cand.cpuprofile"),
    ]);
    expect(noBaseline.exitCode).toBe(2);
    expect(noBaseline.stderr).toContain("--baseline-map-dir needs --baseline");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
