/**
 * Pure parts of the page-timing runner (T3 #5971, plan sections 2.3-2.6): per-run values, the service-worker
 * proof, the host rule and the host qualification. scripts/perf/pageTiming.ts drives the browser.
 */
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import {
  minimumDetectableImprovement,
  qualifyPage,
  type Qualification,
  type Signal,
} from "./pageTimingStats";

export type Page = "p1" | "p2";
/** Text-matched targets. P2's code line comes from scripts/perf/fixtures/neutralSeed/chat.jsonl. */
export const TARGET: Record<Page, { selector: string; text: string }> = {
  p1: { selector: "p", text: "OSS contributors with GitHub accounts" },
  p2: { selector: ".code-line", text: "export function subtract(" },
};

/** What the in-page probe records, in ms since navigation start. "Live" excludes a static first view. */
export interface ProbeRecord {
  elementTiming: Array<{ live: boolean; renderTime: number }>;
  visible: number | null;
  visibleLive: number | null;
  ir: number | null;
}

/**
 * Useful content shown (UCS) = the later of the target's Element Timing paint and the first frame in which
 * it is visible. Never LCP: on P2 the only LCP entry is the later syntax-highlight repaint. Seconds.
 */
export function usefulContentShown(r: ProbeRecord): { ucs: number; ucsLive: number } {
  const first = (live: boolean | null) => {
    const times = r.elementTiming.filter((e) => live === null || e.live === live);
    return times.length ? Math.min(...times.map((e) => e.renderTime)) : null;
  };
  const [any, live] = [first(null), first(true)];
  assert(any !== null && live !== null, "no Element Timing entry for the target");
  assert(r.visible !== null && r.visibleLive !== null, "the target never became visible");
  return { ucs: Math.max(any, r.visible) / 1000, ucsLive: Math.max(live, r.visibleLive) / 1000 };
}

/** The auditor's proof that the deleted service-worker API stayed gone for the whole run. */
export function serviceWorkerProofFailures(p: {
  workers: number;
  fromWorker: number;
  apiAfterRun: boolean;
}): string[] {
  const failures: string[] = [];
  if (p.workers > 0) failures.push(`${p.workers} service worker(s) started`);
  if (p.fromWorker > 0) failures.push(`${p.fromWorker} response(s) came from a service worker`);
  if (p.apiAfterRun) failures.push("navigator.serviceWorker exists after the run");
  return failures;
}

/** Host rule: 1-minute load below 0.75 x CPUs, and PSI `cpu some avg10` below 10 where PSI exists. */
export function hostIsQuiet(load: number, pressureCpu: string | null, cpus: number): boolean {
  assert(Number.isFinite(load) && cpus > 0, `bad load ${load} or cpus ${cpus}`);
  const avg10 = pressureCpu === null ? 0 : Number(/^some avg10=([\d.]+)/m.exec(pressureCpu)?.[1]);
  assert(Number.isFinite(avg10), `bad /proc/pressure/cpu: ${pressureCpu}`);
  return load < 0.75 * cpus && avg10 < 10;
}

/**
 * Runs fn under the lock on a quiet host. It waits for quiet outside the lock, so a busy host never
 * holds it, and probes once more inside: busy releases the lock at once (at most `attempts` takes).
 */
export async function runOnQuietHost<T>(
  host: { isQuiet: () => boolean; sleep: (ms: number) => Promise<unknown> },
  withLock: <R>(fn: () => Promise<R>) => Promise<R>,
  fn: () => Promise<T>,
  attempts = 30
): Promise<T> {
  assert(attempts >= 1, `bad attempts ${attempts}`);
  for (let attempt = 0; attempt < attempts; attempt++) {
    for (let check = 1; !host.isQuiet(); check++) {
      if (check >= 60) throw new Error("the host stayed busy for 10 minutes: the block is aborted");
      await host.sleep(10_000);
    }
    const ran = await withLock(async () => (host.isQuiet() ? { value: await fn() } : null));
    if (ran) return ran.value;
  }
  throw new Error("the host turned busy at every lock take: the block is aborted");
}

export interface Run {
  page: Page;
  pair: number;
  arm: "base" | "head";
  values: Record<Signal | "ucsLive", number>;
}

/** d = head - base per pair, in pair order. Every pair must have both arms exactly once. */
export function pairDiffs(runs: Run[], page: Page, signal: keyof Run["values"]): number[] {
  const byPair = new Map<number, Partial<Record<Run["arm"], number>>>();
  for (const run of runs.filter((r) => r.page === page)) {
    const arms = byPair.get(run.pair) ?? {};
    assert(arms[run.arm] === undefined, `pair ${run.pair} has two ${run.arm} runs on ${page}`);
    byPair.set(run.pair, { ...arms, [run.arm]: run.values[signal] });
  }
  return [...byPair.keys()]
    .sort((a, b) => a - b)
    .map((pair) => {
      const { base, head } = byPair.get(pair)!;
      assert(base !== undefined && head !== undefined, `pair ${pair} on ${page} lacks an arm`);
      return head - base;
    });
}

/** One page's qualification from its A/A blocks, with the MDI per signal from every A/A pair. */
export function qualifyHostPage(blocks: Array<Record<Signal, number[]>>): {
  qualification: Qualification;
  mdi: Record<Signal, number>;
} {
  const pooled = (signal: Signal) => blocks.flatMap((b) => b[signal]);
  return {
    qualification: qualifyPage(blocks),
    mdi: {
      ucs: minimumDetectableImprovement(pooled("ucs")),
      ir: minimumDetectableImprovement(pooled("ir")),
    },
  };
}

/**
 * Seed files a run rewrote (diffSeed's changed and missing). Every load adds a token stats cache (a timestamp,
 * the chat file's inode) to session-usage.json: the app's own write, so only that key is ignored there.
 */
export function seedRewrites(
  diff: { changed: string[]; missing: string[] },
  before: Map<string, Buffer>,
  now: (rel: string) => Buffer
): string[] {
  const usage = (b: Buffer): unknown => ({ ...JSON.parse(String(b)), tokenStatsCache: null });
  const appWrite = (rel: string) => {
    try {
      return (
        rel.endsWith("session-usage.json") &&
        isDeepStrictEqual(usage(before.get(rel)!), usage(now(rel)))
      );
    } catch {
      return false; // unparsable now: a rewrite
    }
  };
  return [...diff.changed.filter((rel) => !appWrite(rel)), ...diff.missing];
}
