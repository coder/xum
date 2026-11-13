import { describe, expect, test } from "bun:test";
import {
  LAYOUT_MEMORY_MAX_PATHS,
  layoutAuditLastStartedAtMs,
  layoutAuditPathsInFlight,
  layoutFingerprint,
  startLayoutAudit,
  type FingerprintSnapshot,
  type LayoutAuditTurn,
} from "./layoutFingerprints";

const remember = (...values: string[]): FingerprintSnapshot => ({ phone: new Set(values) });

/** Each test uses its own session dir: the memory is module-level and outlives a test. */
let nextDir = 0;
const freshDir = () => `/sessions/layout-memory-${nextDir++}`;

describe("layoutFingerprint", () => {
  test("is the same for the same rule and selector and differs when either differs", () => {
    const base = layoutFingerprint("clipped-text", "div > p");
    expect(layoutFingerprint("clipped-text", "div > p")).toBe(base);
    expect(layoutFingerprint("overlapping-text", "div > p")).not.toBe(base);
    expect(layoutFingerprint("clipped-text", "div > p ")).not.toBe(base);
  });

  test("stays short however long the selector is", () => {
    expect(layoutFingerprint("clipped-text", "x".repeat(1_000_000))).toHaveLength(22);
  });
});

/**
 * Ends an audit with `next` as its memory and returns what it read as `previous`. `remember`
 * false is an audit that leaves no memory behind (nothing completed, or a turn-end audit), and
 * `staysDue` one that does not settle the page (cancelled, or an issue the agent was not shown).
 */
const finish = (
  turn: LayoutAuditTurn,
  next: FingerprintSnapshot = {},
  remember = true,
  staysDue = false
) =>
  turn.finish(
    (previous) => ({ report: previous, next }),
    remember,
    () => staysDue
  );

/** The memory of a path, read by an audit that leaves nothing behind. */
const memoryOf = (dir: string, relPath: string) =>
  finish(startLayoutAudit(dir, relPath), {}, false);

