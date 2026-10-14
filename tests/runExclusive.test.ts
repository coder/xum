import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const RUN_EXCLUSIVE = path.join(__dirname, "../scripts/lib/run_exclusive.js");

interface Result {
  code: number | null;
  stderr: string;
}

describe("run_exclusive", () => {
  let lockDir: string;
  const lockPath = () => path.join(lockDir, "xum-test-lock.lock");

  // Runs `node -e <script>` under the lock and resolves once it exits.
  const runLocked = (script: string): Promise<Result> =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [RUN_EXCLUSIVE, "test-lock", "--", process.execPath, "-e", script],
        { env: { ...process.env, XUM_LOCK_DIR: lockDir }, stdio: ["ignore", "ignore", "pipe"] }
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, stderr }));
    });

  beforeEach(() => {
    lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-exclusive-"));
  });

  afterEach(() => {
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  it("runs one holder at a time and releases the lock afterwards", async () => {
    const log = path.join(lockDir, "log");
    const script = (id: string) =>
      `const fs = require("fs");` +
      `fs.appendFileSync(${JSON.stringify(log)}, "start ${id}\\n");` +
      `setTimeout(() => fs.appendFileSync(${JSON.stringify(log)}, "end ${id}\\n"), 400);`;

    const results = await Promise.all([runLocked(script("a")), runLocked(script("b"))]);

    expect(results.map((result) => result.code)).toEqual([0, 0]);
    const events = fs.readFileSync(log, "utf8").trim().split("\n");
    // Whoever starts first must end before the other starts.
    expect(events[1]).toBe(events[0].replace("start", "end"));
    expect(results.some((result) => result.stderr.includes("Waiting for pid"))).toBe(true);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("passes the command's exit code through and still releases the lock", async () => {
    const result = await runLocked("process.exit(3)");

    expect(result.code).toBe(3);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("reclaims a lock whose holder has died", async () => {
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    fs.mkdirSync(lockPath());
    fs.writeFileSync(path.join(lockPath(), "owner.json"), JSON.stringify({ pid: deadPid }));

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
    fs.mkdirSync(lockPath());
    fs.writeFileSync(path.join(lockPath(), "owner.json"), JSON.stringify({ pid: process.pid }));
    setTimeout(() => fs.rmSync(lockPath(), { recursive: true, force: true }), 800);

    const started = Date.now();
    const result = await runLocked("");

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(`Waiting for pid ${process.pid}`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(700);
  });
});
