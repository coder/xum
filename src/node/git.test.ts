import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { listLocalBranches, cleanStaleLock } from "./git";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import { exec } from "child_process";
import { promisify } from "util";

// eslint-disable-next-line local/no-unsafe-child-process -- Test file needs direct exec access for setup
const execAsync = promisify(exec);

describe("listLocalBranches", () => {
  let tempGitRepo: string;

  beforeAll(async () => {
    // Create a temporary git repository for testing
    tempGitRepo = await fs.mkdtemp(path.join(os.tmpdir(), "mux-git-test-"));
    await execAsync(`git init`, { cwd: tempGitRepo });
    await execAsync(`git config user.email "test@example.com"`, { cwd: tempGitRepo });
    await execAsync(`git config user.name "Test User"`, { cwd: tempGitRepo });
    await execAsync(`git config commit.gpgsign false`, { cwd: tempGitRepo });
    await execAsync(`echo "test" > README.md`, { cwd: tempGitRepo });
    await execAsync(`git add .`, { cwd: tempGitRepo });
    await execAsync(`git commit -m "Initial commit"`, { cwd: tempGitRepo });
  });

  afterAll(async () => {
    // Cleanup temp repo
    try {
      await fs.rm(tempGitRepo, { recursive: true, force: true });
    } catch (error) {
      console.warn("Failed to cleanup temp git repo:", error);
    }
  });

  test("listLocalBranches should return sorted branch names", async () => {
    const uniqueSuffix = Date.now().toString(36);
    const newBranches = [`zz-${uniqueSuffix}`, `aa-${uniqueSuffix}`, `mid/${uniqueSuffix}`];

    for (const branch of newBranches) {
      await execAsync(`git branch ${branch}`, { cwd: tempGitRepo });
    }

    const branches = await listLocalBranches(tempGitRepo);

    for (const branch of newBranches) {
      expect(branches).toContain(branch);
    }

    for (let i = 1; i < branches.length; i += 1) {
      expect(branches[i - 1].localeCompare(branches[i])).toBeLessThanOrEqual(0);
    }
  });
});

describe("cleanStaleLock", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-lock-test-"));
    await fs.mkdir(path.join(tempDir, ".git"));
  });

  afterAll(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test("removes lock file older than threshold", async () => {
    const lockPath = path.join(tempDir, ".git", "index.lock");
    // Create a lock file with old mtime
    await fs.writeFile(lockPath, "lock");
    const oldTime = Date.now() - 10000; // 10 seconds ago
    fsSync.utimesSync(lockPath, oldTime / 1000, oldTime / 1000);

    cleanStaleLock(tempDir);

    // Lock should be removed
    expect(fsSync.existsSync(lockPath)).toBe(false);
  });

  test("does not remove recent lock file", async () => {
    const lockPath = path.join(tempDir, ".git", "index.lock");
    // Create a fresh lock file (now)
    await fs.writeFile(lockPath, "lock");

    cleanStaleLock(tempDir);

    // Lock should still exist (it's too recent)
    expect(fsSync.existsSync(lockPath)).toBe(true);

    // Cleanup
    await fs.unlink(lockPath);
  });

  test("does nothing when no lock exists", () => {
    // Should not throw
    cleanStaleLock(tempDir);
  });
});
