import { afterEach, describe, expect, setSystemTime, test } from "bun:test";

import { getReportedAtAfter } from "@/node/services/taskWorkspaceSeam";

const NOW = "2026-10-01T00:00:05.000Z";

describe("getReportedAtAfter", () => {
  afterEach(() => {
    setSystemTime();
  });

  test.each([
    { name: "no previous report time", previous: undefined },
    { name: "an earlier report time", previous: "2026-10-01T00:00:04.999Z" },
    {
      name: "a report time ahead of a clock that stepped back",
      previous: "2026-10-01T00:00:09.000Z",
    },
  ])("is the clock's time given $name", (c) => {
    setSystemTime(new Date(NOW));
    expect(getReportedAtAfter(c.previous)).toBe(NOW);
  });

  test("differs from a previous report time that the clock repeats", () => {
    setSystemTime(new Date(NOW));
    const first = getReportedAtAfter(NOW);
    expect(first).toBe("2026-10-01T00:00:05.001Z");
    // A clock that stands still still changes it: never the previous one, whichever that is.
    expect(getReportedAtAfter(first)).not.toBe(first);
  });
});
