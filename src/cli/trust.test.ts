import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";
import { DisposableTempDir } from "@/node/services/tempDir";
import { resolveProjectDir } from "./trust";

const BUN_EXECUTABLE = process.execPath;
const TRUST_ENTRY = path.join(import.meta.dir, "trust.ts");
const INDEX_ENTRY = path.join(import.meta.dir, "index.ts");

describe("xum trust CLI", () => {
  test("normalizes implicit cwd to git root but preserves explicit --dir", async () => {
    using tmp = new DisposableTempDir("trust-cli-dir");
    const repo = path.join(tmp.path, "repo");
    const nested = path.join(repo, "packages", "app");
    await fs.mkdir(nested, { recursive: true });
    await Bun.$`git init`.cwd(repo).quiet();

    expect(await resolveProjectDir({ cwd: nested })).toBe(repo);
    expect(await resolveProjectDir({ cwd: tmp.path, explicitDir: nested })).toBe(nested);
  });

  test("grants and revokes project trust headlessly", async () => {
    using tmp = new DisposableTempDir("trust-cli-cycle");
    const repo = path.join(tmp.path, "repo");
    const muxRoot = path.join(tmp.path, "mux-root");
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(muxRoot, { recursive: true });
    const env = { ...process.env, MUX_ROOT: muxRoot };

    // Grant trust for a project that was never added to mux (no desktop/server
    // involved). Route through index.ts to cover top-level subcommand dispatch;
    // no experiment flag is required for trust.
    const trustResult = await Bun.$`${BUN_EXECUTABLE} ${INDEX_ENTRY} trust --dir ${repo} --json`
      .env(env)
      .quiet();
    expect(trustResult.exitCode).toBe(0);
    expect(JSON.parse(trustResult.stdout.toString())).toEqual({
      projectPath: repo,
      trusted: true,
    });

    const revokeResult = await Bun.$`${BUN_EXECUTABLE} ${TRUST_ENTRY} --revoke --dir ${repo} --json`
      .env(env)
      .quiet();
    expect(revokeResult.exitCode).toBe(0);
    expect(JSON.parse(revokeResult.stdout.toString())).toEqual({
      projectPath: repo,
      trusted: false,
    });
  }, 15_000);

  test("revoke from a worktree also clears a direct trust entry for the worktree path", async () => {
    using tmp = new DisposableTempDir("trust-cli-worktree-revoke");
    const base = await fs.realpath(tmp.path);
    const repo = path.join(base, "repo");
    const muxRoot = path.join(base, "mux-root");
    const worktree = path.join(base, "worktree");
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(muxRoot, { recursive: true });
    await Bun.$`git init`.cwd(repo).quiet();
    await Bun.$`git config user.email dogfood@example.com`.cwd(repo).quiet();
    await Bun.$`git config user.name Dogfood`.cwd(repo).quiet();
    await fs.writeFile(path.join(repo, "README.md"), "hello\n", "utf-8");
    await Bun.$`git add README.md`.cwd(repo).quiet();
    await Bun.$`git commit -m init`.cwd(repo).quiet();
    await Bun.$`git worktree add ${worktree} -b feature`.cwd(repo).quiet();

    // Older/manual configs (or a worktree added as its own project) can hold a
    // direct trusted entry for the worktree path alongside the main repo entry.
    // Revoke must clear both; the direct entry alone would keep the checkout
    // trusted via resolveProjectTrusted's exact-path lookup.
    await fs.writeFile(
      path.join(muxRoot, "config.json"),
      JSON.stringify({
        projects: [
          [repo, { workspaces: [], trusted: true }],
          [worktree, { workspaces: [], trusted: true }],
        ],
      }),
      "utf-8"
    );
    const env = { ...process.env, MUX_ROOT: muxRoot };

    const revokeResult =
      await Bun.$`${BUN_EXECUTABLE} ${TRUST_ENTRY} --revoke --dir ${worktree} --json`
        .env(env)
        .quiet();
    expect(revokeResult.exitCode).toBe(0);

    const config = JSON.parse(await fs.readFile(path.join(muxRoot, "config.json"), "utf-8")) as {
      projects: Array<[string, { trusted?: boolean }]>;
    };
    const trustByPath = new Map(config.projects.map(([p, c]) => [p, c.trusted]));
    expect(trustByPath.get(repo)).toBe(false);
    expect(trustByPath.get(worktree)).toBe(false);
  }, 15_000);

  test("fails loudly when the trust change cannot be persisted", async () => {
    using tmp = new DisposableTempDir("trust-cli-unwritable");
    const repo = path.join(tmp.path, "repo");
    await fs.mkdir(repo, { recursive: true });
    // MUX_ROOT pointing at a regular file makes config.json unwritable;
    // Config.saveConfig swallows the write error, so only the post-write
    // verification can surface the failure.
    const muxRootFile = path.join(tmp.path, "mux-root-file");
    await fs.writeFile(muxRootFile, "not a directory\n", "utf-8");

    const result = await Bun.$`${BUN_EXECUTABLE} ${TRUST_ENTRY} --dir ${repo} --json`
      .env({ ...process.env, MUX_ROOT: muxRootFile })
      .nothrow()
      .quiet();

    expect(result.exitCode).not.toBe(0);
    // Either failure surface is acceptable: the corrupt-config write gate
    // (config.json exists but cannot be read, so editConfig refuses to write
    // defaults over it) or the post-write trust verification (the write was
    // silently swallowed). Both must fail loudly instead of reporting
    // success.
    expect(result.stderr.toString()).toMatch(
      /Failed to persist trust change|Skipping config write/
    );
    expect(result.stdout.toString()).toBe("");
  }, 15_000);

  test("trust from a linked worktree records trust for the main repository", async () => {
    using tmp = new DisposableTempDir("trust-cli-worktree");
    // realpath: git reports physical paths (macOS /var -> /private/var) and the trust
    // entry written to config must match what trust resolution compares against.
    const base = await fs.realpath(tmp.path);
    const repo = path.join(base, "repo");
    const muxRoot = path.join(base, "mux-root");
    const worktree = path.join(base, "worktree");
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(muxRoot, { recursive: true });
    await Bun.$`git init`.cwd(repo).quiet();
    await Bun.$`git config user.email dogfood@example.com`.cwd(repo).quiet();
    await Bun.$`git config user.name Dogfood`.cwd(repo).quiet();
    await fs.writeFile(path.join(repo, "README.md"), "hello\n", "utf-8");
    await Bun.$`git add README.md`.cwd(repo).quiet();
    await Bun.$`git commit -m init`.cwd(repo).quiet();
    await Bun.$`git worktree add ${worktree} -b feature`.cwd(repo).quiet();

    const trustResult = await Bun.$`${BUN_EXECUTABLE} ${TRUST_ENTRY} --dir ${worktree} --json`
      .env({ ...process.env, MUX_ROOT: muxRoot })
      .quiet();
    expect(trustResult.exitCode).toBe(0);
    // Trust must land on the main repository path, not the ephemeral worktree path.
    expect(JSON.parse(trustResult.stdout.toString())).toEqual({
      projectPath: repo,
      trusted: true,
    });
  }, 15_000);
});
