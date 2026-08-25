import { mkdtemp, rm, writeFile } from "fs/promises";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

import { GIT_FETCH_SCRIPT } from "./gitStatus";

describe("GIT_FETCH_SCRIPT", () => {
  test("fetches when remote ref moves to a commit already present locally", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mux-git-fetch-"));
    const originDir = path.join(tempDir, "origin.git");
    const workspaceDir = path.join(tempDir, "workspace");

    const run = (cmd: string, cwd?: string) =>
      execSync(cmd, { cwd, stdio: "pipe" }).toString().trim();

    try {
      // Initialize bare remote and clone it
      run(`git init --bare ${originDir}`);
      run(`git clone ${originDir} ${workspaceDir}`);

      // Basic git identity configuration
      run('git config user.email "test@example.com"', workspaceDir);
      run('git config user.name "Test User"', workspaceDir);
      run("git config commit.gpgsign false", workspaceDir);

      // Seed main with an initial commit
      await writeFile(path.join(workspaceDir, "README.md"), "init\n");
      run("git add README.md", workspaceDir);
      run('git commit -m "init"', workspaceDir);
      run("git branch -M main", workspaceDir);
      run("git push -u origin main", workspaceDir);

      // Ensure remote HEAD points to main for deterministic primary branch detection
      run("git symbolic-ref HEAD refs/heads/main", originDir);

      // Create a commit on a feature branch (object exists locally)
      run("git checkout -b feature", workspaceDir);
      await writeFile(path.join(workspaceDir, "feature.txt"), "feature\n");
      run("git add feature.txt", workspaceDir);
      run('git commit -m "feature"', workspaceDir);
      const featureSha = run("git rev-parse feature", workspaceDir);

      // Push the feature branch so the remote has the object but main stays old
      run("git push origin feature", workspaceDir);

      // Move remote main to the feature commit without updating local tracking ref
      run(`git update-ref refs/heads/main ${featureSha}`, originDir);

      const localBefore = run("git rev-parse origin/main", workspaceDir);
      expect(localBefore).not.toBe(featureSha);

      // Run the optimized fetch script (should update origin/main)
      run(GIT_FETCH_SCRIPT, workspaceDir);

      const localAfter = run("git rev-parse origin/main", workspaceDir);
      expect(localAfter).toBe(featureSha);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 20000);

  test("heals a repo poisoned into a promisor partial clone even when up to date", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mux-git-heal-"));
    const originDir = path.join(tempDir, "origin.git");
    const seedDir = path.join(tempDir, "seed");
    const workspaceDir = path.join(tempDir, "workspace");

    const run = (cmd: string, cwd?: string) =>
      execSync(cmd, { cwd, stdio: "pipe" }).toString().trim();
    const configureIdentity = (cwd: string) => {
      run('git config user.email "test@example.com"', cwd);
      run('git config user.name "Test User"', cwd);
      run("git config commit.gpgsign false", cwd);
    };

    try {
      run(`git init --bare ${originDir}`);
      // Local-path remotes reject --filter unless the server side opts in.
      run(`git -C ${originDir} config uploadpack.allowFilter true`);

      // Seed main via a separate clone so the workspace clone below stays
      // unaware of later blobs.
      run(`git clone ${originDir} ${seedDir}`);
      configureIdentity(seedDir);
      await writeFile(path.join(seedDir, "README.md"), "init\n");
      run("git add README.md", seedDir);
      run('git commit -m "init"', seedDir);
      run("git branch -M main", seedDir);
      run("git push -u origin main", seedDir);
      run("git symbolic-ref HEAD refs/heads/main", originDir);

      // Full (healthy) clone of the workspace.
      run(`git clone ${originDir} ${workspaceDir}`);
      configureIdentity(workspaceDir);

      // Advance origin/main with a commit whose blob the workspace lacks.
      await writeFile(path.join(seedDir, "data.txt"), "poisoned blob content\n");
      run("git add data.txt", seedDir);
      run('git commit -m "add data"', seedDir);
      run("git push origin main", seedDir);

      // Reproduce the poisoning done by previous versions of the script: a
      // single filtered fetch persists promisor config and skips the new blob.
      run("git fetch origin --filter=blob:none", workspaceDir);
      expect(run("git config --local --get remote.origin.partialclonefilter", workspaceDir)).toBe(
        "blob:none"
      );
      // rev-list reports missing objects without lazy-fetching them.
      const missingBefore = run(
        "git rev-list --objects --missing=print origin/main | grep -c '^?' || true",
        workspaceDir
      );
      expect(Number(missingBefore)).toBeGreaterThan(0);

      // The filtered fetch already updated the tracking ref, so the script's
      // LOCAL_SHA/REMOTE_SHA early-exit is hit: the heal must run before it.
      const script = GIT_FETCH_SCRIPT;
      const output = run(script, workspaceDir);
      expect(output).toContain("HEAL: backfilling promisor partial clone");

      // Promisor config removed and previously missing blobs backfilled.
      expect(
        run("git config --local --get remote.origin.partialclonefilter || echo GONE", workspaceDir)
      ).toBe("GONE");
      expect(
        run("git config --local --get remote.origin.promisor || echo GONE", workspaceDir)
      ).toBe("GONE");
      const missingAfter = run(
        "git rev-list --objects --missing=print origin/main | grep -c '^?' || true",
        workspaceDir
      );
      expect(Number(missingAfter)).toBe(0);

      // Heal is one-shot: a second run must skip without re-fetching.
      const secondOutput = run(script, workspaceDir);
      expect(secondOutput).not.toContain("HEAL:");
      expect(secondOutput).toContain("SKIP: Remote SHA already fetched");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 20000);
});
