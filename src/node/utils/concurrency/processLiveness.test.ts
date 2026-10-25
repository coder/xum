import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
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
      expect(probeProcessBirth(pid)).toBe(`linux-ticks:${starttime}`);
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
