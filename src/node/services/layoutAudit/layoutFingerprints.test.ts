import { describe, expect, test } from "bun:test";
import {
  LAYOUT_MEMORY_MAX_PATHS,
  layoutFingerprint,
  withLayoutMemory,
  type FingerprintSnapshot,
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

describe("withLayoutMemory", () => {
  test("starts with nothing and returns what the audit returns", async () => {
    const result = await withLayoutMemory(freshDir(), "a.html", async (memory) => {
      expect(memory.previous).toEqual({});
      return "report";
    });
    expect(result).toBe("report");
  });

  test("hands the next audit of the same path what the last one committed", async () => {
    const dir = freshDir();
    await withLayoutMemory(dir, "a.html", async (memory) => memory.commit(remember("one")));
    await withLayoutMemory(dir, "a.html", async (memory) => {
      expect(memory.previous).toEqual(remember("one"));
    });
  });

  test("keeps paths and session dirs apart", async () => {
    const dir = freshDir();
    await withLayoutMemory(dir, "a.html", async (memory) => memory.commit(remember("one")));
    await withLayoutMemory(dir, "b.html", async (memory) => {
      expect(memory.previous).toEqual({});
    });
    await withLayoutMemory(freshDir(), "a.html", async (memory) => {
      expect(memory.previous).toEqual({});
    });
  });

  test("runs overlapping audits of one path one at a time, in call order", async () => {
    const dir = freshDir();
    const events: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withLayoutMemory(dir, "a.html", async (memory) => {
      events.push("first start");
      await firstMayFinish;
      memory.commit(remember("from first"));
      events.push("first end");
    });
    const second = withLayoutMemory(dir, "a.html", async (memory) => {
      events.push(`second start, saw ${[...(memory.previous.phone ?? [])].join()}`);
    });
    // Another path is not held up by the first audit.
    await withLayoutMemory(dir, "b.html", async () => {
      events.push("other path");
    });
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "first start",
      "other path",
      "first end",
      "second start, saw from first",
    ]);
  });

  test("an audit that throws or does not commit leaves the memory as it was", async () => {
    const dir = freshDir();
    await withLayoutMemory(dir, "a.html", async (memory) => memory.commit(remember("kept")));
    await expect(
      withLayoutMemory(dir, "a.html", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    await withLayoutMemory(dir, "a.html", async () => undefined);
    await withLayoutMemory(dir, "a.html", async (memory) => {
      expect(memory.previous).toEqual(remember("kept"));
    });
  });

  test("forgets the path audited longest ago once the bound is passed", async () => {
    const dir = freshDir();
    for (let index = 0; index <= LAYOUT_MEMORY_MAX_PATHS; index++) {
      await withLayoutMemory(dir, `p${index}.html`, async (memory) => {
        memory.commit(remember(`p${index}`));
        return undefined;
      });
    }
    await withLayoutMemory(dir, "p0.html", async (memory) => {
      expect(memory.previous).toEqual({});
    });
    await withLayoutMemory(dir, `p${LAYOUT_MEMORY_MAX_PATHS}.html`, async (memory) => {
      expect(memory.previous).toEqual(remember(`p${LAYOUT_MEMORY_MAX_PATHS}`));
    });
  });

  test("a path that keeps being audited is not the one forgotten", async () => {
    const dir = freshDir();
    const commitAs = (relPath: string) =>
      withLayoutMemory(dir, relPath, async (memory) => memory.commit(remember(relPath)));
    await commitAs("busy.html");
    for (let index = 0; index < LAYOUT_MEMORY_MAX_PATHS; index++) {
      await commitAs(`filler${index}.html`);
      await commitAs("busy.html");
    }
    await withLayoutMemory(dir, "busy.html", async (memory) => {
      expect(memory.previous).toEqual(remember("busy.html"));
    });
    await withLayoutMemory(dir, "filler0.html", async (memory) => {
      expect(memory.previous).toEqual({});
    });
  });
});
