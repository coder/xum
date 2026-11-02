import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DisposableTempDir } from "@/node/services/tempDir";

import { generateGitStatusScript } from "./gitStatus";

describe("generateGitStatusScript", () => {
  test("single-quotes preferred branch to prevent shell interpolation", () => {
    const script = generateGitStatusScript("origin/$(touch /tmp/pwned)\"'branch");

    expect(script).toContain("PREFERRED_BRANCH='$(touch /tmp/pwned)\"'\\''branch'");
    expect(script).not.toContain('PREFERRED_BRANCH="$(touch /tmp/pwned)');
  });

  test("uses the local primary ref for divergent local-only branches", async () => {
    using tmp = new DisposableTempDir("git-status-local-divergence");
    const repo = path.join(tmp.path, "repo");
    await fs.mkdir(repo, { recursive: true });
    await Bun.$`git init -b main`.cwd(repo).quiet();
    await Bun.$`git config user.email test@example.com`.cwd(repo).quiet();
    await Bun.$`git config user.name Test`.cwd(repo).quiet();
    await fs.writeFile(path.join(repo, "base.txt"), "base\n", "utf-8");
    await Bun.$`git add base.txt`.cwd(repo).quiet();
    await Bun.$`git commit -m base`.cwd(repo).quiet();
    await Bun.$`git checkout -b feature`.cwd(repo).quiet();
    await fs.writeFile(path.join(repo, "feature.txt"), "feature\n", "utf-8");
    await Bun.$`git add feature.txt`.cwd(repo).quiet();
    await Bun.$`git commit -m feature`.cwd(repo).quiet();
    await Bun.$`git checkout main`.cwd(repo).quiet();
    await fs.writeFile(path.join(repo, "main.txt"), "main\n", "utf-8");
    await Bun.$`git add main.txt`.cwd(repo).quiet();
    await Bun.$`git commit -m main`.cwd(repo).quiet();
    await Bun.$`git checkout feature`.cwd(repo).quiet();

    const result = await Bun.$`bash -c ${generateGitStatusScript()}`.cwd(repo).quiet();
    expect(result.stdout.toString()).toContain("---AHEAD_BEHIND---\n1\t1");
  });

  // #7626: a poll that rewrites the index holds .git/index.lock, and a commit at that moment fails.
  test("does not rewrite the index when a tracked file's stat info is stale", async () => {
    using tmp = new DisposableTempDir("git-status-no-index-lock");
    const repo = path.join(tmp.path, "repo");
    await fs.mkdir(repo, { recursive: true });
    await Bun.$`git init -b main`.cwd(repo).quiet();
    await Bun.$`git config user.email test@example.com`.cwd(repo).quiet();
    await Bun.$`git config user.name Test`.cwd(repo).quiet();
    await fs.writeFile(path.join(repo, "tracked.txt"), "same\n", "utf-8");
    await Bun.$`git add tracked.txt`.cwd(repo).quiet();
    await Bun.$`git commit -m base`.cwd(repo).quiet();
    // Same content, new mtime: a locking "git status" re-hashes it and writes the refreshed index.
    const stale = new Date("2001-01-01T00:00:00Z");
    await fs.utimes(path.join(repo, "tracked.txt"), stale, stale);
    const indexPath = path.join(repo, ".git", "index");
    const before = await fs.stat(indexPath);

    const result = await Bun.$`bash -c ${generateGitStatusScript()}`.cwd(repo).quiet();

    expect(result.stdout.toString()).toContain("---DIRTY---\n0");
    // Git writes a new index by renaming index.lock over it, so a write changes the inode.
    expect((await fs.stat(indexPath)).ino).toBe(before.ino);
  });
});
