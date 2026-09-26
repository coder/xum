import fsPromises from "fs/promises";
import path from "path";
import { type Page, type TestInfo } from "@playwright/test";
import type { CDPSession } from "playwright";
import type { PageMilestones } from "./pageMilestones";
import type { ChatSwitchPerfSummary } from "./chatSwitchSummary";

const PERF_ARTIFACTS_ROOT = path.resolve(__dirname, "..", "..", "..", "artifacts", "perf");
const DEFAULT_TRACE_CATEGORIES = [
  "devtools.timeline",
  "blink.user_timing",
  "v8.execute",
  "toplevel",
].join(",");

interface ChromeTraceCompleteEvent {
  stream?: string;
}

interface CdpIoReadResult {
  data: string;
  eof: boolean;
  base64Encoded?: boolean;
}

interface ChromeMetric {
  name: string;
  value: number;
}

interface RuntimeHeapUsage {
  usedSize: number;
  totalSize: number;
}

interface ChromeProfileCaptureOptions {
  label: string;
  includeHeapUsage?: boolean;
  traceCategories?: string;
}

interface ChromeProfileCapture {
  label: string;
  startedAt: string;
  endedAt: string;
  wallTimeMs: number;
  metrics: Record<string, number>;
  trace: unknown;
  cpuProfile: unknown;
  heapUsage?: {
    before?: RuntimeHeapUsage;
    after?: RuntimeHeapUsage;
  };
}

interface ReactProfileSnapshotLike {
  enabled: boolean;
  sampleCount: number;
  byProfilerId: Record<string, { sampleCount: number }>;
}

function sanitizeForPath(value: string): string {
  const compact = value
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9-_]/g, "")
    .toLowerCase();
  return compact.length > 0 ? compact : `perf-${Date.now()}`;
}

function decodeProtocolChunk(chunk: CdpIoReadResult): string {
  if (!chunk.base64Encoded) {
    return chunk.data;
  }
  return Buffer.from(chunk.data, "base64").toString("utf-8");
}

async function readProtocolStream(client: CDPSession, streamHandle: string): Promise<string> {
  const chunks: string[] = [];
  try {
    while (true) {
      const chunk = (await client.send("IO.read", {
        handle: streamHandle,
      })) as CdpIoReadResult;
      chunks.push(decodeProtocolChunk(chunk));
      if (chunk.eof) {
        break;
      }
    }
  } finally {
    await client.send("IO.close", { handle: streamHandle }).catch(() => undefined);
  }

  return chunks.join("");
}

async function stopTracing(client: CDPSession): Promise<unknown> {
  const tracingComplete = new Promise<string>((resolve, reject) => {
    const onComplete = (event: ChromeTraceCompleteEvent) => {
      client.off("Tracing.tracingComplete", onComplete);
      if (!event.stream) {
        reject(new Error("Tracing completed without a stream handle"));
        return;
      }
      resolve(event.stream);
    };

    client.on("Tracing.tracingComplete", onComplete);
  });

  await client.send("Tracing.end");
  const streamHandle = await tracingComplete;
  const traceJson = await readProtocolStream(client, streamHandle);

  try {
    return JSON.parse(traceJson) as unknown;
  } catch {
    return {
      parseError: "Failed to parse trace JSON",
      rawTrace: traceJson,
    };
  }
}

function toMetricsRecord(metrics: ChromeMetric[] | undefined): Record<string, number> {
  const result: Record<string, number> = {};
  if (!metrics) {
    return result;
  }
  for (const metric of metrics) {
    result[metric.name] = metric.value;
  }
  return result;
}

async function maybeGetHeapUsage(client: CDPSession): Promise<RuntimeHeapUsage | undefined> {
  try {
    const usage = (await client.send("Runtime.getHeapUsage")) as RuntimeHeapUsage;
    return usage;
  } catch {
    return undefined;
  }
}