describe("startLayoutAudit", () => {
  test("starts with nothing and returns what build returns", () => {
    const report = startLayoutAudit(freshDir(), "a.html").finish(
      (previous) => ({ report: `saw ${Object.keys(previous).length} classes`, next: {} }),
      true
    );
    expect(report).toBe("saw 0 classes");
  });

  test("hands the next audit of the same path what the last one committed", () => {
    const dir = freshDir();
    finish(startLayoutAudit(dir, "a.html"), remember("one"));
    expect(memoryOf(dir, "a.html")).toEqual(remember("one"));
  });

  test("keeps paths and session dirs apart", () => {
    const dir = freshDir();
    finish(startLayoutAudit(dir, "a.html"), remember("one"));
    expect(memoryOf(dir, "b.html")).toEqual({});
    expect(memoryOf(freshDir(), "a.html")).toEqual({});
  });

  test("an audit that does not remember leaves the memory as it was", () => {
    const dir = freshDir();
    finish(startLayoutAudit(dir, "a.html"), remember("kept"));
    finish(startLayoutAudit(dir, "a.html"), remember("dropped"), false);
    expect(memoryOf(dir, "a.html")).toEqual(remember("kept"));
  });

  test("an audit that started first and finishes last does not overwrite the newer memory", () => {
    const dir = freshDir();
    const early = startLayoutAudit(dir, "a.html");
    const late = startLayoutAudit(dir, "a.html");
    finish(late, remember("late"));
    // The early audit still gets its own report (it read what the late one left), and loses
    // the commit.
    expect(finish(early, remember("early"))).toEqual(remember("late"));
    expect(memoryOf(dir, "a.html")).toEqual(remember("late"));
  });

  test("an audit that started later overwrites the earlier one's memory", () => {
    const dir = freshDir();
    const early = startLayoutAudit(dir, "a.html");
    const late = startLayoutAudit(dir, "a.html");
    finish(early, remember("early"));
    finish(late, remember("late"));
    expect(memoryOf(dir, "a.html")).toEqual(remember("late"));
  });

  test("a later audit that left nothing behind does not stop an earlier one from committing", () => {
    const dir = freshDir();
    const early = startLayoutAudit(dir, "a.html");
    const late = startLayoutAudit(dir, "a.html");
    finish(late, remember("never kept"), false);
    finish(early, remember("early"));
    expect(memoryOf(dir, "a.html")).toEqual(remember("early"));
  });

  test("an older audit that finishes after the newer one's memory was evicted does not write", () => {
    const dir = freshDir();
    const older = startLayoutAudit(dir, "a.html");
    const newer = startLayoutAudit(dir, "a.html");
    finish(newer, remember("newer"));
    // Enough other paths commit to push a.html's entry out of the bounded memory.
    for (let index = 0; index < LAYOUT_MEMORY_MAX_PATHS; index++) {
      finish(startLayoutAudit(dir, `other${index}.html`), remember(`other${index}`));
    }
    expect(memoryOf(dir, "a.html")).toEqual({});
    finish(older, remember("older"));
    expect(memoryOf(dir, "a.html")).toEqual({});
  });

  test("the start order is kept per path", () => {
    const dir = freshDir();
    const early = startLayoutAudit(dir, "a.html");
    const otherPath = startLayoutAudit(dir, "b.html");
    finish(otherPath, remember("b"));
    finish(early, remember("a"));
    expect(memoryOf(dir, "a.html")).toEqual(remember("a"));
  });

  test("forgets the path audited longest ago once the bound is passed", () => {
    const dir = freshDir();
    for (let index = 0; index <= LAYOUT_MEMORY_MAX_PATHS; index++) {
      finish(startLayoutAudit(dir, `p${index}.html`), remember(`p${index}`));
    }
    expect(memoryOf(dir, "p0.html")).toEqual({});
    expect(memoryOf(dir, `p${LAYOUT_MEMORY_MAX_PATHS}.html`)).toEqual(
      remember(`p${LAYOUT_MEMORY_MAX_PATHS}`)
    );
  });

  test("a path that keeps being audited is not the one forgotten", () => {
    const dir = freshDir();
    const commitAs = (relPath: string) => finish(startLayoutAudit(dir, relPath), remember(relPath));
    commitAs("busy.html");
    for (let index = 0; index < LAYOUT_MEMORY_MAX_PATHS; index++) {
      commitAs(`filler${index}.html`);
      commitAs("busy.html");
    }
    expect(memoryOf(dir, "busy.html")).toEqual(remember("busy.html"));
    expect(memoryOf(dir, "filler0.html")).toEqual({});
  });

  test("reading a path's memory does not save it from eviction, committing it again does", () => {
    const dir = freshDir();
    const commitAs = (relPath: string) => finish(startLayoutAudit(dir, relPath), remember(relPath));
    for (let index = 0; index < LAYOUT_MEMORY_MAX_PATHS; index++) commitAs(`p${index}.html`);
    // A read of the oldest path leaves it the oldest: the next commit evicts it.
    expect(memoryOf(dir, "p0.html")).toEqual(remember("p0.html"));
    commitAs("first-newcomer.html");
    expect(memoryOf(dir, "p0.html")).toEqual({});
    // A commit of the now oldest path makes it the newest: the next commit evicts the one after.
    commitAs("p1.html");
    commitAs("second-newcomer.html");
    expect(memoryOf(dir, "p1.html")).toEqual(remember("p1.html"));
    expect(memoryOf(dir, "p2.html")).toEqual({});
  });

  test("an audit that remembers nothing does not move its path in the recency order", () => {
    const dir = freshDir();
    for (let index = 0; index < LAYOUT_MEMORY_MAX_PATHS; index++) {
      finish(startLayoutAudit(dir, `p${index}.html`), remember(`p${index}`));
    }
    finish(startLayoutAudit(dir, "newcomer.html"), remember("newcomer"), false);
    expect(memoryOf(dir, "p0.html")).toEqual(remember("p0"));
  });
});

