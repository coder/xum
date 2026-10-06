/**
 * Config reads, edits and metadata builds at live-shaped sizes. Run: make bench BENCH=config
 *
 * The fixture is synthetic, shaped like a large real config (about 1.66 KB per workspace on disk,
 * 19 projects, 57% archived, 54% sub-agent tasks under earlier root rows, 99% worktree runtime,
 * 76% of checkout paths missing, one non-ASCII character per ~23 KB). Never point it at real data.
 * Every row uses the public Config API so `make bench-compare` can run it on base and head.
 * Keep helpers in this file: bench-compare resolves imports from each side's own tree.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { bench, do_not_optimize } from "mitata";
import type { ProjectConfig, Workspace } from "@/common/types/project";
import { Config } from "@/node/config";
import { DisposableTempDir } from "@/node/services/tempDir";

/** 4,712 is the live-shaped size; the others show how each row scales. */
const SIZES = [50, 500, 5000, 4712];
const PROJECT_COUNT = 19;

/** mitata passes this to generator benchmarks; get() returns the current .args() value. */
interface BenchState {
  get(name: string): unknown;
}

const tempDir = new DisposableTempDir("xum-bench-config-scale");
process.on("exit", () => tempDir[Symbol.dispose]());

const TASK_PROMPT =
  "Implement the change described in the plan, keep the diff minimal, run the targeted tests " +
  "and the static checks, then report the result with the commit and the validation you ran. ";

/** Deterministic spread of `percent`% over row indexes without long runs. */
function spread(index: number, salt: number, percent: number): boolean {
  return (index * salt + salt) % 100 < percent;
}

function makeProjects(root: string, count: number): Map<string, ProjectConfig> {
  const projects = new Map<string, ProjectConfig>();
  const projectPaths: string[] = [];
  for (let p = 0; p < PROJECT_COUNT; p++) {
    const projectPath = path.join(root, "projects", `project-${p}`);
    projectPaths.push(projectPath);
    projects.set(projectPath, { workspaces: [] });
  }
  let lastRoot: { id: string; project: number } | undefined;
  let roots = 0;
  for (let i = 0; i < count; i++) {
    const isTask = lastRoot !== undefined && spread(i, 7, 54);
    const project = isTask ? lastRoot!.project : roots++ % PROJECT_COUNT;
    const id = `ws${i.toString(36).padStart(6, "0")}`;
    const name = `${isTask ? "task" : "feature"}-${i}`;
    const workspacePath = path.join(root, "src", `project-${project}`, name);
    const worktree = i % 100 !== 99;
    const workspace: Workspace = {
      id,
      name,
      // One non-ASCII character per ~14 rows (~23 KB of text).
      title: `${i % 14 === 0 ? "Café" : "Cafe"} feature ${i}: tighten the workspace sidebar flow`,
      path: workspacePath,
      createdAt: "2026-09-01T12:00:00.000Z",
      runtimeConfig: worktree
        ? { type: "worktree", srcBaseDir: path.join(root, "src") }
        : { type: "local" },
      aiSettings: { model: "anthropic:claude-opus-5-5", thinkingLevel: "high" },
      aiSettingsByAgent: {
        exec: { model: "anthropic:claude-opus-5-5", thinkingLevel: "high" },
        plan: { model: "anthropic:claude-opus-5-5", thinkingLevel: "high" },
        explore: { model: "anthropic:claude-sonnet-5-5", thinkingLevel: "medium" },
      },
    };
    if (isTask) {
      workspace.parentWorkspaceId = lastRoot!.id;
      workspace.agentId = "exec";
      workspace.agentType = "exec";
      workspace.taskStatus = "reported";
      workspace.reportedAt = "2026-09-01T13:00:00.000Z";
      workspace.taskModelString = "anthropic:claude-opus-5-5";
      workspace.taskThinkingLevel = "high";
      workspace.taskPrompt = `Task ${i}: ${TASK_PROMPT}${TASK_PROMPT}`;
      workspace.taskTrunkBranch = "main";
    } else {
      lastRoot = { id, project };
    }
    if (spread(i, 37, 57)) workspace.archivedAt = "2026-09-15T12:00:00.000Z";
    if (!spread(i, 53, 76)) fs.mkdirSync(workspacePath, { recursive: true });
    projects.get(projectPaths[project])!.workspaces.push(workspace);
  }
  return projects;
}

const fixtures = new Map<number, Promise<{ root: string; lastId: string }>>();