export async function withChromeProfiles(
  page: Page,
  options: ChromeProfileCaptureOptions,
  action: () => Promise<void>
): Promise<ChromeProfileCapture> {
  const client = await page.context().newCDPSession(page);
  const includeHeapUsage = options.includeHeapUsage ?? true;
  const traceCategories = options.traceCategories ?? DEFAULT_TRACE_CATEGORIES;

  await client.send("Performance.enable");
  await client.send("Profiler.enable");
  await client.send("Runtime.enable");

  let heapUsageBefore: RuntimeHeapUsage | undefined;
  if (includeHeapUsage) {
    heapUsageBefore = await maybeGetHeapUsage(client);
  }

  await client.send("Profiler.start");
  await client.send("Tracing.start", {
    categories: traceCategories,
    transferMode: "ReturnAsStream",
  });

  const startedAt = new Date().toISOString();
  const startTime = Date.now();

  // Boxed so a caught value keeps its `unknown` type (a truthiness check would narrow it).
  let actionFailure: { error: unknown } | undefined;
  try {
    await action();
  } catch (error) {
    actionFailure = { error };
  }

  const endedAt = new Date().toISOString();
  const wallTimeMs = Date.now() - startTime;

  let metrics: Record<string, number> = {};
  try {
    const perfMetrics = (await client.send("Performance.getMetrics")) as {
      metrics?: ChromeMetric[];
    };
    metrics = toMetricsRecord(perfMetrics.metrics);
  } catch {
    metrics = {};
  }

  let heapUsageAfter: RuntimeHeapUsage | undefined;
  if (includeHeapUsage) {
    heapUsageAfter = await maybeGetHeapUsage(client);
  }

  let cpuProfile: unknown = null;
  let trace: unknown = null;

  try {
    const profileStop = (await client.send("Profiler.stop")) as {
      profile?: unknown;
    };
    cpuProfile = profileStop.profile ?? null;
  } finally {
    trace = await stopTracing(client).catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }));

    await Promise.allSettled([
      client.send("Performance.disable"),
      client.send("Profiler.disable"),
      client.send("Runtime.disable"),
    ]);
  }

  if (actionFailure) {
    throw actionFailure.error;
  }

  return {
    label: options.label,
    startedAt,
    endedAt,
    wallTimeMs,
    metrics,
    trace,
    cpuProfile,
    heapUsage: includeHeapUsage
      ? {
          before: heapUsageBefore,
          after: heapUsageAfter,
        }
      : undefined,
  };
}

export async function resetReactProfileSamples(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const reactProfiler = (
      window as Window & {
        __muxReactProfiler?: {
          reset?: () => void;
        };
      }
    ).__muxReactProfiler;

    if (!reactProfiler?.reset) {
      return false;
    }

    reactProfiler.reset();
    return true;
  });
}

export async function readReactProfileSnapshot(
  page: Page
): Promise<ReactProfileSnapshotLike | null> {
  return page.evaluate(() => {
    const reactProfiler = (
      window as Window & {
        __muxReactProfiler?: {
          snapshot?: () => ReactProfileSnapshotLike;
        };
      }
    ).__muxReactProfiler;

    return reactProfiler?.snapshot ? reactProfiler.snapshot() : null;
  });
}

async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  await fsPromises.writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
}

export async function writePerfArtifacts(args: {
  testInfo: TestInfo;
  runLabel: string;
  chromeProfile: ChromeProfileCapture;
  reactProfile: unknown;
  historyProfile: unknown;
  /** In-page milestone timings, for scenarios that record them (see pageMilestones.ts). */
  milestones?: PageMilestones;
  /** Per-switch chat-switch timings and medians (perf.chatSwitch.spec.ts, #4504). */
  chatSwitch?: ChatSwitchPerfSummary;
}): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
  const runDirName = `${sanitizeForPath(args.runLabel)}-${timestamp}`;
  const runDirectory = path.join(
    PERF_ARTIFACTS_ROOT,
    sanitizeForPath(args.testInfo.project.name),
    runDirName
  );

  await fsPromises.mkdir(runDirectory, { recursive: true });

  const cpuProfilePath = path.join(runDirectory, "chrome-cpu-profile.json");
  const tracePath = path.join(runDirectory, "chrome-trace.json");
  const reactProfilePath = path.join(runDirectory, "react-profile.json");
  const summaryPath = path.join(runDirectory, "perf-summary.json");

  await writeJsonFile(cpuProfilePath, args.chromeProfile.cpuProfile);
  await writeJsonFile(tracePath, args.chromeProfile.trace);
  await writeJsonFile(reactProfilePath, args.reactProfile);

  await writeJsonFile(summaryPath, {
    schemaVersion: 1,
    runLabel: args.runLabel,
    test: {
      title: args.testInfo.title,
      testId: args.testInfo.testId,
      file: args.testInfo.file,
      projectName: args.testInfo.project.name,
      retry: args.testInfo.retry,
    },
    historyProfile: args.historyProfile,
    // Additive field: schemaVersion stays 1 because existing readers ignore unknown keys.
    ...(args.milestones ? { milestones: args.milestones } : {}),
    ...(args.chatSwitch ? { chatSwitch: args.chatSwitch } : {}),
    chromeProfile: {
      label: args.chromeProfile.label,
      startedAt: args.chromeProfile.startedAt,
      endedAt: args.chromeProfile.endedAt,
      wallTimeMs: args.chromeProfile.wallTimeMs,
      metrics: args.chromeProfile.metrics,
      heapUsage: args.chromeProfile.heapUsage,
      files: {
        cpuProfile: path.basename(cpuProfilePath),
        trace: path.basename(tracePath),
        reactProfile: path.basename(reactProfilePath),
      },
    },
  });

  return runDirectory;
}