describe("layoutAuditLastStartedAtMs", () => {
  test("is undefined for a path no audit has ended for", () => {
    expect(layoutAuditLastStartedAtMs(freshDir(), "a.html")).toBeUndefined();
    const dir = freshDir();
    startLayoutAudit(dir, "a.html", 100);
    expect(layoutAuditLastStartedAtMs(dir, "a.html")).toBeUndefined();
  });

  test("is the start of an audit that settled the page, whether or not it remembered anything", () => {
    const dir = freshDir();
    finish(startLayoutAudit(dir, "kept.html", 100), remember("one"));
    finish(startLayoutAudit(dir, "dropped.html", 200), remember("two"), false);
    expect(layoutAuditLastStartedAtMs(dir, "kept.html")).toBe(100);
    expect(layoutAuditLastStartedAtMs(dir, "dropped.html")).toBe(200);
  });

  test("an audit that leaves the page due records nothing and leaves an earlier start as it was", () => {
    const dir = freshDir();
    finish(startLayoutAudit(dir, "a.html", 100), {}, true, true);
    expect(layoutAuditLastStartedAtMs(dir, "a.html")).toBeUndefined();
    finish(startLayoutAudit(dir, "a.html", 200));
    finish(startLayoutAudit(dir, "a.html", 300), {}, false, true);
    expect(layoutAuditLastStartedAtMs(dir, "a.html")).toBe(200);
  });

  test("the latest start wins, whichever audit ends last", () => {
    const dir = freshDir();
    const early = startLayoutAudit(dir, "a.html", 100);
    const late = startLayoutAudit(dir, "a.html", 200);
    finish(late);
    finish(early);
    expect(layoutAuditLastStartedAtMs(dir, "a.html")).toBe(200);
  });

  test("keeps paths and session dirs apart", () => {
    const dir = freshDir();
    finish(startLayoutAudit(dir, "a.html", 100));
    expect(layoutAuditLastStartedAtMs(dir, "b.html")).toBeUndefined();
    expect(layoutAuditLastStartedAtMs(freshDir(), "a.html")).toBeUndefined();
  });

  test("forgets the path audited longest ago once the bound is passed", () => {
    const dir = freshDir();
    for (let index = 0; index <= LAYOUT_MEMORY_MAX_PATHS; index++) {
      finish(startLayoutAudit(dir, `p${index}.html`, 100 + index), {}, false);
    }
    expect(layoutAuditLastStartedAtMs(dir, "p0.html")).toBeUndefined();
    expect(layoutAuditLastStartedAtMs(dir, `p${LAYOUT_MEMORY_MAX_PATHS}.html`)).toBe(
      100 + LAYOUT_MEMORY_MAX_PATHS
    );
  });
});

describe("the audits of a path in flight", () => {
  test("a path counts from its first start until its last finish", () => {
    const dir = freshDir();
    const base = layoutAuditPathsInFlight();
    const first = startLayoutAudit(dir, "a.html");
    const second = startLayoutAudit(dir, "a.html");
    expect(layoutAuditPathsInFlight()).toBe(base + 1);
    finish(second, remember("second"));
    expect(layoutAuditPathsInFlight()).toBe(base + 1);
    finish(first, {}, false);
    expect(layoutAuditPathsInFlight()).toBe(base);
  });

  test("a finish that leaves nothing behind still ends the audit", () => {
    const base = layoutAuditPathsInFlight();
    finish(startLayoutAudit(freshDir(), "a.html"), remember("dropped"), false);
    expect(layoutAuditPathsInFlight()).toBe(base);
  });

  const throwingBuild = () => {
    throw new Error("build failed");
  };

  test("a build that throws still ends the audit, and leaves the page due", () => {
    const base = layoutAuditPathsInFlight();
    const dir = freshDir();
    const turn = startLayoutAudit(dir, "a.html", 100);
    expect(() => turn.finish(throwingBuild, true)).toThrow("build failed");
    expect(layoutAuditPathsInFlight()).toBe(base);
    expect(layoutAuditLastStartedAtMs(dir, "a.html")).toBeUndefined();
  });
});
