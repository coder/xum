import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import {
  PAGE_SETUP,
  TARGET,
  hostIsQuiet,
  pairDiffs,
  qualifyHostPage,
  runOnQuietHost,
  seedRewrites,
  serviceWorkerProofFailures,
  usefulContentShown,
  type Run,
} from "./pageTimingCore";
import { probe, STATIC_VIEW_ID } from "./pageTimingProbe";

test("UCS takes the later of Element Timing and visibility, and a static view counts only for UCS (any)", () => {
  const record = {
    elementTiming: [
      { live: false, renderTime: 1500 },
      { live: true, renderTime: 9000 },
    ],
    visible: 1700, // the static copy is painted at 1.5 s but hidden behind a fade until 1.7 s
    visibleLive: 9200, // the live copy is painted at 9 s and shown one frame later
    ir: null,
  };
  expect(usefulContentShown(record)).toEqual({ ucs: 1.7, ucsLive: 9.2 });
  // A run whose target never painted fails instead of falling back to another signal.
  expect(() => usefulContentShown({ ...record, elementTiming: [record.elementTiming[0]] })).toThrow(
    "no Element Timing"
  );
  expect(() => usefulContentShown({ ...record, visibleLive: null })).toThrow(
    "never became visible"
  );
});

test("the service-worker proof names every way a worker could have served the run", () => {
  expect(serviceWorkerProofFailures({ workers: 0, fromWorker: 0, apiAfterRun: false })).toEqual([]);
  expect(serviceWorkerProofFailures({ workers: 1, fromWorker: 3, apiAfterRun: true })).toHaveLength(
    3
  );
});

test("the host rule needs both a low load and low CPU pressure", () => {
  const psi = (avg10: number) =>
    `some avg10=${avg10} avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00`;
  expect(hostIsQuiet(23.9, psi(9.9), 32)).toBe(true);
  expect(hostIsQuiet(24, psi(0), 32)).toBe(false);
  expect(hostIsQuiet(1, psi(10), 32)).toBe(false);
  expect(hostIsQuiet(1, null, 32)).toBe(true); // no PSI (macOS, older kernels)
});

test("paired differences are head - base in pair order, and a missing or doubled arm is refused", () => {
  const run = (pair: number, arm: Run["arm"], ucs: number): Run => ({
    page: "p2",
    pair,
    arm,
    values: { ucs, ucsLive: ucs, ir: 0 },
  });
  // ABBA order: pair 1 runs head first.
  const runs = [run(0, "base", 9), run(0, "head", 8), run(1, "head", 7.5), run(1, "base", 9.5)];
  expect(pairDiffs(runs, "p2", "ucs")).toEqual([-1, -2]);
  expect(pairDiffs(runs, "p1", "ucs")).toEqual([]);
  expect(() => pairDiffs(runs.slice(0, 3), "p2", "ucs")).toThrow("lacks an arm");
  expect(() => pairDiffs([...runs, run(1, "head", 7)], "p2", "ucs")).toThrow("two head runs");
});

test("a page's MDI pools the pairs of every A/A block it ran", () => {
  const quiet = [0.02, -0.03, 0.01, 0, -0.01, 0.04, -0.02, 0.03];
  const noisy = [0.2, 0.25, 0.21, 0.19, 0.22, 0.3, 0.18, 0.2]; // median 0.205 fails qualification
  const one = qualifyHostPage([{ ucs: noisy, ir: quiet }]);
  expect(one.qualification).toBe("needs-confirmation");
  const two = qualifyHostPage([
    { ucs: noisy, ir: quiet },
    { ucs: quiet, ir: quiet },
  ]);
  expect(two.qualification).toBe("qualified");
  // Alone, the quiet block's d(7) is at most 0.04 s (MDI <= 0.08 s). The pooled MDI keeps the noisy pairs.
  expect(one.mdi.ucs).toBeGreaterThanOrEqual(0.36);
  expect(two.mdi.ucs).toBeGreaterThan(0.08);
});

test("a seed check ignores only the token stats cache the app adds to session-usage.json", () => {
  const [usage, cfg] = ["sessions/w/session-usage.json", "config.json"];
  const seed = Buffer.from('{"byModel":{},"version":1}');
  const before = new Map([usage, cfg].map((rel) => [rel, seed]));
  const check = (now: string, changed = [usage], missing: string[] = []) =>
    seedRewrites({ changed, missing }, before, () => Buffer.from(now));
  expect(check('{\n "version": 1, "byModel": {}, "tokenStatsCache": {"at": 1}\n}')).toEqual([]);
  expect(check('{"byModel":{"m":{}},"version":1,"tokenStatsCache":{}}')).toEqual([usage]);
  expect(check("{")).toEqual([usage]);
  expect(check(String(seed), [cfg], [usage])).toEqual([cfg, usage]);
});

