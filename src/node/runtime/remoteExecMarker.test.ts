import { describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  buildMarkerKillScript,
  createExecMarker,
  NO_PROC_MESSAGE,
  withExecMarker,
  withoutExecMarkerKey,
} from "./remoteExecMarker";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Pids of the processes whose environment holds exactly `marker` (Linux /proc). */
function markedPids(marker: string): number[] {
  const out = spawnSync("sh", ["-c", `grep -lzxF '${marker}' /proc/[0-9]*/environ 2>/dev/null`], {
    encoding: "utf-8",
  }).stdout;
  return out
    .split("\n")
    .filter(Boolean)
    .map((file) => Number(file.split("/")[2]))
    .filter((pid) => pid !== process.pid);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

describe("remoteExecMarker", () => {
  it("creates a fresh, well-formed marker per exec", () => {
    const a = createExecMarker();
    const b = createExecMarker();
    expect(a).toMatch(/^XUM_EXEC_ID=[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  it("refuses text that is not a marker before it can reach a shell", () => {
    const injected = "XUM_EXEC_ID=x'; rm -rf / #" as ReturnType<typeof createExecMarker>;
    expect(() => buildMarkerKillScript(injected)).toThrow("Invalid exec marker");
    expect(() => withExecMarker(injected, "true")).toThrow("Invalid exec marker");
  });

  // The env prefix must change nothing a caller sees (#6923).
  it("a marked command keeps its stdout, stderr and exit code", () => {
    const command = "sh -c 'echo out; echo err >&2; exit 7'";
    const plain = spawnSync("sh", ["-c", command], { encoding: "utf-8" });
    const marked = spawnSync("sh", ["-c", withExecMarker(createExecMarker(), command)], {
      encoding: "utf-8",
    });
    expect([marked.stdout, marked.stderr, marked.status]).toEqual([
      plain.stdout,
      plain.stderr,
      plain.status,
    ]);
    expect([marked.stdout, marked.stderr, marked.status]).toEqual(["out\n", "err\n", 7]);
  });

  it.skipIf(process.platform !== "linux")(
    "stops every process of the marked exec and no process of another exec",
    async () => {
      const target = createExecMarker();
      const other = createExecMarker();
      // Two steps: killing only the first sleep would let the shell start the second.
      const targetShell = spawn(
        "sh",
        ["-c", withExecMarker(target, "sh -c 'sleep 30; sleep 30'")],
        { stdio: "ignore", detached: true }
      );
      const otherShell = spawn("sh", ["-c", withExecMarker(other, "sleep 30")], {
        stdio: "ignore",
        detached: true,
      });
      try {
        expect(await waitFor(() => markedPids(target).length >= 2, 3_000)).toBe(true);
        expect(await waitFor(() => markedPids(other).length >= 1, 3_000)).toBe(true);
        const targetPids = markedPids(target);

        const kill = spawnSync("sh", ["-c", buildMarkerKillScript(target)], { encoding: "utf-8" });
        expect(kill.status).toBe(0);

        expect(await waitFor(() => targetPids.every((pid) => !alive(pid)), 3_000)).toBe(true);
        expect(markedPids(target)).toEqual([]);
        expect(markedPids(other).length).toBeGreaterThan(0);
      } finally {
        for (const child of [targetShell, otherShell]) {
          if (child.pid !== undefined) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              // Already gone.
            }
          }
        }
        spawnSync("sh", ["-c", buildMarkerKillScript(other)]);
      }
    }
  );

  // An abort right after exec returned can run the stop before the command is visible.
  it.skipIf(process.platform !== "linux")(
    "stops a marked command that starts shortly after the stop began",
    async () => {
      const marker = createExecMarker();
      const kill = spawn("sh", ["-c", buildMarkerKillScript(marker)], { stdio: "ignore" });
      const killed = new Promise<number | null>((resolve) => kill.on("exit", resolve));
      await new Promise((resolve) => setTimeout(resolve, 400));
      const late = spawn("sh", ["-c", withExecMarker(marker, "sleep 30")], {
        stdio: "ignore",
        detached: true,
      });
      try {
        expect(await killed).toBe(0);
        expect(await waitFor(() => markedPids(marker).length === 0, 3_000)).toBe(true);
      } finally {
        if (late.pid !== undefined) {
          try {
            process.kill(-late.pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
    }
  );

  it("drops a caller's value for the reserved marker key", () => {
    expect(withoutExecMarkerKey({ XUM_EXEC_ID: "spoofed", OTHER: "kept" })).toEqual({
      OTHER: "kept",
    });
  });

  it("exits 0 with a message when the host has no /proc", () => {
    const script = buildMarkerKillScript(createExecMarker()).replace(
      "[ ! -d /proc/self ]",
      "[ ! -d /proc/self/no-such-dir ]"
    );
    const result = spawnSync("sh", ["-c", script], { encoding: "utf-8" });
    expect(result.status).toBe(0);
    expect(result.stderr.trim()).toBe(NO_PROC_MESSAGE);
  });
});
