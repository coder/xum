/* eslint-disable @typescript-eslint/await-thenable -- bun:test async matchers return thenables the rule cannot see */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import {
  PerfCaptureMetadataSchema,
  type PerfCaptureMetadata,
} from "@/common/orpc/schemas/perfCaptures";
import type { FlightRecorderSnapshot } from "@/common/orpc/schemas/perfFlightRecorder";
import { PERF_REPORT_MAX_TOTAL_BYTES } from "@/constants/perfReports";
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
    for (const capture of captures) await writeProfile(capture.id, 40 * MiB);
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
    await fs.mkdir(path.join(home, "perf", "tapes"), { recursive: true });
    await fs.writeFile(path.join(home, "perf", "tapes", "w1.tape"), SECRET_TAPE);
    const chatFile = path.join(home, "sessions", "w1", "chat.jsonl");
    await fs.mkdir(path.dirname(chatFile), { recursive: true });
    await fs.writeFile(chatFile, SECRET_CHAT);
    // A profile that is a symlink to chat history must not be followed.
    await fs.symlink(chatFile, path.join(capturesDir, "c-link.cpuprofile"));
    await writeProfile("c-ok", '{"nodes":[]}');
    // A metadata object carrying a field outside the schema.
    const withUnknownField: PerfCaptureMetadata & { secret: string } = {
      ...captureMetadata("c-ok", 3000),
      secret: SECRET_META,
    };
    captures = [withUnknownField, captureMetadata("c-link", 2000), captureMetadata("c-gone", 1000)];
    const report = await createService().createReport();

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
      for (const marker of [SECRET_TAPE, SECRET_CHAT, SECRET_META]) {
        expect(content).not.toContain(marker);
      }
    }
  });

  test("desktop: sanitizes hang records, adds app metrics and reveals the bundle", async () => {
    const revealed: string[] = [];
    const hooks: PerfReportDesktopHooks = {
      getHangRecords: () => [
        {
          at: 1_700_000_000_000,
          durationUntilResponsive: 2500,
          url: `http://user:pw@localhost:5173/app/index.html?token=${SECRET_QUERY}#frag`,
          stack: `Error\n    at render (http://localhost:5173/assets/main.js?v=${SECRET_QUERY}#x:10:5)\n    at file:///opt/xum/app.js?k=${SECRET_QUERY}:3`,
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
    expect(hangsText).not.toContain(SECRET_QUERY);
    expect(hangsText).not.toContain("user:pw");
    expect(JSON.parse(hangsText)).toEqual([
      {
        at: 1_700_000_000_000,
        durationUntilResponsive: 2500,
        url: "http://localhost:5173/app/index.html",
        stack:
          "Error\n    at render (http://localhost:5173/assets/main.js:10:5)\n    at file:///opt/xum/app.js:3",
      },
      { at: 1_700_000_001_000, stackError: "error" },
      { at: 1_700_000_002_000, url: "file:///opt/xum/index.html", stackError: "timeout" },
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
