import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const RUN_EXCLUSIVE = path.join(__dirname, "../scripts/lib/run_exclusive.js");

// Local shape for the untyped CommonJS helper; only the members these tests exercise.
interface RunExclusiveModule {
  lockPathFor(name: string, env: Record<string, string | undefined>): string;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- plain CommonJS script helper with no ESM entry
const runExclusive = require("../scripts/lib/run_exclusive.js") as RunExclusiveModule;

// Unreadable directories do not stop root, so the permission test cannot run as root.
const itUnlessRoot = process.platform === "win32" || process.getuid?.() === 0 ? it.skip : it;

interface Result {
  code: number | null;
  stderr: string;
}

const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

describe("run_exclusive", () => {
  let lockDir: string;
  const lockPath = () => runExclusive.lockPathFor("test-lock", { XUM_LOCK_DIR: lockDir });
  const writeLock = (owner: object) => {
    fs.mkdirSync(lockPath());
    fs.writeFileSync(path.join(lockPath(), "owner.json"), JSON.stringify(owner));
  };

  // Runs `node -e <script>` under the lock. `onWaiting` fires once, when the wrapper reports that
  // it is blocked on the lock, so tests release locks on that signal instead of after a delay.
  const runLocked = (script: string, onWaiting?: () => void): Promise<Result> =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [RUN_EXCLUSIVE, "test-lock", "--", process.execPath, "-e", script],
        { env: { ...process.env, XUM_LOCK_DIR: lockDir }, stdio: ["ignore", "ignore", "pipe"] }
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        const before = stderr;
        stderr += chunk.toString();
        if (!before.includes("Waiting for") && stderr.includes("Waiting for")) {
          onWaiting?.();
        }
      });
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, stderr }));
    });

  beforeEach(() => {
    lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-exclusive-"));
  });

  afterEach(() => {
    fs.chmodSync(lockDir, 0o755); // In case a permission test failed before restoring it.
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  it("runs one holder at a time and releases the lock afterwards", async () => {
    const log = path.join(lockDir, "log");
    const gate = path.join(lockDir, "gate");
    // Each holder stays inside the lock until the gate opens, and the gate opens only once the
    // other run reports that it is waiting, so the runs must have overlapped in time.
    const script = (id: string) =>
      `const fs = require("fs");` +
      `fs.appendFileSync(${JSON.stringify(log)}, "start ${id}\\n");` +
      `const poll = setInterval(() => {` +
      `  if (!fs.existsSync(${JSON.stringify(gate)})) return;` +
      `  clearInterval(poll);` +
      `  fs.appendFileSync(${JSON.stringify(log)}, "end ${id}\\n");` +
      `}, 20);`;
    const openGate = () => fs.writeFileSync(gate, "");

    const results = await Promise.all([
      runLocked(script("a"), openGate),
      runLocked(script("b"), openGate),
    ]);

    expect(results.map((result) => result.code)).toEqual([0, 0]);
    const [firstStart, firstEnd, secondStart, secondEnd] = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n");
    expect(firstEnd).toBe(firstStart.replace("start", "end"));
    expect(secondEnd).toBe(secondStart.replace("start", "end"));
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("passes the command's exit code through and still releases the lock", async () => {
    const result = await runLocked("process.exit(3)");

    expect(result.code).toBe(3);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("reclaims a lock whose holder has died", async () => {
    writeLock({ pid: deadPid() });

    const result = await runLocked("");

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("Waiting");
  });

  it("reclaims an old lock that never got an owner", async () => {
    fs.mkdirSync(lockPath());
    const minuteAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath(), minuteAgo, minuteAgo);

    const result = await runLocked("");

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("Waiting");
  });

  it("waits for a live holder instead of reclaiming its lock", async () => {
    writeLock({ pid: process.pid });

    const result = await runLocked("", () => fs.rmSync(lockPath(), { recursive: true }));

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(`Waiting for pid ${process.pid}`);
  });

  it("waits while the locked command outlives its killed wrapper", async () => {
    // The wrapper died (e.g. SIGKILL) but its lint is still running.
    const wrapperPid = deadPid();
    writeLock({ pid: wrapperPid, childPid: process.pid });

    const result = await runLocked("", () => fs.rmSync(lockPath(), { recursive: true }));

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(`Waiting for pid ${wrapperPid}`);
  });

  itUnlessRoot("waits on a stale lock it cannot remove instead of spinning", async () => {
    const stalePid = deadPid();
    writeLock({ pid: stalePid });
    // Without write access to the parent, the stale lock cannot be moved aside, as with another
    // user's lock under the sticky /tmp.
    fs.chmodSync(lockDir, 0o555);

    const result = await runLocked("", () => {
      fs.chmodSync(lockDir, 0o755);
      fs.rmSync(lockPath(), { recursive: true });
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(`Waiting for pid ${stalePid}`);
  });
});
