/**
 * Page-timing runner (T3 #5971, plan sections 2.3-2.7): paired base/head runs of the two mobile pages in a
 * throttled Chrome, timing useful content shown (UCS, with UCS-live beside it) and interaction ready (IR).
 *   make page-timing PAGE_TIMING_ARGS="--base <tree> --head <tree> [--aa | --qualification <file>]
 *     [--pages p1,p2] [--predict p1.ucs=3.9,p2.ir=1.2] [--out <dir>] [--chrome <path>]"
 * A tree is a built checkout (`make build`). P1 is "/" on an empty root, P2 "/workspace/<id>" on the neutral
 * seed. Every run gets a fresh root, server and browser profile. --aa qualifies the host (one confirmatory
 * block for a failed page) and writes qualification.json, which gated runs read with --qualification.
 * For --aa, base and head are two builds of one commit, so build-to-build noise counts as host noise.
 * PAGE_TIMING_LOCK=<file>: one flock hold per run, never per block (the shared dev-host measurement lock).
 * Exit: 0 pass or qualified, 1 a gate failed or the host did not qualify, 2 bad input, 3 an invalid run.
 * A gated run (--qualification) takes one page: the summary is written only when every page ends.
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
const viewport = { width: 412, height: 823 };
const PHONE = {
  context: { viewport, deviceScaleFactor: 1.75, isMobile: true, hasTouch: true },
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
type Host = ReturnType<typeof core.qualifyHostPage>;
type Common = { page: core.Page; out: string; chrome: string };

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

function hostIsQuietNow(): boolean {
  const psiFile = "/proc/pressure/cpu";
  const psi = fs.existsSync(psiFile) ? fs.readFileSync(psiFile, "utf8") : null;
  return core.hostIsQuiet(os.loadavg()[0], psi, os.availableParallelism());
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
    try {
      process.kill(-server.pid!, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; // ESRCH: the group already exited
    }
    if (server.exitCode === null && server.signalCode === null) await once(server, "exit");
    // Workspace commands run in their own process groups, so the group kill misses them, and they can
    // still write into the seed after the server exits. All inherit HOME: wait until no process has it.
    for (let i = 0; withEnv(`HOME=${home}`).length > 0; i++) {
      if (i === 100) throw new Error(`${logFile}: processes outlived the server by 10 s`);
      await sleep(100);
    }
    fs.closeSync(log);
  };
  return { origin, stop };
}

/** One navigation with a fresh root (and seed), server and browser. Values in seconds. */
async function measure(o: Common & { tree: string; mode: Signal; name: string }) {
  // One lock hold per run, from seed creation to folder removal, never per block (see the header).
  // Never on a busy host either: runOnQuietHost waits for quiet outside the lock.
  return core.runOnQuietHost({ isQuiet: hostIsQuietNow, sleep }, withLock, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "page-timing-"));
    const [seedDir, log] = [path.join(tmp, "seed"), path.join(o.out, `${o.name}.server.log`)];
    let home = path.join(tmp, "home"); // a P2 run uses its seed's home
    try {
      const seed = o.page === "p2" ? writeNeutralSeed(seedDir) : null;
      const root = seed?.root ?? path.join(tmp, "root");
      home = seed?.home ?? home;
      const route = seed ? `/workspace/${seed.workspaceId}` : "/";
      const before = seed && snapshotSeed(seedDir);
      for (const dir of [root, home]) fs.mkdirSync(dir, { recursive: true });
      const server = await startServer(o.tree, root, home, log);
      const values = await browse(o, `${server.origin}${route}`).finally(server.stop);
      const now = (rel: string) => fs.readFileSync(path.join(seedDir, rel));
      const rewrites = before ? core.seedRewrites(diffSeed(before, seedDir), before, now) : [];
      if (rewrites.length > 0) throw new Error(`${o.name}: a build rewrote the seed: ${rewrites}`);
      return values;
    } finally {
      // Invalid runs clean up too, unless a process still uses the folder (stop() then threw).
      if (withEnv(`HOME=${home}`).length === 0) fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

async function browse(o: Parameters<typeof measure>[0], url: string): Promise<Values> {
  const browser = await chromium.launch({ executablePath: o.chrome, headless: true }); // fresh profile
  try {
    const context = await browser.newContext(PHONE.context);
    let [workers, fromWorker] = [0, 0];
    context.on("serviceworker", () => workers++);
    const { mode, page } = o;
    const arg = { target: core.TARGET[page], mode, page, staticViewId: STATIC_VIEW_ID };
    // tsx (esbuild keepNames) wraps the probe's inner functions in __name(), which the page lacks.
    const content = `var __name = (f) => f; (${probe})(${JSON.stringify(arg)})`;
    await context.addInitScript({ content });
    const tab = await context.newPage();
    tab.on("response", (r) => (fromWorker += r.fromServiceWorker() ? 1 : 0));
    const cdp = await context.newCDPSession(tab);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Network.emulateNetworkConditions", PHONE.network);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: PHONE.cpuSlowdown });
    await tab.goto(url, { waitUntil: "load", timeout: 180_000 });
    const ucsDone = "r.visibleLive !== null && r.elementTiming.some((e) => e.live)";
    const done = o.mode === "ucs" ? ucsDone : "r.ir !== null";
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
async function block(o: Common & { base: string; head: string; label: string }) {
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

/** The file's entry for the page if it can gate a run: qualified, with finite MDIs. Else null. */
function qualifiedEntry(file: string, page: core.Page) {
  try {
    const q = JSON.parse(fs.readFileSync(file, "utf8"))[page] as Host;
    const ok = [q.mdi.ucs, q.mdi.ir].every((v) => typeof v === "number" && v >= 0 && v < Infinity);
    return q.qualification === "qualified" && ok ? q : null;
  } catch {
    return null; // unreadable, not JSON, or no entry or MDIs for the page
  }
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
  const predict = new URLSearchParams(a.predict.replaceAll(",", "&")); // "p1.ucs=3.9,p2.ir=1.2"
  const keys = pages.flatMap((p) => [`${p}.ucs`, `${p}.ir`]);
  const cli = (t?: string) => (t ? path.resolve(t, "dist/cli/index.js") : "");
  const missing = [cli(a.base), cli(a.head)].filter((f) => f && !fs.existsSync(f));
  const host = a.qualification ? qualifiedEntry(a.qualification, pages[0]) : null;
  const errors = [
    !a.base || !a.head ? "--base and --head are required" : "",
    missing.length > 0 ? `not a built tree, missing: ${missing.join(", ")}` : "",
    pages.some((p) => !(p in core.TARGET)) ? `unknown page in --pages ${a.pages}` : "",
    a.aa && a.qualification ? "--aa and --qualification exclude each other" : "",
    a.qualification && pages.length !== 1 ? "a gated run takes one page (--pages p1)" : "",
    a.qualification && !host ? `${a.qualification} has no qualified ${pages[0]} entry` : "",
    a.predict && !a.qualification ? "--predict needs --qualification" : "",
    [...predict].some(([k, v]) => !keys.includes(k) || !(+v > 0)) ? "bad --predict keys" : "",
  ].filter(Boolean);
  if (!a.base || !a.head || errors.length > 0) {
    console.error(`${errors.join("; ")} (usage: see the header of scripts/perf/pageTiming.ts)`);
    return 2;
  }
  const out = path.resolve(a.out ?? fs.mkdtempSync(path.join(os.tmpdir(), "page-timing-out-")));
  fs.mkdirSync(out, { recursive: true });
  const common = { base: path.resolve(a.base), head: path.resolve(a.head), out, chrome: a.chrome };
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
      const predictedSaving = Number(predict.get(`${page}.${signal}`)) || null; // validated > 0
      const verdict = host && gate({ ...host, mdi: host.mdi[signal], signal, d, predictedSaving });
      failed ||= !!verdict && verdict.verdict !== "pass";
      const result = verdict ? `${verdict.verdict} (${verdict.rule})` : "not gated";
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

// A parseArgs error is bad input (2). Any other throw (seed, service worker, timeout, busy host) is 3.
main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(String((error as { code?: unknown }).code).startsWith("ERR_PARSE_ARGS") ? 2 : 3);
  }
);
