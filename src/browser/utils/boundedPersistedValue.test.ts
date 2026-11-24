import { describe, expect, test } from "bun:test";
import {
  trimArrayToChars,
  trimRecordToChars,
  truncateStringToChars,
  withRecordEntry,
} from "@/browser/utils/boundedPersistedValue";

const record = Object.fromEntries(
  Array.from({ length: 30 }, (_, index) => [`/repo/src/dir-${index}`, index % 2 === 0])
);

describe("bounded persisted values", () => {
  // A trimmed value one char over its key budget would not persist at all.
  test("trimRecordToChars keeps the newest entries that fit and nothing more", () => {
    for (const maxChars of [2, 30, 31, 32, 100, 257, 500, 10_000]) {
      const trimmed = trimRecordToChars(record, maxChars);
      const keys = Object.keys(trimmed);
      expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(maxChars);
      // Newest entries (end of insertion order) survive, as a contiguous suffix.
      expect(keys).toEqual(Object.keys(record).slice(Object.keys(record).length - keys.length));
      if (keys.length < Object.keys(record).length) {
        const oneMore = Object.keys(record).slice(Object.keys(record).length - keys.length - 1);
        const widened = Object.fromEntries(oneMore.map((key) => [key, record[key]]));
        expect(JSON.stringify(widened).length).toBeGreaterThan(maxChars);
      }
    }
  });

  test("trimRecordToChars skips an entry too large to fit alone instead of dropping the rest", () => {
    const withHugeNewest = { ...record, [`/repo/${"deep/".repeat(200)}`]: true };
    const trimmed = trimRecordToChars(withHugeNewest, 257);
    expect(Object.keys(trimmed)).toEqual(Object.keys(trimRecordToChars(record, 257)));
  });

  test("withRecordEntry makes the updated key the newest and removes it for undefined", () => {
    const first = Object.keys(record)[0];
    const updated = withRecordEntry(record, first, true, 10_000);
    expect(Object.keys(updated).at(-1)).toBe(first);

    const budget = JSON.stringify(record).length;
    const trimmed = withRecordEntry(record, "/repo/new", true, budget);
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(budget);
    expect(trimmed["/repo/new"]).toBe(true);
    expect(first in trimmed).toBe(false);

    expect(first in withRecordEntry(record, first, undefined, 10_000)).toBe(false);
  });

  test("trimArrayToChars keeps the longest prefix that fits", () => {
    const items = Array.from({ length: 20 }, (_, index) => ({ id: `ws-${index}`, title: "x" }));
    for (const maxChars of [2, 25, 26, 27, 200, 10_000]) {
      const trimmed = trimArrayToChars(items, maxChars);
      expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(maxChars);
      expect(trimmed).toEqual(items.slice(0, trimmed.length));
      if (trimmed.length < items.length) {
        expect(JSON.stringify(items.slice(0, trimmed.length + 1)).length).toBeGreaterThan(maxChars);
      }
    }
  });

  // Escapes count toward the budget, and a cut inside a surrogate pair would persist a broken char.
  test("truncateStringToChars keeps the longest serialized prefix that fits on code points", () => {
    const value = `a"b\n${"\u{1F600}".repeat(3)}c`;
    for (let maxChars = 2; maxChars <= JSON.stringify(value).length + 1; maxChars++) {
      const truncated = truncateStringToChars(value, maxChars);
      expect(value.startsWith(truncated)).toBe(true);
      expect(JSON.stringify(truncated).length).toBeLessThanOrEqual(maxChars);
      expect(truncated).not.toMatch(/[\uD800-\uDBFF]$/);
      if (truncated !== value) {
        const next = String.fromCodePoint(value.codePointAt(truncated.length) ?? 0);
        expect(JSON.stringify(truncated + next).length).toBeGreaterThan(maxChars);
      }
    }
  });
});
