import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "fs/promises";
import { hostProcessGroupIsLive } from "./hostProcessGroup";

// A process group nobody has: the PID of a process that already exited (and was reaped).
function deadGroupId(): number {
  const pid = spawnSync("true").pid;
  if (pid == null || pid <= 1) throw new Error("no pid");
  return pid;
}

describe.skipIf(process.platform !== "linux")("hostProcessGroupIsLive", () => {
  afterEach(() => {
    mock.restore();
  });

  it("is gone on ESRCH and live for this test's own group", async () => {
    expect(await hostProcessGroupIsLive(deadGroupId())).toBe(false);
    const ownGroup = Number((await fs.readFile("/proc/self/stat", "utf-8")).split(") ")[1].split(" ")[2]);
    expect(await hostProcessGroupIsLive(ownGroup)).toBe(true);
  });

  // A group that answers kill(-pgid, 0) but shows no non-zombie member in /proc: all zombies,
  // or members /proc does not show this user.
  async function liveByKillOnly(readFile: (path: string) => Promise<string> | undefined) {
    const pgid = deadGroupId();
    spyOn(process, "kill").mockImplementation(() => true);
    const realReadFile = fs.readFile.bind(fs);
    spyOn(fs, "readFile").mockImplementation(((path: string, options: unknown) => {
      return readFile(path) ?? realReadFile(path, options as "utf-8");
    }) as typeof fs.readFile);
    return hostProcessGroupIsLive(pgid);
  }

  it("treats a group without a visible non-zombie member as gone", async () => {
    expect(await liveByKillOnly(() => undefined)).toBe(false);
  });

  it("fails closed when /proc hides other users' processes", async () => {
    const hidden = "25 30 0:23 / /proc rw,nosuid shared:13 - proc proc rw,hidepid=invisible\n";
    expect(
      await liveByKillOnly((path) =>
        path === "/proc/self/mountinfo" ? Promise.resolve(hidden) : undefined
      )
    ).toBe(true);
  });

  it("fails closed when a /proc entry exists but cannot be read", async () => {
    const denied = Object.assign(new Error("EACCES"), { code: "EACCES" });
    expect(
      await liveByKillOnly((path) =>
        path.endsWith("/stat") && path !== "/proc/self/stat" ? Promise.reject(denied) : undefined
      )
    ).toBe(true);
  });
});
