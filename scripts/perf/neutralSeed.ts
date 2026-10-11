/**
 * Neutral seed for the page-timing harness (T3 #5971, plan section 2.2), written from data alone. It imports
 * only `node:` modules and launches no app, so neither measured build can shape it (PR9a #6097 seeded with a
 * head-only setup launch). The config carries every load-time migration flag: add new flags here.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const SEED_WORKSPACE_ID = "a1b2c3d4e5"; // fixed: same URL and same bytes on every run
const DATE = "2026-01-01T00:00:00Z";

/** Writes `<outDir>/{root,home,demo-app}`. Refuses an existing outDir so a stale seed is never reused. */
export function writeNeutralSeed(outDir: string) {
  assert(
    path.isAbsolute(outDir) && !fs.existsSync(outDir),
    `need a new absolute outDir: ${outDir}`
  );
  const [root, home, project] = ["root", "home", "demo-app"].map((d) => path.join(outDir, d));
  const sessionDir = path.join(root, "sessions", SEED_WORKSPACE_ID);
  for (const dir of [home, path.join(project, "src"), sessionDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(project, "src/math.ts"),
    "export const add = (a: number, b: number) => a + b;\n"
  );
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_DATE: DATE,
    GIT_COMMITTER_DATE: DATE,
  };
  for (const args of ["init -q -b main", "add .", "commit -qm init"].map((a) => a.split(" "))) {
    const id = ["-c", "user.name=Seed", "-c", "user.email=seed@example.test"];
    const run = spawnSync("git", [...id, ...args], { cwd: project, env });
    assert(run.status === 0, `git ${args.join(" ")} failed: ${String(run.stderr)}`);
  }
  const workspace = {
    path: project,
    id: SEED_WORKSPACE_ID,
    name: "seed",
    createdAt: DATE,
    runtimeConfig: { type: "local" },
    remotePlanMigrated: true,
  };
  const tutorialState = {
    disabled: true,
    completed: { creation: true, workspace: true, review: true },
  };
  const config = {
    projects: [[project, { trusted: true, workspaces: [workspace] }]],
    migrations: {
      persistentSubagentsDefaulted: true,
      agentHeartbeatsSeeded: true,
      defaultModelFallbacksSeeded: true,
      defaultModelFallbacksSeededFable51: true,
    },
    taskSettings: { preserveSubagentsUntilArchive: true },
    viewedSplashScreens: ["onboarding-wizard-v1"],
    userPreferences: { ui: { tutorialState } },
    // Pinned: with no routePriority, a load derives one from any gateway credential in the env.
    routePriority: ["direct"],
  };
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  // 4 rows: user, assistant with a fenced ts block (P2's target line), user, assistant with a list.
  const chat = new URL("./fixtures/neutralSeed/chat.jsonl", import.meta.url);
  fs.copyFileSync(chat, path.join(sessionDir, "chat.jsonl"));
  fs.writeFileSync(path.join(sessionDir, "session-usage.json"), '{"byModel":{},"version":1}\n');
  return { workspaceId: SEED_WORKSPACE_ID, root, home, project };
}

/** Every file under dir by relative path, as raw bytes. `.git/` is skipped: git may rewrite its index. */
export function snapshotSeed(dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  // An explicit walk: readdirSync's `recursive` option needs Node 20.1 and Dirent.parentPath 20.12, while
  // the repo admits any Node 20. A walk that silently skips files would let every check pass.
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory() && entry.name !== ".git") walk(child);
      if (entry.isFile()) files.set(child, fs.readFileSync(path.join(dir, child)));
    }
  };
  walk("");
  return files;
}

/** Pure byte comparison of a snapshot with the seed dir now. A run fails on any changed or missing file. */
export function diffSeed(before: Map<string, Buffer>, dir: string) {
  const after = snapshotSeed(dir);
  const changed = [...before.keys()].filter(
    (rel) => after.has(rel) && !before.get(rel)!.equals(after.get(rel)!)
  );
  const missing = [...before.keys()].filter((rel) => !after.has(rel));
  const added = [...after.keys()].filter((rel) => !before.has(rel)); // server.lock, logs: allowed, logged
  return { changed, missing, added, ok: changed.length + missing.length === 0 };
}
