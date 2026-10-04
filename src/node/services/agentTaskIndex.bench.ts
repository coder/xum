/**
 * Example microbenchmark (docs/reference/code-benchmarks.mdx). Run: make bench BENCH=agentTaskIndex
 *
 * A bench file only registers benchmarks; scripts/perf/bench.ts runs and reports them.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { bench, do_not_optimize, summary } from "mitata";
import type { ProjectConfig, ProjectsConfig, Workspace } from "@/common/types/project";
import { buildAgentTaskIndex } from "@/node/services/agentTaskIndex";
import { DisposableTempDir } from "@/node/services/tempDir";

const PROJECT_COUNT = 8;

/** mitata passes this to generator benchmarks; get() returns the current .args() value. */
interface BenchState {
  get(name: string): unknown;
}

/** Synthetic config: a third of the workspaces are roots, the rest are task trees under them. */
function makeConfig(workspaceCount: number): ProjectsConfig {
  const projects = new Map<string, ProjectConfig>();
  for (let p = 0; p < PROJECT_COUNT; p++) {
    projects.set(`/home/user/project-${p}`, { workspaces: [] });
  }
  const projectList = [...projects.values()];
  for (let i = 0; i < workspaceCount; i++) {
    const project = projectList[i % PROJECT_COUNT];
    const workspace: Workspace = {
      id: `ws-${i}`,
      name: `branch-${i}`,
      path: `/home/user/.xum/src/project-${i % PROJECT_COUNT}/branch-${i}`,
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    // Parent is an earlier workspace of the same project, so trees are 1-3 levels deep.
    if (i % 3 !== 0) {
      workspace.parentWorkspaceId = `ws-${i - PROJECT_COUNT}`;
      workspace.agentType = "exec";
      workspace.taskStatus = "reported";
    }
    project.workspaces.push(workspace);
  }
  return { projects };
}

// Cleaned up at exit: a top-level `using` would dispose before the runner starts the benchmarks.
const tempDir = new DisposableTempDir("xum-bench-agent-task-index");
process.on("exit", () => tempDir[Symbol.dispose]());

summary(() => {
  // (1) The generator form keeps setup out of the timing: only the yielded function is measured.
  // (2) .args() runs the benchmark once per size; state.get() reads the current value.
  // (4) .gc("inner") collects garbage before every iteration, so the heap column (bytes allocated
  //     per iteration) and the gc column are stable. Node runs with --expose-gc for this.
  bench("buildAgentTaskIndex($workspaces)", function* (state: BenchState) {
    const config = makeConfig(state.get("workspaces") as number);
    yield () => do_not_optimize(buildAgentTaskIndex(config));
  })
    .args("workspaces", [1000, 5000])
    .gc("inner");
});

// (3) Async benchmarks: an async generator can await in setup, and mitata awaits the promise the
//     yielded function returns.
bench("read + parse + index config($workspaces)", async function* (state: BenchState) {
  const workspaces = state.get("workspaces") as number;
  const configPath = path.join(tempDir.path, `config-${workspaces}.json`);
  await fs.writeFile(configPath, JSON.stringify([...makeConfig(workspaces).projects]));
  yield async () => {
    const entries = JSON.parse(await fs.readFile(configPath, "utf8")) as Array<
      [string, ProjectConfig]
    >;
    return buildAgentTaskIndex({ projects: new Map(entries) });
  };
}).args("workspaces", [5000]);
