/**
 * Page-timing runner (T3 #5971, plan sections 2.3-2.7): paired base/head runs of the two mobile pages in a
 * throttled Chrome, timing useful content shown (UCS, with UCS-live beside it) and interaction ready (IR).
 *   make page-timing PAGE_TIMING_ARGS="--base <tree> --head <tree> [--aa | --qualification <file>]
 *     [--pages p1,p2] [--predict p1.ucs=3.9,p2.ir=1.2] [--out <dir>] [--chrome <path>]"
 * A tree is a built checkout (`make build`). P1 is "/" on an empty root, P2 "/workspace/<id>" on the neutral
 * seed. Every run gets a fresh root, server and browser profile. --aa qualifies the host (one confirmatory
 * block for a failed page) and writes qualification.json, which gated runs read with --qualification.
 * PAGE_TIMING_LOCK=<file> holds that flock for each browser run (the shared dev-host measurement lock).
 * Exit: 0 pass or qualified, 1 a gate failed or the host did not qualify, 2 bad input, 3 an invalid run.
 * The summary is written only when every page ends: run gate blocks one page per invocation (--pages p1).
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { diffSeed, snapshotSeed, writeNeutralSeed } from "./neutralSeed";
import * as core from "./pageTimingCore";
import { probe, STATIC_VIEW_ID } from "./pageTimingProbe";
import { BLOCK_PAIRS, gate, kthLargest, launchPlan, median, type Signal } from "./pageTimingStats";

/** Lighthouse's mobile values, applied as DevTools throttling: real timings, not the simulator's. */
const PHONE = {
  context: {
    viewport: { width: 412, height: 823 },
    deviceScaleFactor: 1.75,
    isMobile: true,
    hasTouch: true,
  },
  network: {
    offline: false,
    latency: 562.5,
    downloadThroughput: (1474.56 * 1024) / 8,
    uploadThroughput: (675 * 1024) / 8,
  },
  cpuSlowdown: 4,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Values = Partial<core.Run["values"]>;

/** Holds `flock <file>` while fn runs. The holder exits, and frees the lock, when its stdin closes. */
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const file = process.env.PAGE_TIMING_LOCK;
  if (!file) return fn();
  const holder = spawn("flock", ["-w", "3600", file, "sh", "-c", "echo held; exec cat >/dev/null"]);
  const exited = once(holder, "exit").then(() => null);
  if ((await Promise.race([once(holder.stdout, "data"), exited])) === null) {
    throw new Error(`could not take the lock ${file}`);
  }
  try {
    return await fn();
  } finally {
    holder.stdin.end();
    await exited;
  }
}

async function waitForQuietHost() {
  const psiFile = "/proc/pressure/cpu";
  for (let i = 0; i < 60; i++) {
    const psi = fs.existsSync(psiFile) ? fs.readFileSync(psiFile, "utf8") : null;
    if (core.hostIsQuiet(os.loadavg()[0], psi, os.availableParallelism())) return;
    await sleep(10_000);
  }
  throw new Error("the host stayed busy for 10 minutes: the block is aborted");
}

/** PIDs of the processes whose environment holds the entry (Linux /proc; elsewhere none are found). */
function withEnv(entry: string): number[] {
  const has = (pid: string) => {
    try {
      return fs.readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(entry);
    } catch {
      return false; // gone, or a zombie
    }
  };
  return fs.existsSync("/proc") ? fs.readdirSync("/proc").filter(has).map(Number) : [];
}

async function startServer(tree: string, root: string, home: string, logFile: string) {
  const probePort = net.createServer().listen(0, "127.0.0.1");
  await once(probePort, "listening");
  const { port } = probePort.address() as net.AddressInfo;
  probePort.close();
  const log = fs.openSync(logFile, "w");
  const env = { PATH: process.env.PATH, HOME: home, XUM_ROOT: root, XUM_DISABLE_TELEMETRY: "1" };
  const args = `dist/cli/index.js server --no-auth --host 127.0.0.1 --port ${port}`.split(" ");
  const server = spawn("node", args, {
    cwd: tree,
    env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null" },
    detached: true, // its own process group, so stop() also ends the server's children
    stdio: ["ignore", log, log],
  });
  const origin = `http://127.0.0.1:${port}`;
  const up = () =>
    fetch(`${origin}/health`)
      .then((r) => r.ok)
      .catch(() => false);
  for (let i = 0; i < 120 && !(await up()); i++) await sleep(500);
  const stop = async () => {
    process.kill(-server.pid!, "SIGTERM");
    if (server.exitCode === null) await once(server, "exit");
    // Workspace commands run in their own process groups, so the group kill misses them, and they can
    // still write into the seed after the server exits. All inherit HOME: wait until no process has it.
    for (let i = 0, left = withEnv(`HOME=${home}`); left.length > 0; i++) {
      if (i === 100)
        throw new Error(`${logFile}: ${left.length} process(es) outlived the server by 10 s`);
      await sleep(100);
      left = withEnv(`HOME=${home}`);
    }
    fs.closeSync(log);
  };
  return { origin, stop };
}

