/* eslint-disable @typescript-eslint/await-thenable -- bun:test async matchers return thenables the rule cannot see */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { getXumPerfTapesDir } from "@/common/constants/paths";
import {
  PerfCaptureMetadataSchema,
  type PerfCaptureMetadata,
} from "@/common/orpc/schemas/perfCaptures";
import type { FlightRecorderSnapshot } from "@/common/orpc/schemas/perfFlightRecorder";
import { PERF_REPORT_MAX_CAPTURES, PERF_REPORT_MAX_TOTAL_BYTES } from "@/constants/perfReports";
import {
  PerfReportService,
  type PerfReportDesktopHooks,
  type PerfReportServiceOptions,
} from "./perfReportService";

const MiB = 1024 * 1024;
const SECRET_TAPE = "SECRET-TAPE-MARKER-41f2";
const SECRET_CHAT = "SECRET-CHAT-MARKER-9c1d";
const SECRET_META = "SECRET-META-MARKER-77ab";
const SECRET_QUERY = "SECRET-QUERY-MARKER-0e5a";

function snapshot(overrides: Partial<FlightRecorderSnapshot> = {}): FlightRecorderSnapshot {
  return {
    version: 1,
    state: "collecting",
    nowMs: 5000,
    backend: { samples: [], heap: [] },
    renderer: { loaf: [], events: [], droppedLoaf: 0, droppedEvents: 0 },
    trips: [
      {
        kind: "slow-rpc",
        atMs: 4000,
        path: "workspace.list",
        startMs: 1000,
        durationMs: 3000,
        ok: true,
      },
    ],
    rpc: {
      version: 1,
      windowMs: 60_000,
      procedures: [],
      subscriptions: [],
      slowCalls: [],
      wsFlowControlWaits: [],
      droppedPaths: 0,
    },
    ...overrides,
  };
}

function captureMetadata(id: string, startedAtMs: number, profiled = true): PerfCaptureMetadata {
  return PerfCaptureMetadataSchema.parse({
    version: 1,
    id,
    kind: "manual",
    process: "backend",
    trigger: null,
    startedAtMs,
    endedAtMs: startedAtMs + 1000,
    samplingIntervalUs: 1000,
    durationMs: 1000,
    xumVersion: "test",
    platform: process.platform,
    label: "manual capture",
    ...(profiled ? { profileFile: `${id}.cpuprofile` } : { skippedReason: "inspector-open" }),
  } satisfies PerfCaptureMetadata);
}

let home: string;
let capturesDir: string;
let reportsDir: string;
let experimentOn: boolean;
let captures: PerfCaptureMetadata[];

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "perf-report-"));
  capturesDir = path.join(home, "perf", "captures");
  reportsDir = path.join(home, "perf", "reports");
  await fs.mkdir(capturesDir, { recursive: true });
  experimentOn = true;
  captures = [];
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

function createService(overrides: Partial<PerfReportServiceOptions> = {}) {
  let nextId = 0;
  return new PerfReportService({
    reportsDir,
    xumHome: home,
    capturesDir,
    recorder: {
      getSnapshot: () => snapshot(),
      getStatus: () => ({ enabled: experimentOn, state: "collecting" }),
    },
    captures: { listCaptures: () => Promise.resolve({ captures }) },
    isExperimentEnabled: (id) => id === EXPERIMENT_IDS.PERF_FLIGHT_RECORDER && experimentOn,
    createId: () => `20261003T000000000Z-${++nextId}`,
    ...overrides,
  });
}

async function writeProfile(id: string, bytes: number | string): Promise<void> {
  const file = path.join(capturesDir, `${id}.cpuprofile`);
  if (typeof bytes === "string") {
    await fs.writeFile(file, bytes, { mode: 0o600 });
    return;
  }
  // Sparse: a large profile without writing its bytes.
  const handle = await fs.open(file, "w", 0o600);
  await handle.truncate(bytes);
  await handle.close();
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(entryPath)));
    else out.push(entryPath);
  }
  return out;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

