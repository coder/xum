import { describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { agentCgroupEnrollmentLine } from "./agentCgroupEnrollment";

function runBash(script: string) {
  const result = spawnSync("bash", ["-c", script], { encoding: "utf-8" });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe.skipIf(process.platform === "win32")("agentCgroupEnrollmentLine", () => {
  it("writes the shell's PID to the target before the command and prints nothing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-enroll-"));
    try {
      const target = path.join(dir, "cgroup procs");

      const result = runBash(`${agentCgroupEnrollmentLine(target)}echo $$`);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/^\d+\n$/);
      expect(await fs.readFile(target, "utf-8")).toBe(result.stdout);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("runs the command with one warning line when the target cannot be written", () => {
    const result = runBash(
      `${agentCgroupEnrollmentLine("/nonexistent-xum-dir/cgroup.procs")}echo ran; exit 3`
    );

    expect(result).toEqual({
      stdout: "ran\n",
      stderr: "xum: could not apply the agent resource limit to this command\n",
      status: 3,
    });
  });
});
