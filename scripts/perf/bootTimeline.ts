/**
 * Browser boot A/B for `xum server` (T3 #5971 Phase 2): HTTP-throttled slow 4G (Lighthouse mobile
 * devtools values) and 4x CPU, WebSockets unthrottled (CDP never delays WebSocket frames). All
 * timings are OBSERVED (ms from navigation start), never Lantern-simulated. Two signals, gated
 * separately: useful = the useful element's LCP entry, else a paint-checked DOM signal (visible,
 * opaque, still so one frame later); interaction = P1 Next advances the wizard, P2 typed text lands
 * in the composer and Send is enabled. Per run: a fresh seeded XUM_ROOT and `xum server` (probes
 * type a draft and advance the wizard), a fresh Chrome profile, service workers blocked and asserted
 * absent (the app's worker would bypass the throttling). Pairs alternate order; the host must be
 * quiet first. Only infrastructure failures retry the block, once, then exit 3 (inconclusive); any
 * other failure exits 1 at once. Runs under Node (tsx), like desktopColdStart.ts.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, type Page } from "playwright";
import { seedBootWorkspace, SEED_CODE_LINE } from "./bootSeed";
import { launchPlan, type Arm } from "./desktopColdStartStats";

const METHOD =
  "HTTP-throttled slow 4G (Lighthouse mobile devtools values), WebSockets unthrottled, 4x CPU; observed timings";
const USAGE =
  "usage: [CHROME_PATH=<chrome>] node --import tsx scripts/perf/bootTimeline.ts --base <tree> --head <tree> [--pairs 6] [--timeout-ms 120000] > result.json";
const PAGES = {
  p1: { selector: "p", text: "OSS contributors with GitHub accounts" },
  p2: { selector: ".code-line", text: SEED_CODE_LINE },
} as const;
type PageId = keyof typeof PAGES;
const HOST_WAIT_MS = 10 * 60_000;
export const AA_MAX_ABS_D_MS = 100; // plan section 3.1: A/A qualifies when every |d| <= 0.10 s

export class InfraError extends Error {}

/**
 * Runs a block, retrying it once only after an infrastructure failure (plan 3.1). Any other error,
 * and a second infrastructure failure, propagates at once.
 */
export async function withInfraRetry<T>(run: () => Promise<T>, log: (m: string) => void) {
  try {
    return { attempts: 1, ...(await run()) };
  } catch (error) {
    if (!(error instanceof InfraError)) throw error;
    log(`infrastructure failure, retrying the block once: ${error.message}`);
    return { attempts: 2, ...(await run()) };
  }
}

/** Host rule (plan 3.1): 1-min load below 3/4 of the CPUs and PSI cpu "some" avg10 below 10. */
export function hostQuiet(load1: number, psiSome10: number, cpus: number): boolean {
  return load1 < cpus * 0.75 && psiSome10 < 10;
}