test("never holds the lock while the host is busy, and bounds its waits and lock takes", async () => {
  const events: string[] = [];
  const withLock = <R>(fn: () => Promise<R>) => {
    events.push("lock");
    return fn().finally(() => events.push("unlock"));
  };
  const run = async () => void events.push("run");
  const sleep = async () => void events.push("sleep");
  // Busy twice, then quiet. Busy again at the probe inside the first hold, then quiet.
  const probes = [false, false, true, false, true, true];
  await runOnQuietHost({ isQuiet: () => probes.shift() ?? true, sleep }, withLock, run);
  expect(events.splice(0)).toEqual(["sleep", "sleep", "lock", "unlock", "lock", "run", "unlock"]);
  const flips = [true, false, true, false, true, false]; // quiet outside the lock, busy inside it
  const flipping = { isQuiet: () => flips.shift() ?? false, sleep };
  await expect(runOnQuietHost(flipping, withLock, run, 3)).rejects.toThrow("every lock take");
  expect(events.splice(0)).toEqual(["lock", "unlock", "lock", "unlock", "lock", "unlock"]);
  let busyProbes = 100; // busy for longer than the 60 probes (10 minutes) of one wait
  const busy = { isQuiet: () => --busyProbes < 0, sleep };
  await expect(runOnQuietHost(busy, withLock, run)).rejects.toThrow("busy for 10 minutes");
  expect(events).not.toContain("lock");
});

// Pins p1 and p2 (plan section 5.6, PR 3c): adding p1r must not change what they open or match.
// Catches, for example, a table that seeds p1 or sends p2 to "/".
test("p1 and p2 keep today's root, route and target", () => {
  const id = "a1b2c3d4e5";
  const setup = (page: "p1" | "p2") => ({
    seeded: PAGE_SETUP[page].seeded,
    route: PAGE_SETUP[page].route(id),
    target: TARGET[page],
  });
  expect(setup("p1")).toEqual({
    seeded: false,
    route: "/",
    target: { selector: "p", text: "OSS contributors with GitHub accounts" },
  });
  expect(setup("p2")).toEqual({
    seeded: true,
    route: `/workspace/${id}`,
    target: { selector: ".code-line", text: "export function subtract(" },
  });
});

describe("the probe's IR check", () => {
  // The probe runs in the page, so it reads these as globals. The test lends it a happy-dom window.
  const names = [
    "window",
    "document",
    "Navigator",
    "MutationObserver",
    "getComputedStyle",
    "requestAnimationFrame",
    "HTMLTextAreaElement",
    "Event",
  ] as const;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let dom: GlobalWindow;

  beforeEach(() => {
    dom = new GlobalWindow({ url: "http://localhost/" });
    for (const name of [...names, "PerformanceObserver"]) {
      saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    }
    for (const name of names) {
      const value = (dom as unknown as Record<string, unknown>)[name];
      const bound = typeof value === "function" && /^[a-z]/.test(name) ? value.bind(dom) : value;
      Object.defineProperty(globalThis, name, { value: bound, configurable: true, writable: true });
    }
    // Element Timing is UCS, not IR: a no-op observer keeps this test on the IR path.
    const observer = class {
      observe() {}
    };
    Object.defineProperty(globalThis, "PerformanceObserver", {
      value: observer,
      configurable: true,
      writable: true,
    });
  });

  afterEach(async () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
    await dom.happyDOM.close();
  });

  /** Starts the probe in IR mode, renders `html`, and waits for its IR (seconds, or null). */
  async function irOf(page: keyof typeof TARGET, html: string, wire: (doc: Document) => void) {
    probe({ target: TARGET[page], mode: "ir", page, staticViewId: STATIC_VIEW_ID });
    dom.document.body.innerHTML = html;
    wire(dom.document as unknown as Document);
    for (
      let i = 0;
      i < 50 &&
      (dom as unknown as { __pageTiming: { ir: number | null } }).__pageTiming.ir === null;
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return (dom as unknown as { __pageTiming: { ir: number | null } }).__pageTiming.ir;
  }
  const onClick = (doc: Document, label: string, effect: () => void) => {
    const button = [...doc.querySelectorAll("button")].find((b) => b.textContent === label)!;
    let clicks = 0;
    button.addEventListener("click", () => (clicks++, effect()));
    return () => clicks;
  };

  // Pins p1 and p2. Catches a p1r branch that also takes another page (for example `page !== "p2"`).
  test("p1: one click on the wizard's Next, ready once step 2 shows", async () => {
    let clicks = () => 0;
    const ir = await irOf("p1", '<div role="dialog"><button>Next</button></div>', (doc) => {
      clicks = onClick(doc, "Next", () =>
        doc
          .querySelector("[role=dialog]")!
          .insertAdjacentHTML("beforeend", '<div role="img" aria-label="Step 2 of 7"></div>')
      );
    });
    expect(ir).not.toBeNull();
    expect(clicks()).toBe(1);
  });

  test("p2: typed text stays and Send is enabled", async () => {
    const html =
      '<textarea aria-label="Message"></textarea><button aria-label="Send message" disabled>Send</button>';
    let box: HTMLTextAreaElement | null = null;
    const ir = await irOf("p2", html, (doc) => {
      box = doc.querySelector("textarea");
      const send = doc.querySelector<HTMLButtonElement>("button")!;
      box!.addEventListener("input", () => (send.disabled = box!.value === ""));
    });
    expect(ir).not.toBeNull();
    expect(box!.value).toBe("hi");
  });

  // Catches a probe without a p1r branch: it never clicks, so IR stays null.
  test("p1r: one click on Open Provider Settings, ready once the provider settings show", async () => {
    let clicks = () => 0;
    const ir = await irOf("p1r", "<main><button>Open Provider Settings</button></main>", (doc) => {
      clicks = onClick(doc, "Open Provider Settings", () =>
        doc.body.insertAdjacentHTML(
          "beforeend",
          "<p>Configure API keys and endpoints for AI providers. Keys are stored in <code>~/.xum/providers.jsonc</code></p>"
        )
      );
    });
    expect(ir).not.toBeNull();
    expect(clicks()).toBe(1);
  });
});