/**
 * One root per size, written once through editConfig so config.json is in its canonical,
 * already-migrated form: reads then never schedule a migration write while a row runs.
 */
function fixture(count: number): Promise<{ root: string; lastId: string }> {
  let entry = fixtures.get(count);
  if (entry === undefined) {
    entry = (async () => {
      const root = path.join(tempDir.path, `n${count}`);
      const projects = makeProjects(root, count);
      await new Config(root).editConfig((config) => {
        config.projects = projects;
        return config;
      });
      return { root, lastId: `ws${(count - 1).toString(36).padStart(6, "0")}` };
    })();
    fixtures.set(count, entry);
  }
  return entry;
}

function statKey(root: string): string {
  const stat = fs.statSync(path.join(root, "config.json"));
  return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
}

/** Registers a read-only row: it fails when config.json changes while it runs. */
function readRow(
  name: string,
  setup: (config: Config, lastId: string) => Promise<void> | void,
  run: (config: Config, lastId: string) => unknown
) {
  bench(`${name} ($workspaces)`, async function* (state: BenchState) {
    const f = await fixture(state.get("workspaces") as number);
    const config = new Config(f.root);
    await setup(config, f.lastId);
    const before = statKey(f.root);
    yield () => run(config, f.lastId);
    if (statKey(f.root) !== before) throw new Error(`${name}: config.json changed during the run`);
  }).args("workspaces", SIZES);
}

readRow(
  "loadConfigOrDefault, fresh Config",
  () => undefined,
  // A fresh instance has no snapshot: every call reads, decodes, parses and normalizes.
  (config) => do_not_optimize(new Config(config.rootDir).loadConfigOrDefault())
);
readRow(
  "loadConfigOrDefault, snapshot hit",
  (config) => void config.loadConfigOrDefault(),
  (config) => do_not_optimize(config.loadConfigOrDefault())
);
readRow(
  "findWorkspace(last id)",
  (config) => void config.loadConfigOrDefault(),
  (config, id) => do_not_optimize(config.findWorkspace(id))
);
readRow(
  "getAllWorkspaceMetadata, full build",
  () => undefined,
  (config) => config.getAllWorkspaceMetadata()
);
readRow(
  "getAllWorkspaceMetadata, last-known probes",
  async (config) => void (await config.getAllWorkspaceMetadata()),
  (config) => config.getAllWorkspaceMetadata({ probeCheckouts: "last-known" })
);
readRow(
  "getAllWorkspaceMetadata, registry memo",
  async (config) => void (await config.getAllWorkspaceMetadata({ probeCheckouts: false })),
  (config) => config.getAllWorkspaceMetadata({ probeCheckouts: false })
);
readRow(
  "getWorkspaceMetadataById(last id)",
  () => undefined,
  (config, id) => config.getWorkspaceMetadataById(id)
);

/** Same-value edit: the transform returns the config unchanged, so every round saves equal bytes. */
function sameValueEdit(config: Config): Promise<void> {
  return config.editConfig((snapshot) => snapshot);
}

bench("editConfig, same-value edit ($workspaces)", async function* (state: BenchState) {
  const f = await fixture(state.get("workspaces") as number);
  const config = new Config(f.root);
  config.loadConfigOrDefault();
  yield () => sameValueEdit(config);
})
  .args("workspaces", SIZES)
  .gc("inner");

bench("editConfig, then loadConfigOrDefault ($workspaces)", async function* (state: BenchState) {
  const f = await fixture(state.get("workspaces") as number);
  const config = new Config(f.root);
  config.loadConfigOrDefault();
  yield async () => {
    await sameValueEdit(config);
    return do_not_optimize(config.loadConfigOrDefault());
  };
})
  .args("workspaces", SIZES)
  .gc("inner");

bench(
  "editConfig, reader on every event-loop turn ($workspaces)",
  async function* (state: BenchState) {
    const f = await fixture(state.get("workspaces") as number);
    const config = new Config(f.root);
    config.loadConfigOrDefault();
    yield async () => {
      // A reader between every await of the edit, like the startup tombstone heal sweep.
      let reading = true;
      const read = () => {
        if (!reading) return;
        config.loadConfigOrDefault();
        setImmediate(read);
      };
      setImmediate(read);
      try {
        await sameValueEdit(config);
      } finally {
        reading = false;
      }
    };
  }
)
  .args("workspaces", SIZES)
  .gc("inner");
