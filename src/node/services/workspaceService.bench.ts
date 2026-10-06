/**
 * WorkspaceService single-workspace metadata reads at live-shaped sizes.
 * Run: make bench BENCH=workspaceService
 *
 * `getInfo` serves the workspace.getInfo RPC and every metadata refresh, so its cost per call
 * matters at thousands of registered workspaces. The service is real (real Config, history,
 * init state, extension metadata and background processes in a temp dir); only AIService is a
 * stub, because the constructor and getInfo touch nothing on it beyond event registration.
 * Keep helpers in this file: bench-compare resolves imports from each side's own tree, and test
 * harnesses import bun:test, which does not load on Node.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { bench } from "mitata";
import type { ProjectConfig, Workspace } from "@/common/types/project";
import { Err } from "@/common/types/result";
import { Config } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { ContextManagementService } from "@/node/services/contextManagement/contextManagementService";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { HistoryService } from "@/node/services/historyService";
import { InitStateManager } from "@/node/services/initStateManager";
import { DisposableTempDir } from "@/node/services/tempDir";
import { WorkspaceService } from "@/node/services/workspaceService";

/** 4,712 is the live-shaped size (see src/node/config/configScale.bench.ts). */
const SIZES = [50, 500, 5000, 4712];
const PROJECT_COUNT = 19;

/** mitata passes this to generator benchmarks; get() returns the current .args() value. */
interface BenchState {
  get(name: string): unknown;
}

const tempDir = new DisposableTempDir("xum-bench-workspace-service");
process.on("exit", () => tempDir[Symbol.dispose]());

function workspaceId(index: number): string {
  return `ws${index.toString(36).padStart(6, "0")}`;
}

/**
 * A compact copy of the configScale.bench.ts shape: 57% archived, 54% tasks under the latest
 * root row, 99% worktree runtime and 76% of checkout paths missing (each missing path costs a
 * failed fs access in the full build).
 */
function makeProjects(root: string, count: number): Map<string, ProjectConfig> {
  const spread = (index: number, salt: number, percent: number) =>
    (index * salt + salt) % 100 < percent;
  const projects = new Map<string, ProjectConfig>();
  for (let p = 0; p < PROJECT_COUNT; p++) {
    projects.set(path.join(root, "projects", `project-${p}`), { workspaces: [] });
  }
  const projectList = [...projects.values()];
  let lastRoot: { id: string; project: number } | undefined;
  let roots = 0;
  for (let i = 0; i < count; i++) {
    const isTask = lastRoot !== undefined && spread(i, 7, 54);
    const project = isTask ? lastRoot!.project : roots++ % PROJECT_COUNT;
    const id = workspaceId(i);
    const workspacePath = path.join(root, "src", `project-${project}`, id);
    const workspace: Workspace = {
      id,
      name: id,
      title: `Feature ${i}: tighten the workspace sidebar flow`,
      path: workspacePath,
      createdAt: "2026-09-01T12:00:00.000Z",
      runtimeConfig:
        i % 100 !== 99
          ? { type: "worktree", srcBaseDir: path.join(root, "src") }
          : { type: "local" },
      aiSettings: { model: "anthropic:claude-opus-5-5", thinkingLevel: "high" },
    };
    if (isTask) {
      workspace.parentWorkspaceId = lastRoot!.id;
      workspace.agentId = "exec";
      workspace.taskStatus = "reported";
      workspace.taskPrompt = `Task ${i}: implement the change described in the plan.`;
    } else {
      lastRoot = { id, project };
    }
    if (spread(i, 37, 57)) workspace.archivedAt = "2026-09-15T12:00:00.000Z";
    if (!spread(i, 53, 76)) fs.mkdirSync(workspacePath, { recursive: true });
    projectList[project].workspaces.push(workspace);
  }
  return projects;
}

/** Only event registration and the reads below reach AIService. */
function stubAIService(): AIService {
  const stub = {
    on: () => stub,
    off: () => stub,
    isStreaming: () => false,
    getProvidersConfig: () => null,
    isExperimentEnabled: () => false,
    getWorkspaceMetadata: (id: string) => Promise.resolve(Err(`Workspace ${id} not found`)),
  };
  return stub as unknown as AIService;
}

async function makeService(count: number): Promise<{ service: WorkspaceService; lastId: string }> {
  const root = path.join(tempDir.path, `n${count}`);
  const projects = makeProjects(root, count);
  const config = new Config(root);
  await config.editConfig((snapshot) => {
    snapshot.projects = projects;
    return snapshot;
  });
  const historyService = new HistoryService(config);
  const aiService = stubAIService();
  const service = new WorkspaceService(
    config,
    historyService,
    aiService,
    new ContextManagementService({ config, historyService, aiService }),
    new InitStateManager(config),
    new ExtensionMetadataService(path.join(root, "extensionMetadata.json")),
    new BackgroundProcessManager(path.join(root, "bg"))
  );
  return { service, lastId: workspaceId(count - 1) };
}

bench("WorkspaceService.getInfo(last id) ($workspaces)", async function* (state: BenchState) {
  const { service, lastId } = await makeService(state.get("workspaces") as number);
  // Warm once outside the timing: the first call also settles constructor startup work.
  if ((await service.getInfo(lastId))?.id !== lastId) throw new Error("getInfo missed the row");
  yield () => service.getInfo(lastId);
}).args("workspaces", SIZES);