/** One navigation with a fresh root (and seed), server and browser. Values in seconds. */
async function measure(o: {
  tree: string;
  page: core.Page;
  mode: Signal;
  out: string;
  name: string;
  chrome: string;
}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "page-timing-"));
  const seedDir = path.join(tmp, "seed");
  const seed = o.page === "p2" ? writeNeutralSeed(seedDir) : null;
  const before = seed && snapshotSeed(seedDir);
  const [root, home] = [seed?.root ?? path.join(tmp, "root"), seed?.home ?? path.join(tmp, "home")];
  for (const dir of [root, home]) fs.mkdirSync(dir, { recursive: true });
  const server = await startServer(o.tree, root, home, path.join(o.out, `${o.name}.server.log`));
  let values: Values;
  try {
    // The load check runs inside the lock: no other lock holder can start work between the check and the run.
    values = await withLock(async () => {
      await waitForQuietHost();
      return browse(o, `${server.origin}${seed ? `/workspace/${seed.workspaceId}` : "/"}`);
    });
  } finally {
    await server.stop();
  }
  const now = (rel: string) => fs.readFileSync(path.join(seedDir, rel));
  const rewrites = before ? core.seedRewrites(diffSeed(before, seedDir), before, now) : [];
  fs.rmSync(tmp, { recursive: true, force: true });
  if (rewrites.length > 0) throw new Error(`${o.name}: a build rewrote the seed: ${rewrites}`);
  return values;
}

async function browse(o: Parameters<typeof measure>[0], url: string): Promise<Values> {
  const browser = await chromium.launch({ executablePath: o.chrome, headless: true }); // fresh profile
  try {
    const context = await browser.newContext(PHONE.context);
    let [workers, fromWorker] = [0, 0];
    context.on("serviceworker", () => workers++);
    const arg = {
      target: core.TARGET[o.page],
      mode: o.mode,
      page: o.page,
      staticViewId: STATIC_VIEW_ID,
    };
    // tsx (esbuild keepNames) wraps the probe's inner functions in __name(), which the page lacks.
    await context.addInitScript({
      content: `var __name = (f) => f; (${probe})(${JSON.stringify(arg)})`,
    });
    const tab = await context.newPage();
    tab.on("response", (response) => {
      if (response.fromServiceWorker()) fromWorker++;
    });
    const cdp = await context.newCDPSession(tab);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Network.emulateNetworkConditions", PHONE.network);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: PHONE.cpuSlowdown });
    await tab.goto(url, { waitUntil: "load", timeout: 180_000 });
    const done =
      o.mode === "ucs"
        ? "r.visibleLive !== null && r.elementTiming.some((e) => e.live)"
        : "r.ir !== null";
    await tab.waitForFunction(`((r) => !!r && ${done})(window.__pageTiming)`, null, {
      timeout: 120_000,
    });
    const record = (await tab.evaluate("window.__pageTiming")) as core.ProbeRecord;
    const file = (ext: string) => path.join(o.out, `${o.name}.${ext}`);
    if (o.mode === "ucs") await tab.screenshot({ path: file("png") });
    const apiAfterRun = (await tab.evaluate('"serviceWorker" in navigator')) as boolean;
    const failures = core.serviceWorkerProofFailures({ workers, fromWorker, apiAfterRun });
    if (failures.length > 0) throw new Error(`${o.name}: ${failures.join(", ")}`);
    const values = o.mode === "ucs" ? core.usefulContentShown(record) : { ir: record.ir! / 1000 };
    fs.writeFileSync(file("json"), JSON.stringify({ ...o, url, record, values }));
    return values;
  } finally {
    await browser.close();
  }
}

