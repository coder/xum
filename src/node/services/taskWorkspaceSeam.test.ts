import { afterEach, describe, expect, setSystemTime, test } from "bun:test";

import { getReportedAtAfter } from "@/node/services/taskWorkspaceSeam";

const NOW = "2026-10-01T00:00:05.000Z";

describe("getReportedAtAfter", () => {
  afterEach(() => {
    setSystemTime();
  });

  test.each([
    { name: "no previous report time", previous: undefined },
    { name: "a previous report time that is not a date", previous: "not a time" },
    { name: "an earlier report time", previous: "2026-10-01T00:00:04.999Z" },
  ])("is the clock's time given $name", (c) => {
    setSystemTime(new Date(NOW));
    expect(getReportedAtAfter(c.previous)).toBe(NOW);
  });

  test.each([
    { name: "that the clock repeats", previous: NOW, expected: "2026-10-01T00:00:05.001Z" },
    {
      name: "that is ahead of a clock that stepped back",
      previous: "2026-10-01T00:00:09.000Z",
      expected: "2026-10-01T00:00:09.001Z",
    },
  ])("is the millisecond after a previous report time $name", (c) => {
    setSystemTime(new Date(NOW));
    expect(getReportedAtAfter(c.previous)).toBe(c.expected);
  });

  // Two writers that finalize one attempt's report one after the other read the row's latest time,
  // so on a clock that stands still every report writes a time that no earlier one wrote. In
  // particular the second never gives back the time the attempt began with.
  test("never repeats an earlier report time on a clock that stands still", () => {
    setSystemTime(new Date(NOW));
    const written = [NOW];
    for (let report = 0; report < 5; report++) {
      written.push(getReportedAtAfter(written.at(-1)));
    }
    expect(new Set(written).size).toBe(written.length);
    expect([...written].sort()).toEqual(written);
  });
});
