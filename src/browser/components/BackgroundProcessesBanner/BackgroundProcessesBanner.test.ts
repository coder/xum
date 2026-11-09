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

// A row leads with its command; these rows' names repeat it, so the detail line skips them.
const row = { id: "bash_1", script: "make watch", displayName: "make watch" };

describe("formatProcessDetail", () => {
  test("names what a monitor watches for, then the pid", () => {
    expect(formatProcessDetail({ ...row, monitor, pid: 48211 })).toBe(
      "watching /READY|FAILED/ · 0 matches · pid 48211"
    );
    expect(
      formatProcessDetail({
        ...row,
        monitor: { ...monitor, totalMatches: 1, stopped: true },
        pid: 7,
      })
    ).toBe("watching /READY|FAILED/ · 1 match · stopped · pid 7");
  });

  test("shows only the pid without a monitor, and no pid for a row restored from a pending wake", () => {
    expect(formatProcessDetail({ ...row, pid: 48390 })).toBe("pid 48390");
    expect(formatProcessDetail({ ...row, monitor, pid: 0 })).toBe(
      "watching /READY|FAILED/ · 0 matches"
    );
  });

  test("names the process first when the row's command does not already say it", () => {
    const named = { id: "CI watch", script: "\n  gh pr checks 30958 --watch\nexit", pid: 9 };
    expect(formatProcessDetail({ ...named, displayName: "CI watch" })).toBe("CI watch · pid 9");
    // The leading blank line is skipped: the row leads with the first command.
    expect(formatProcessDetail({ ...named, displayName: "gh pr checks 30958 --watch" })).toBe(
      "pid 9"
    );
    // Without a command the row leads with the name, so the detail line does not repeat it.
    expect(formatProcessDetail({ ...named, script: " \n", displayName: "CI watch" })).toBe("pid 9");
  });
});
