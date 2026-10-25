import { describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  getSelfIdentity,
  judgeHolder,
  parseProcessIdentity,
  probeProcessBirth,
} from "./processLiveness";

// Each test kills mutants that the phase 4 whole-file mutation run left alive (#7255).
describe.skipIf(process.platform !== "linux")("processLiveness on Linux", () => {
  test("probeProcessBirth reads starttime (field 22), also when comm holds spaces and ')'", async () => {
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "process-liveness-"));
    // The kernel names a process (comm) after the file it executes.
    const exe = path.join(dir, "a) b");
    await fsPromises.symlink(process.execPath, exe);
    const child = spawn(exe, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
      const pid = child.pid!;
      let stat = "";
      for (let tries = 0; !stat.includes("(a) b)") && tries < 200; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      }
      expect(stat).toContain("(a) b)");
      // Fields 3 to 21 follow the last ") ".
      const starttime = /^.*\) (?:\S+ ){19}(\d+) /s.exec(stat)?.[1];
      expect(probeProcessBirth(pid)).toBe(`linux-ticks:${starttime ?? "unparsed"}`);
      expect(probeProcessBirth(pid)).not.toBe(probeProcessBirth(process.pid));
    } finally {
      child.kill("SIGKILL");
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  });

  test("a v2 record with an empty boot id or PID namespace is refused, never judged dead", () => {
    const deadPid = spawnSync(process.execPath, ["--version"]).pid;
    for (const field of ["bootId", "pidNs"]) {
      const identity = parseProcessIdentity({ ...getSelfIdentity(), [field]: "" });
      expect(judgeHolder({ pid: deadPid, identity }, false)).toEqual({
        dead: false,
        why: "its boot or PID namespace is unknown",
      });
    }
  });
});

// T14 (#7475): the `ps -o lstart=` branch runs only where /proc is missing (macOS). A spy that
// makes the /proc read fail reaches it on Linux too, and a spawnSync stub sets the ps result.
describe("probeProcessBirth without /proc", () => {
  function probeWith(ps: { status: number | null; stdout?: string }, stat?: string): string | null {
    const read = spyOn(fs, "readFileSync").mockImplementation((() => {
      if (stat !== undefined) return stat;
      throw Object.assign(new Error("ENOENT: no /proc"), { code: "ENOENT" });
    }) as unknown as typeof fs.readFileSync);
    const runPs = spyOn(childProcess, "spawnSync").mockImplementation(
      (() => ps) as unknown as typeof childProcess.spawnSync
    );
    try {
      return probeProcessBirth(4242);
    } finally {
      read.mockRestore();
      runPs.mockRestore();
    }
  }

  test("uses the trimmed ps start time only when ps succeeds with output", () => {
    expect(probeWith({ status: 0, stdout: " Sun Oct 25 15:01:33 2026\n" })).toBe(
      "ps-lstart:Sun Oct 25 15:01:33 2026"
    );
    expect(probeWith({ status: 0, stdout: "x" })).toBe("ps-lstart:x");
    expect(probeWith({ status: 0, stdout: " \n" })).toBeNull();
    expect(probeWith({ status: 1, stdout: "Sun Oct 25 15:01:33 2026" })).toBeNull();
  });

  test("a stat whose starttime field is not a number falls through to ps", () => {
    const fields = Array.from({ length: 19 }, (_, i) => String(i + 3)).join(" ");
    expect(probeWith({ status: 1 }, `4242 (x) ${fields} abc 0 0\n`)).toBeNull();
    expect(probeWith({ status: 1 }, `4242 (x) ${fields} 77 0 0\n`)).toBe("linux-ticks:77");
  });
});