describe("PerfReportService", () => {
  test("publishes a private bundle with the snapshot, trace, environment and captures", async () => {
    captures = [captureMetadata("c-new", 3000), captureMetadata("c-skip", 2000, false)];
    await writeProfile("c-new", '{"nodes":[]}');
    const report = await createService().createReport();

    expect(path.dirname(report.dir)).toBe(reportsDir);
    expect(await fs.readdir(reportsDir)).toEqual([path.basename(report.dir)]);
    expect(report).toMatchObject({ revealed: false, includedCaptures: 2, skippedCaptures: 0 });
    const files = (await listFiles(report.dir)).map((file) => path.relative(report.dir, file));
    expect(files.sort()).toEqual(
      [
        "README.txt",
        "environment.json",
        "snapshot.json",
        "trace.json",
        "captures/manifest.json",
        "captures/c-new.json",
        "captures/c-new.cpuprofile",
        "captures/c-skip.json",
      ].sort()
    );
    expect(await readJson(path.join(report.dir, "snapshot.json"))).toEqual(snapshot());
    expect(await fs.readFile(path.join(report.dir, "captures/c-new.cpuprofile"), "utf8")).toBe(
      '{"nodes":[]}'
    );
    const totalBytes = (
      await Promise.all(
        files.map(async (file) => (await fs.stat(path.join(report.dir, file))).size)
      )
    ).reduce((sum, size) => sum + size, 0);
    expect(report.totalBytes).toBe(totalBytes);

    const environment = (await readJson(path.join(report.dir, "environment.json"))) as Record<
      string,
      unknown
    >;
    expect(environment).toMatchObject({
      mode: "server",
      enabledExperiments: [EXPERIMENT_IDS.PERF_FLIGHT_RECORDER],
      xumHomeName: path.basename(home),
    });
    expect(JSON.stringify(environment)).not.toContain(home);

    if (process.platform !== "win32") {
      expect((await fs.stat(report.dir)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(report.dir, "captures"))).mode & 0o777).toBe(0o700);
      for (const file of files) {
        expect((await fs.stat(path.join(report.dir, file))).mode & 0o777).toBe(0o600);
      }
    }
  });

  test("keeps the newest captures within the size cap and drops the oldest", async () => {
    // Three 40 MiB profiles: only the newest two fit in 100 MiB.
    captures = [
      captureMetadata("c-3", 3000),
      captureMetadata("c-2", 2000),
      captureMetadata("c-1", 1000),
    ];
    // Profile-shaped text (short JSON strings), not zeros: a copy needs places to cut.
    for (const capture of captures) {
      await fs.writeFile(
        path.join(capturesDir, `${capture.id}.cpuprofile`),
        Buffer.alloc(40 * MiB, '"a",'),
        { mode: 0o600 }
      );
    }
    const report = await createService().createReport();

    expect(report).toMatchObject({ includedCaptures: 2, skippedCaptures: 1 });
    expect(report.totalBytes).toBeLessThanOrEqual(PERF_REPORT_MAX_TOTAL_BYTES);
    const manifest = (await readJson(path.join(report.dir, "captures/manifest.json"))) as {
      included: Array<{ id: string }>;
      skipped: Array<{ id: string; reason: string }>;
    };
    expect(manifest.included.map((capture) => capture.id)).toEqual(["c-3", "c-2"]);
    expect(manifest.skipped).toMatchObject([{ id: "c-1", reason: "size-cap" }]);
    await expect(fs.stat(path.join(report.dir, "captures/c-1.cpuprofile"))).rejects.toThrow();
  });

  test("rejects when the required files alone exceed the cap and leaves nothing behind", async () => {
    const huge = "x".repeat(PERF_REPORT_MAX_TOTAL_BYTES + 1);
    const service = createService({
      recorder: {
        getSnapshot: () => snapshot({ failure: huge }),
        getStatus: () => ({ enabled: true, state: "failed" }),
      },
    });
    await expect(service.createReport()).rejects.toThrow(/too large/);
    expect(await fs.readdir(reportsDir)).toEqual([]);
  });

  test("copies only validated capture data, never tapes, sessions or symlinked profiles", async () => {
    // A session tape as the tape recorder names it (<home>/perf/tapes/<start>-<hash>-<id>.jsonl).
    const tapesDir = getXumPerfTapesDir(home);
    await fs.mkdir(tapesDir, { recursive: true });
    await fs.writeFile(
      path.join(tapesDir, "20261003T000000000Z-0a1b2c3d-tape1.jsonl"),
      `{"marker":"${SECRET_TAPE}"}\n`
    );
    const chatFile = path.join(home, "sessions", "w1", "chat.jsonl");
    await fs.mkdir(path.dirname(chatFile), { recursive: true });
    await fs.writeFile(chatFile, SECRET_CHAT);
    // A profile that is a symlink to chat history must not be followed.
    await fs.symlink(chatFile, path.join(capturesDir, "c-link.cpuprofile"));
    // V8 profiles name scripts by absolute path or file URL, which spells out the user's
    // home directory. The home path starts 3 bytes before the 1 MiB copy-chunk boundary,
    // so the copy must also catch a spelling split across two reads.
    const userHome = os.homedir();
    const head = '{"pad":"';
    const beforeHome = '","path":"';
    const pad = "x".repeat(MiB - 3 - head.length - beforeHome.length);
    const scriptUrl = pathToFileURL(path.join(userHome, "src", "xum", "dist", "main.js")).href;
    const profileText = `${head}${pad}${beforeHome}${JSON.stringify(path.join(userHome, "a.js")).slice(1)},"nodes":[{"callFrame":{"url":${JSON.stringify(scriptUrl)}}}]}`;
    await writeProfile("c-ok", profileText);
    // A metadata object carrying a field outside the schema.
    const withUnknownField: PerfCaptureMetadata & { secret: string } = {
      ...captureMetadata("c-ok", 3000),
      secret: SECRET_META,
    };
    captures = [withUnknownField, captureMetadata("c-link", 2000), captureMetadata("c-gone", 1000)];
    // LoAF script attribution names script URLs, which can spell the home directory and
    // carry query tokens; both snapshot.json and trace.json read it.
    const loafScriptUrl = `${scriptUrl}?token=${SECRET_QUERY}#frag`;
    const recordedSnapshot = snapshot({
      renderer: {
        loaf: [
          {
            rendererId: "r1",
            startMs: 1000,
            durationMs: 120,
            blockingDurationMs: 70,
            renderStartMs: 0,
            styleAndLayoutStartMs: 0,
            scripts: [
              {
                sourceURL: loafScriptUrl,
                sourceFunctionName: "render",
                sourceCharPosition: 1,
                invoker: loafScriptUrl,
                invokerType: "classic-script",
                durationMs: 100,
                forcedStyleAndLayoutDurationMs: 0,
              },
              {
                sourceURL: `data:text/javascript,${SECRET_QUERY}`,
                sourceFunctionName: "",
                sourceCharPosition: 0,
                invoker: `data:text/javascript,${SECRET_QUERY}`,
                invokerType: "module-script",
                durationMs: 10,
                forcedStyleAndLayoutDurationMs: 0,
              },
            ],
          },
        ],
        events: [],
        droppedLoaf: 0,
        droppedEvents: 0,
      },
    });
    const report = await createService({
      recorder: {
        getSnapshot: () => recordedSnapshot,
        getStatus: () => ({ enabled: true, state: "collecting" }),
      },
    }).createReport();

    expect(report).toMatchObject({ includedCaptures: 1, skippedCaptures: 2 });
    const manifest = (await readJson(path.join(report.dir, "captures/manifest.json"))) as {
      skipped: Array<{ id: string; reason: string }>;
    };
    expect(manifest.skipped).toMatchObject([
      { id: "c-link", reason: "not-a-regular-file" },
      { id: "c-gone", reason: "missing" },
    ]);
    for (const file of await listFiles(report.dir)) {
      expect((await fs.lstat(file)).isSymbolicLink()).toBe(false);
      const content = await fs.readFile(file, "utf8");
      for (const marker of [SECRET_TAPE, SECRET_CHAT, SECRET_META, SECRET_QUERY]) {
        expect(content).not.toContain(marker);
      }
      expect(content).not.toContain(userHome);
      expect(content).not.toContain(JSON.stringify(userHome).slice(1, -1));
      expect(content).not.toContain(pathToFileURL(userHome).pathname);
    }
    // Everything but the home directory survives, and the copy is still valid JSON.
    const profileCopy = (await readJson(path.join(report.dir, "captures/c-ok.cpuprofile"))) as {
      nodes: Array<{ callFrame: { url: string } }>;
    };
    expect(profileCopy.nodes[0]?.callFrame.url).toEndWith("/src/xum/dist/main.js");
    expect(profileCopy.nodes[0]?.callFrame.url).toContain("~");
    const written = (await readJson(
      path.join(report.dir, "snapshot.json")
    )) as FlightRecorderSnapshot;
    expect(written.renderer.loaf[0]?.scripts[0]?.sourceURL).toBe("file://~/src/xum/dist/main.js");
  });

  test("writes only the home directory itself as ~, not folders that share its prefix", async () => {
    const userHome = os.homedir();
    const at = (suffix: string) => JSON.stringify(userHome + suffix).slice(1, -1);
    await writeProfile(
      "c-prefix",
      `{"a":"${at("/x.js")}","b":"${at("2/y.js")}","c":"${at("-backup/z.js")}","d":"${at("")}","e":"${JSON.stringify(userHome.toUpperCase()).slice(1, -1)}/q.js"}`
    );
    captures = [captureMetadata("c-prefix", 1000)];
    const report = await createService().createReport();

    const copy = (await readJson(path.join(report.dir, "captures/c-prefix.cpuprofile"))) as Record<
      string,
      string
    >;
    expect(copy).toEqual({
      a: "~/x.js",
      b: `${userHome}2/y.js`,
      c: `${userHome}-backup/z.js`,
      d: "~",
      // Windows paths are case-insensitive, so the home matches in any case.
      e: "~/q.js",
    });
  });

  test("keeps only scheme, host and path of script URLs in copied profiles", async () => {
    // A renderer profile names the page URL, which in `xum server` carries the auth token,
    // and an opaque data: URL is the script text itself. The first value's opening quote is
    // the second-to-last byte of the first 1 MiB copy chunk, followed by "]", which looks
    // like the end of a string to a cut that ignores the url key.
    const urls = [
      `]http://h/?token=${SECRET_QUERY}`,
      `http://127.0.0.1:5173/?token=${SECRET_QUERY}#frag`,
      `https://user:${SECRET_META}@cdn.example/app.js?v=1`,
      `data:text/javascript,apiKey=${SECRET_TAPE}`,
      "node:internal/main",
      "/opt/xum/dist/cjs.js",
      `/opt/xum/p.js?token=${SECRET_QUERY}`,
      `//cdn.example/app.js?token=${SECRET_QUERY}`,
      "",
    ];
    const head = '{"pad":"';
    const pad = "x".repeat(MiB - 33 - head.length);
    const nodes = urls.map((url) => ({ callFrame: { url } }));
    await writeProfile("c-urls", `${head}${pad}","nodes":${JSON.stringify(nodes)}}`);
    captures = [captureMetadata("c-urls", 1000)];
    const report = await createService().createReport();

    const copy = (await readJson(path.join(report.dir, "captures/c-urls.cpuprofile"))) as {
      nodes: Array<{ callFrame: { url: string } }>;
    };
    expect(copy.nodes.map((node) => node.callFrame.url)).toEqual([
      "",
      "http://127.0.0.1:5173/",
      "https://cdn.example/app.js",
      "data:",
      "node:internal/main",
      "/opt/xum/dist/cjs.js",
      "/opt/xum/p.js",
      "",
      "",
    ]);
    const copyText = await fs.readFile(path.join(report.dir, "captures/c-urls.cpuprofile"), "utf8");
    // The prefix is copied unchanged: the url value's opening quote sits at MiB - 2.
    expect(copyText.indexOf('"url":"') + '"url":'.length).toBe(MiB - 2);
    expect(copyText).not.toContain(SECRET_QUERY);
  });

  test("copies long numeric runs but skips a profile it cannot cut safely", async () => {
    // Sample arrays hold megabytes without a string; that is fine.
    const samples = Array.from({ length: 1_000_000 }, (_, i) => i % 1000).join(",");
    await writeProfile("c-big", `{"nodes":[{"callFrame":{"url":"a"}}],"samples":[${samples}]}`);
    // One string longer than the copy may hold back has no safe place to cut.
    await writeProfile("c-unsafe", `{"x":"${"y".repeat(17 * MiB)}"}`);
    captures = [captureMetadata("c-big", 2000), captureMetadata("c-unsafe", 1000)];
    const report = await createService().createReport();

    const manifest = (await readJson(path.join(report.dir, "captures/manifest.json"))) as {
      included: Array<{ id: string }>;
      skipped: Array<{ id: string; reason: string }>;
    };
    expect(manifest.included.map((capture) => capture.id)).toEqual(["c-big"]);
    expect(manifest.skipped).toMatchObject([{ id: "c-unsafe", reason: "unscrubbable" }]);
    await expect(fs.stat(path.join(report.dir, "captures/c-unsafe.cpuprofile"))).rejects.toThrow();
    const copy = (await readJson(path.join(report.dir, "captures/c-big.cpuprofile"))) as {
      samples: number[];
    };
    expect(copy.samples).toHaveLength(1_000_000);
  });

  test("removes report folders abandoned mid-write, but not recent ones", async () => {
    await fs.mkdir(reportsDir, { recursive: true });
    const stale = path.join(reportsDir, ".20261001T000000000Z-old.partial");
    const recent = path.join(reportsDir, ".20261003T000000000Z-new.partial");
    await fs.mkdir(stale);
    await fs.mkdir(recent);
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(stale, anHourAgo, anHourAgo);

    await createService().createReport();
    await expect(fs.stat(stale)).rejects.toThrow();
    expect((await fs.stat(recent)).isDirectory()).toBe(true);
  });

  test.skipIf(process.platform === "win32")(
    "skips a capture whose profile is a FIFO instead of blocking on it",
    async () => {
      // Opening a FIFO for reading blocks until a writer appears; the report must not hang.
      execFileSync("mkfifo", [path.join(capturesDir, "c-fifo.cpuprofile")]);
      captures = [captureMetadata("c-fifo", 1000)];
      const report = await createService().createReport();
      const manifest = (await readJson(path.join(report.dir, "captures/manifest.json"))) as {
        skipped: Array<{ id: string; reason: string }>;
      };
      expect(manifest.skipped).toMatchObject([{ id: "c-fifo", reason: "not-a-regular-file" }]);
      expect(manifest.skipped).toHaveLength(1);
    },
    5000
  );

  test("lists captures beyond the count limit as left out", async () => {
    const total = PERF_REPORT_MAX_CAPTURES + 2;
    captures = Array.from({ length: total }, (_, i) =>
      captureMetadata(`c-${total - i}`, (total - i) * 1000, false)
    );
    const report = await createService().createReport();

    expect(report).toMatchObject({
      includedCaptures: PERF_REPORT_MAX_CAPTURES,
      skippedCaptures: 2,
    });
    const manifest = (await readJson(path.join(report.dir, "captures/manifest.json"))) as {
      included: Array<{ id: string }>;
      skipped: Array<{ id: string; reason: string }>;
    };
    expect(manifest.included).toHaveLength(PERF_REPORT_MAX_CAPTURES);
    expect(manifest.skipped).toMatchObject([
      { id: "c-2", reason: "count-cap" },
      { id: "c-1", reason: "count-cap" },
    ]);
  });

  test("desktop: hang stacks keep function names only, adds app metrics and reveals the bundle", async () => {
    const revealed: string[] = [];
    const hooks: PerfReportDesktopHooks = {
      getHangRecords: () => [
        {
          at: 1_700_000_000_000,
          durationUntilResponsive: 2500,
          url: `http://user:pw@localhost:5173/app/index.html?token=${SECRET_QUERY}#frag`,
          stack: [
            `Error: boom ${SECRET_QUERY}`,
            `    at render (http://localhost:5173/assets/main.js?v=${SECRET_QUERY}#x:10:5)`,
            `    at file:///opt/xum/app.js?k=${SECRET_QUERY}:3`,
            // A nested eval frame: two locations on one line.
            `    at eval (eval at fn (https://safe/outer.js:1), data:text/javascript,apiKey=${SECRET_QUERY}:2)`,
            "    at new Widget (C:\\Users\\X\\xum\\app.js:7:1)",
            "    at async Promise.all (index 0)",
            `    at https://host/a(b).js?token=${SECRET_QUERY}:4:2`,
            `    at https://evil/${SECRET_QUERY} (https://host/x.js:1:1)`,
          ].join("\n"),
        },
        { at: 1_700_000_001_000, url: "not a url", stackError: `failed: ${SECRET_QUERY}` },
        { at: 1_700_000_002_000, url: "file:///opt/xum/index.html", stackError: "timeout" },
      ],
      getAppMetrics: () => [{ pid: 1, type: "Browser" }],
      revealPath: (dirPath) => {
        revealed.push(dirPath);
      },
    };
    const service = createService();
    service.setDesktopHooks(hooks);
    const report = await service.createReport();

    expect(report.revealed).toBe(true);
    expect(revealed).toEqual([report.dir]);
    expect(await readJson(path.join(report.dir, "app-metrics.json"))).toEqual([
      { pid: 1, type: "Browser" },
    ]);
    const hangsText = await fs.readFile(path.join(report.dir, "hangs.json"), "utf8");
    // No URL, path or location text of any kind, only function names.
    for (const leak of [
      SECRET_QUERY,
      "user:pw",
      "://",
      "data:",
      "file:",
      "C:\\",
      ":10:5",
      "eval at",
    ]) {
      expect(hangsText).not.toContain(leak);
    }
    expect(JSON.parse(hangsText)).toEqual([
      {
        at: 1_700_000_000_000,
        durationUntilResponsive: 2500,
        stack: [
          "render",
          "<anonymous>",
          "eval",
          "new Widget",
          "async Promise.all",
          "<anonymous>",
          "<anonymous>",
        ].join("\n"),
      },
      { at: 1_700_000_001_000, stackError: "error" },
      { at: 1_700_000_002_000, stackError: "timeout" },
    ]);
    expect(await readJson(path.join(report.dir, "environment.json"))).toMatchObject({
      mode: "desktop",
    });
  });

  test("a failing reveal still returns the published bundle", async () => {
    const service = createService();
    service.setDesktopHooks({
      getHangRecords: () => [],
      getAppMetrics: () => [],
      revealPath: () => Promise.reject(new Error("no file manager")),
    });
    const report = await service.createReport();
    expect(report.revealed).toBe(false);
    expect((await fs.stat(report.dir)).isDirectory()).toBe(true);
  });

  test("refuses while the experiment is off or another report is being written", async () => {
    experimentOn = false;
    await expect(createService().createReport()).rejects.toMatchObject({
      refusal: "experiment-off",
    });
    await expect(fs.stat(reportsDir)).rejects.toThrow();

    experimentOn = true;
    const service = createService();
    const first = service.createReport();
    await expect(service.createReport()).rejects.toMatchObject({ refusal: "in-progress" });
    await first;
    expect(await fs.readdir(reportsDir)).toHaveLength(1);
  });
});
