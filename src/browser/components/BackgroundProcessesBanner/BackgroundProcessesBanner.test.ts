import { describe, expect, test } from "bun:test";
import { formatProcessDetail } from "./BackgroundProcessesBanner";

const monitor = {
  filter: "READY|FAILED",
  filter_exclude: false,
  cooldown_ms: 1000,
  totalMatches: 0,
  droppedLines: 0,
  lastLines: [],
  stopped: false,
};

describe("formatProcessDetail", () => {
  test("names what a monitor watches for, then the pid", () => {
    expect(formatProcessDetail({ monitor, pid: 48211 })).toBe(
      "watching /READY|FAILED/ · 0 matches · pid 48211"
    );
    expect(
      formatProcessDetail({ monitor: { ...monitor, totalMatches: 1, stopped: true }, pid: 7 })
    ).toBe("watching /READY|FAILED/ · 1 match · stopped · pid 7");
  });

  test("shows only the pid without a monitor, and no pid for a row restored from a pending wake", () => {
    expect(formatProcessDetail({ pid: 48390 })).toBe("pid 48390");
    expect(formatProcessDetail({ monitor, pid: 0 })).toBe("watching /READY|FAILED/ · 0 matches");
  });
});
