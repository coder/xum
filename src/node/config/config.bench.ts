/**
 * Config load cost with a large synthetic config.json (50 projects x 90 workspaces).
 * Run: make bench BENCH=config
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { bench, summary } from "mitata";
import type { Workspace } from "@/common/types/project";
import { Config } from "@/node/config";
import { DisposableTempDir } from "@/node/services/tempDir";

const PROJECT_COUNT = 50;
const WORKSPACES_PER_PROJECT = 90;

const tempDir = new DisposableTempDir("xum-bench-config");
process.on("exit", () => tempDir[Symbol.dispose]());
const root = tempDir.path;

function makeWorkspace(project: number, index: number): Workspace {
  const id = `p${project}-ws${index}`;
  const workspace: Workspace = {
    id,
    name: `feature-${index}`,
    title: `Implement feature ${index} for project ${project}`,
    path: path.join(root, "src", `project-${project}`, `feature-${index}`),
    createdAt: "2026-09-01T12:00:00.000Z",
    runtimeConfig: { type: "worktree", srcBaseDir: path.join(root, "src") },
    aiSettings: { model: "anthropic:claude-opus-5-5", thinkingLevel: "high" },
  };
  // Two of every three workspaces are sub-agent tasks under an earlier workspace.
  if (index % 3 !== 0) {
    workspace.parentWorkspaceId = `p${project}-ws${index - (index % 3)}`;
    workspace.agentId = "exec";
    workspace.taskStatus = "reported";
    workspace.taskModelString = "anthropic:claude-opus-5-5";
    workspace.taskPrompt = `Task ${index}: implement the change described in the plan and run the tests.`;
  }
  if (index % 5 === 0) workspace.archivedAt = "2026-09-15T12:00:00.000Z";
  return workspace;
}

// Saved through the public editConfig path so the file is in its canonical, already-migrated
// form: loads then never schedule a migration write while the benchmark runs.
async function writeConfig(): Promise<void> {
  await new Config(root).editConfig((config) => {
    for (let p = 0; p < PROJECT_COUNT; p++) {
      const workspaces: Workspace[] = [];
      for (let i = 0; i < WORKSPACES_PER_PROJECT; i++) workspaces.push(makeWorkspace(p, i));
      config.projects.set(path.join(root, "projects", `project-${p}`), { workspaces });
    }
    return config;
  });
}

function configStatKey(): string {
  const stat = fs.statSync(path.join(root, "config.json"));
  return `${stat.mtimeMs}:${stat.size}`;
}

summary(() => {
  // A fresh Config has no snapshot: every call reads, parses and normalizes config.json.
  bench("loadConfigOrDefault (fresh Config, 4500 workspaces)", async function* () {
    await writeConfig();
    const before = configStatKey();
    yield () => new Config(root).loadConfigOrDefault();
    if (configStatKey() !== before) throw new Error("config.json changed during the benchmark");
  });

  // The same instance returns its snapshot while config.json's stat key is unchanged.
  bench("loadConfigOrDefault (snapshot hit)", async function* () {
    await writeConfig();
    const config = new Config(root);
    config.loadConfigOrDefault();
    yield () => config.loadConfigOrDefault();
  });
});