/** One block: BLOCK_PAIRS pairs in ABBA order, UCS and IR as separate navigations. d per signal, in s. */
async function block(o: {
  base: string;
  head: string;
  page: core.Page;
  label: string;
  out: string;
  chrome: string;
}) {
  const runs: core.Run[] = [];
  const { page } = o;
  for (const { arm, pair } of launchPlan(BLOCK_PAIRS, 0)) {
    const run = { tree: arm === "base" ? o.base : o.head, page, out: o.out, chrome: o.chrome };
    const name = (mode: Signal) => `${o.label}-${o.page}-${pair}-${arm}-${mode}`;
    const ucs = await measure({ ...run, mode: "ucs", name: name("ucs") });
    const ir = await measure({ ...run, mode: "ir", name: name("ir") });
    runs.push({ page: o.page, pair: pair!, arm, values: { ...ucs, ...ir } as core.Run["values"] });
    console.error(`${o.label} ${o.page} pair ${pair} ${arm}: UCS ${ucs.ucs} s, IR ${ir.ir} s`);
  }
  const d = (key: keyof core.Run["values"]) => core.pairDiffs(runs, o.page, key);
  return { ucs: d("ucs"), ucsLive: d("ucsLive"), ir: d("ir") };
}

async function main(): Promise<number> {
  const { values: a } = parseArgs({
    options: {
      base: { type: "string" },
      head: { type: "string" },
      qualification: { type: "string" },
      out: { type: "string" },
      pages: { type: "string", default: "p1,p2" },
      predict: { type: "string", default: "" },
      chrome: { type: "string", default: "/usr/bin/google-chrome" },
      aa: { type: "boolean", default: false },
    },
  });
  const pages = a.pages.split(",") as core.Page[];
  if (!a.base || !a.head || pages.some((p) => !(p in core.TARGET)) || (a.aa && a.qualification)) {
    console.error("usage: see the header of scripts/perf/pageTiming.ts");
    return 2;
  }
  const predict = new URLSearchParams(a.predict.replaceAll(",", "&")); // "p1.ucs=3.9,p2.ir=1.2"
  const out = path.resolve(a.out ?? fs.mkdtempSync(path.join(os.tmpdir(), "page-timing-out-")));
  fs.mkdirSync(out, { recursive: true });
  const common = { base: path.resolve(a.base), head: path.resolve(a.head), out, chrome: a.chrome };
  const host = a.qualification ? JSON.parse(fs.readFileSync(a.qualification, "utf8")) : null;
  const summary: Record<string, unknown> = {};
  let failed = false;
  for (const page of pages) {
    const blocks = [await block({ ...common, page, label: a.aa ? "aa1" : "ab" })];
    if (a.aa) {
      let q = core.qualifyHostPage(blocks);
      if (q.qualification === "needs-confirmation") {
        blocks.push(await block({ ...common, page, label: "aa2" }));
        q = core.qualifyHostPage(blocks);
      }
      summary[page] = { ...q, blocks };
      failed ||= q.qualification !== "qualified";
      console.log(
        `${page}: ${q.qualification}, MDI UCS ${q.mdi.ucs.toFixed(2)} s, IR ${q.mdi.ir.toFixed(2)} s`
      );
      continue;
    }
    const gates = (["ucs", "ir"] as const).map((signal) => {
      const d = blocks[0][signal];
      const saving = predict.get(`${page}.${signal}`);
      const predictedSaving = saving === null ? null : Number(saving);
      const verdict =
        host && gate({ ...host[page], mdi: host[page].mdi[signal], signal, d, predictedSaving });
      failed ||= !!verdict && verdict.verdict !== "pass";
      const result = verdict
        ? `${verdict.verdict} (${verdict.rule})`
        : "not gated (no --qualification)";
      console.log(
        `${page} ${signal}: median d ${median(d).toFixed(3)} s, d(7) ${kthLargest(d, 2).toFixed(3)} s, ${result}`
      );
      return { signal, d, verdict };
    });
    summary[page] = { gates, ucsLive: blocks[0].ucsLive };
  }
  const file = path.join(out, a.aa ? "qualification.json" : "summary.json");
  fs.writeFileSync(file, JSON.stringify(summary, null, 2));
  console.log(`per-run JSON, server logs and UCS screenshots: ${out}`);
  return failed ? 1 : 0;
}

// Any throw (seed rewritten, service worker, missing signal, timeout, busy host) is exit 3: the block is void.
main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(3);
  }
);