function hostSample() {
  const load1 = Number(fs.readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
  const psi = /some avg10=([0-9.]+)/.exec(fs.readFileSync("/proc/pressure/cpu", "utf8"));
  return { load1, psiSome10: Number(psi?.[1] ?? NaN), cpus: os.availableParallelism() }; // affinity-aware, like nproc
}

async function waitForQuietHost() {
  const deadline = Date.now() + HOST_WAIT_MS;
  for (;;) {
    const h = hostSample();
    if (hostQuiet(h.load1, h.psiSome10, h.cpus)) return h;
    if (Date.now() > deadline) throw new InfraError(`host busy for 10 min: ${JSON.stringify(h)}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

/** Paired differences d = head - base (ms) and their extremes; the gates read maxD/minD. */
export function pairedDiffs(base: number[], head: number[]) {
  assert(
    base.length === head.length && base.length >= 2,
    `bad pair counts ${base.length}/${head.length}`
  );
  const d = base.map((b, i) => head[i] - b);
  assert(d.every(Number.isFinite), `non-finite difference in [${d.join()}]`);
  const maxAbsD = Math.max(...d.map(Math.abs));
  return { d, minD: Math.min(...d), maxD: Math.max(...d), maxAbsD };
}

interface Probe {
  lcpMs?: number; // first LCP entry whose element is the useful element
  domMs?: number;
}

type Signal = { lcpMs: number | null; domMs: number };

/**
 * The useful time per pair: the LCP entry when both arms have one, else the DOM check for both,
 * so one arm's LCP time is never compared with the other's DOM time.
 */
export function usefulPairs(base: Signal[], head: Signal[]) {
  assert(base.length === head.length, `bad pair counts ${base.length}/${head.length}`);
  const lcp = base.map((b, i) => b.lcpMs !== null && head[i].lcpMs !== null);
  const pick = (runs: Signal[]) => runs.map((r, i) => (lcp[i] ? r.lcpMs! : r.domMs));
  return { source: lcp.map((x) => (x ? "lcp" : "dom")), base: pick(base), head: pick(head) };
}

// Runs in the page before any app script; must not close over module state.
function installProbe(cfg: { selector: string; text: string }) {
  const boot: Probe = ((window as unknown as { __boot: Probe }).__boot = {});
  const isUseful = (n: Element | null) =>
    !!n?.matches(cfg.selector) && !!n.textContent?.includes(cfg.text);
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as Array<PerformanceEntry & { element: Element | null }>) {
      if (boot.lcpMs === undefined && isUseful(e.element)) boot.lcpMs = e.startTime;
    }
  }).observe({ type: "largest-contentful-paint", buffered: true });
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.bottom <= 0 || r.top >= innerHeight) return false;
    for (let e: Element | null = el; e; e = e.parentElement)
      if (Number(getComputedStyle(e).opacity) < 0.99) return false;
    return true;
  };
  const tick = () => {
    const el = [...document.querySelectorAll(cfg.selector)].find(isUseful);
    if (!el || !shown(el)) return void requestAnimationFrame(tick);
    const t = performance.now(); // confirmed one frame later, so a paint has passed
    requestAnimationFrame(() =>
      setTimeout(() => (el.isConnected && shown(el) ? (boot.domMs = t) : tick()))
    );
  };
  requestAnimationFrame(tick);
}

async function interactionMs(page: Page, id: PageId, timeout: number): Promise<number> {
  const raf = { polling: "raf" as const, timeout };
  if (id === "p1") {
    await page.getByRole("button", { name: "Next", exact: true }).click({ timeout });
    const h = await page.waitForFunction(
      () => document.querySelector('[role="img"][aria-label^="Step 2 of"]') && performance.now(),
      null,
      raf
    );
    return (await h.jsonValue()) as number;
  }
  const text = "boot-timeline probe";
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text, { timeout });
  const h = await page.waitForFunction(
    (t) => {
      const box = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
      const send = document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
      return box?.value === t && send && !send.disabled && performance.now();
    },
    text,
    raf
  );
  return (await h.jsonValue()) as number;
}

async function measure(url: string, id: PageId, timeout: number) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "xum-boot-profile-")); // fresh profile per run
  const viewport = { width: 412, height: 823 };
  const ctx = await chromium
    .launchPersistentContext(profile, {
      headless: true,
      executablePath: process.env.CHROME_PATH, // unset: Playwright's own Chromium
      viewport,
      deviceScaleFactor: 1.75,
      isMobile: true,
      hasTouch: true,
      serviceWorkers: "block",
    })
    .catch((error: unknown) => {
      throw new InfraError(`browser launch: ${String(error)}`);
    });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 562.5,
      downloadThroughput: (1474.56 * 1024) / 8,
      uploadThroughput: (675 * 1024) / 8,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const swServed: string[] = [];
    let responses = 0;
    page.on("response", (r) => void (responses++, r.fromServiceWorker() && swServed.push(r.url())));
    let t0: number | null = null;
    const ends: Array<{ t: number; bytes: number }> = [];
    cdp.on("Network.requestWillBeSent", (e) => void (t0 ??= e.timestamp));
    cdp.on("Network.loadingFinished", (e) =>
      ends.push({ t: e.timestamp, bytes: e.encodedDataLength })
    );
    // tsx (esbuild keepNames) wraps named inner functions in __name(), which the page lacks.
    await page.addInitScript("globalThis.__name = (fn) => fn;");
    await page.addInitScript(installProbe, PAGES[id]);
    await page.goto(url, { timeout });
    await page.waitForFunction(
      () => (window as unknown as { __boot: Probe }).__boot.domMs !== undefined,
      null,
      { timeout }
    );
    // A wizard over the transcript would mean the seed's splash ID went stale (bootSeed.ts).
    const wizard = await page.locator('[role="img"][aria-label^="Step "]').count();
    assert(id === "p1" || wizard === 0, "P2: the onboarding wizard is showing");
    const interaction = await interactionMs(page, id, timeout);
    // Read after the interaction: entries dispatched before the input still count. On P2 the
    // code line's entry has not arrived by then in practice, so its source is "dom".
    const { lcpMs, domMs } = await page.evaluate(
      () => (window as unknown as { __boot: Probe }).__boot
    );
    const [controller, registrations] = await page.evaluate(async () => [
      navigator.serviceWorker?.controller?.scriptURL ?? null,
      (await navigator.serviceWorker?.getRegistrations())?.length ?? 0,
    ]);
    assert(
      controller === null && registrations === 0 && swServed.length === 0,
      `service worker active: ${controller}, ${registrations} registered, served [${swServed}]`
    );
    const wire = ends
      .filter((e) => t0 != null && (e.t - t0) * 1000 <= domMs!)
      .reduce((s, e) => s + e.bytes, 0);
    return {
      lcpMs: lcpMs ?? null,
      domMs: domMs!,
      interactionMs: interaction,
      wireKiBBeforeUseful: wire / 1024,
      serviceWorker: { controller, registrations, responses, servedByWorker: swServed.length },
    };
  } finally {
    await ctx.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

async function freePort(): Promise<number> {
  const srv = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const { port } = srv.address() as net.AddressInfo;
  await new Promise((r) => srv.close(r));
  return port;
}

async function startServer(tree: string, id: PageId, tmp: string, timeout: number) {
  const dir = fs.mkdtempSync(path.join(tmp, `${id}-`));
  const root = path.join(dir, "root");
  fs.mkdirSync(path.join(dir, "home"), { recursive: true });
  const urlPath = id === "p2" ? `/workspace/${seedBootWorkspace(root)}` : "/";
  const port = await freePort();
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: path.join(dir, "home"),
    XUM_ROOT: root,
    XUM_DISABLE_TELEMETRY: "1",
  };
  const log = fs.openSync(path.join(dir, "server.log"), "a");
  const args = [path.join(tree, "dist/cli/index.js"), "server", "--no-auth", "--host", "127.0.0.1"];
  const child: ChildProcess = spawn(process.execPath, [...args, "--port", `${port}`], {
    cwd: tree,
    env,
    stdio: ["ignore", log, log],
    detached: true, // own process group: stop() also ends its children (it runs `gh`)
  });
  liveServers.add(child);
  const stop = async () => {
    const running = child.exitCode === null && child.signalCode === null;
    const exited = running ? new Promise((r) => child.once("exit", r)) : null;
    killGroup(child, "SIGTERM"); // also when the server is gone: its children may not be
    if (exited) {
      const force = setTimeout(() => killGroup(child, "SIGKILL"), 10_000);
      await exited;
      clearTimeout(force);
    }
    liveServers.delete(child);
    fs.closeSync(log);
  };
  const base = `http://127.0.0.1:${port}`;
  for (const deadline = Date.now() + timeout; ; await new Promise((r) => setTimeout(r, 250))) {
    const problem =
      child.exitCode !== null ? "exited" : Date.now() > deadline ? "not healthy" : null;
    if (problem) {
      await stop();
      throw new InfraError(`server ${tree} ${problem} (${dir}/server.log)`);
    }
    const healthy = await fetch(`${base}/health`).catch(() => null);
    if (healthy?.ok) break;
  }
  return { url: base + urlPath, stop };
}

/** Waits up to 30 s for processes whose HOME is in `tmp` (the server's detached `gh` lookups). */
async function waitForOrphans(tmp: string) {
  const ours = (pid: string) => {
    try {
      return fs.readFileSync(`/proc/${pid}/environ`, "utf8").includes(`\0HOME=${tmp}/`);
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 120 && fs.readdirSync("/proc").some(ours); i++)
    await new Promise((r) => setTimeout(r, 250));
}

/** Servers still running; killed if the harness exits early (signal, crash). */
const liveServers = new Set<ChildProcess>();
const killGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
  try {
    process.kill(-child.pid!, signal);
  } catch {
    // the group is already gone
  }
};
process.on("exit", () => liveServers.forEach((c) => killGroup(c, "SIGKILL")));
process.on("SIGINT", () => process.exit(130)).on("SIGTERM", () => process.exit(143));

async function runBlock(
  tree: Record<Arm, string>,
  id: PageId,
  pairs: number,
  timeout: number,
  tmp: string
) {
  const runs = [];
  for (const { arm, pair } of launchPlan(pairs, 0)) {
    const host = await waitForQuietHost();
    const server = await startServer(tree[arm], id, tmp, timeout);
    try {
      runs.push({ arm, pair, host, ...(await measure(server.url, id, timeout)) });
    } finally {
      await server.stop();
    }
    console.error(`${id} pair ${pair} ${arm}: useful (DOM) ${runs.at(-1)!.domMs.toFixed(0)} ms`);
  }
  const [b, h] = [runs.filter((r) => r.arm === "base"), runs.filter((r) => r.arm === "head")];
  const useful = usefulPairs(b, h);
  const result = {
    runs,
    usefulSource: useful.source,
    useful: pairedDiffs(useful.base, useful.head),
    interaction: pairedDiffs(
      b.map((r) => r.interactionMs),
      h.map((r) => r.interactionMs)
    ),
  };
  console.error(`${id} d(ms): useful ${result.useful.d}, interaction ${result.interaction.d}`);
  return result;
}

async function main(): Promise<void> {
  const usage = (m: string): never => (console.error(`${m}\n${USAGE}`), process.exit(2));
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      head: { type: "string" },
      pairs: { type: "string", default: "6" },
      "timeout-ms": { type: "string", default: "120000" },
    },
  });
  if (!values.base || !values.head) usage("--base and --head are required");
  const tree = { base: path.resolve(values.base!), head: path.resolve(values.head!) };
  for (const t of Object.values(tree))
    if (!fs.existsSync(path.join(t, "dist/cli/index.js"))) usage(`${t}: no dist (make build)`);
  const [pairs, timeout] = [Number(values.pairs), Number(values["timeout-ms"])];
  if (!(Number.isInteger(pairs) && pairs >= 2 && timeout > 0))
    usage("--pairs >= 2, --timeout-ms > 0");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xum-boot-"));
  process.on("exit", () => {
    // A stopped server's last child can still be writing into its root: retry, never throw.
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
    } catch (error) {
      console.error(`left ${tmp}: ${String(error)}`);
    }
  });
  const results: Record<string, Awaited<ReturnType<typeof runBlock>> & { attempts: number }> = {};
  for (const id of Object.keys(PAGES) as PageId[]) {
    const log = (m: string) => console.error(`${id}: ${m}`);
    results[id] = await withInfraRetry(() => runBlock(tree, id, pairs, timeout, tmp), log);
  }
  await waitForOrphans(tmp);
  const sha = (t: string) =>
    spawnSync("git", ["-C", t, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim() || null;
  const aa = tree.base === tree.head;
  const qualifies =
    aa &&
    Object.values(results).every(
      (r) => r.useful.maxAbsD <= AA_MAX_ABS_D_MS && r.interaction.maxAbsD <= AA_MAX_ABS_D_MS
    );
  const out = {
    method: METHOD,
    base: { tree: tree.base, sha: sha(tree.base) },
    head: { tree: tree.head, sha: sha(tree.head) },
    pairs,
    aa: aa ? { qualifies } : null,
    pages: results,
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (aa) console.error(`A/A qualifies (every |d| <= ${AA_MAX_ABS_D_MS} ms): ${qualifies}`);
}

if (fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(error instanceof InfraError ? 3 : 1); // 3 = inconclusive
  });
}
