import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { SubagentGitPatchArtifact } from "@/common/utils/tools/toolDefinitions";
import type { ParsedThinkingInput } from "@/common/types/thinking";
import assert from "@/common/utils/assert";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import type { TaskCreateResult } from "@/node/services/taskService";
import type {
  WorkflowAgentResult,
  WorkflowAgentSpec,
  WorkflowAgentWaitOptions,
  WorkflowApplyPatchSpec,
  WorkflowTaskAdapter,
} from "./WorkflowRunner";
import { isPathInsideDir } from "@/node/utils/pathUtils";
import {
  getSubagentGitPatchMboxPath,
  readSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";
import {
  applyTaskGitPatchArtifact,
  findGitPatchArtifactInWorkspaceOrAncestors,
  type TaskApplyGitPatchArgs,
  type TaskApplyGitPatchConfiguration,
  type TaskApplyGitPatchResult,
} from "@/node/services/tools/task_apply_git_patch";

export const DEFAULT_WORKFLOW_AGENT_ID = "exec";

interface WorkflowTaskExperiments {
  programmaticToolCalling?: boolean;
  advisorTool?: boolean;
  workspaceHeartbeats?: boolean;
  subagentFileReports?: boolean;
  dynamicWorkflows?: boolean;
}

// Shared shape for agent task creation so the single-step `create` and the
// batched `createMany` stay in lockstep; adding a field (e.g. onRefusal) in one
// place must not silently diverge from the other.
interface WorkflowTaskCreateArgs {
  parentWorkspaceId: string;
  kind: "agent";
  agentId: string;
  prompt: string;
  title: string;
  workflowTask: {
    runId: string;
    stepId: string;
    workflowName?: string;
    outputSchema?: unknown;
  };
  experiments?: WorkflowTaskExperiments;
  modelString?: string;
  thinkingLevel?: ParsedThinkingInput;
  isolation?: "fork" | "none";
  onRefusal?: "fail" | "fallback";
}

interface WorkflowTaskServiceLike {
  create(
    args: WorkflowTaskCreateArgs
  ): Promise<{ success: true; data: TaskCreateResult } | { success: false; error: string }>;
  createMany?(
    args: WorkflowTaskCreateArgs[],
    options?: {
      onTaskReserved?: (index: number, result: TaskCreateResult) => Promise<void> | void;
    }
  ): Promise<{ success: true; data: TaskCreateResult[] } | { success: false; error: string }>;
  waitForAgentReport(
    taskId: string,
    options: WorkflowAgentWaitOptions & {
      requestingWorkspaceId: string;
      backgroundOnMessageQueued: boolean;
    }
  ): Promise<{
    reportMarkdown: string;
    title?: string;
    structuredOutput?: unknown;
    planFilePath?: string;
  }>;
  requestAgentFinalReportForTimeout?(
    taskId: string,
    options: {
      workflowRunId: string;
      stepId: string;
      inputHash: string;
      finalizationToken: string;
      finalInstructions?: string;
    }
  ): Promise<"prompted" | "queued" | "already_reported" | "not_active">;
  failAgentTaskForHardTimeout?(
    taskId: string,
    options: {
      workflowRunId: string;
      stepId: string;
      inputHash: string;
      reason: string;
    }
  ): Promise<void>;
  terminateAllDescendantAgentTasks?(
    workspaceId: string,
    options?: { workflowRunId?: string }
  ): Promise<string[]>;
  withGitPatchArtifactOperationLock?<T>(taskId: string, operation: () => Promise<T>): Promise<T>;
  markWorkflowRunEnded?(workflowRunId: string): Promise<void>;
}

type WorkflowPatchArtifactApplier = (
  args: TaskApplyGitPatchArgs,
  options?: { abortSignal?: AbortSignal }
) => Promise<TaskApplyGitPatchResult>;

export interface WorkflowTaskServiceAdapterOptions {
  taskService: WorkflowTaskServiceLike;
  parentWorkspaceId: string;
  workflowRunId: string;
  /**
   * Human-readable workflow display name, stamped onto spawned tasks so the
   * sidebar can label workflow run groups. Optional: interrupt-only adapters
   * and legacy call sites may not know the name.
   */
  workflowName?: string;
  defaultAgentId: string;
  experiments?: WorkflowTaskExperiments;
  modelString?: string;
  thinkingLevel?: ParsedThinkingInput;
  patchToolConfig?: TaskApplyGitPatchConfiguration;
  applyPatchArtifact?: WorkflowPatchArtifactApplier;
  getProjectTrusted?: () => boolean | Promise<boolean>;
}

export class WorkflowTaskServiceAdapter implements WorkflowTaskAdapter {
  private readonly taskService: WorkflowTaskServiceLike;
  private readonly parentWorkspaceId: string;
  private readonly workflowRunId: string;
  private readonly workflowName?: string;
  private readonly defaultAgentId: string;
  private readonly patchToolConfig?: TaskApplyGitPatchConfiguration;
  private readonly applyPatchArtifact?: WorkflowPatchArtifactApplier;
  private readonly getProjectTrusted?: () => boolean | Promise<boolean>;
  private readonly patchApplyMutex = new AsyncMutex();
  private readonly experiments?: WorkflowTaskExperiments;
  private readonly modelString?: string;
  private readonly thinkingLevel?: ParsedThinkingInput;

  constructor(options: WorkflowTaskServiceAdapterOptions) {
    assert(
      options.parentWorkspaceId.length > 0,
      "WorkflowTaskServiceAdapter: parentWorkspaceId is required"
    );
    assert(
      options.workflowRunId.length > 0,
      "WorkflowTaskServiceAdapter: workflowRunId is required"
    );
    assert(
      options.defaultAgentId.length > 0,
      "WorkflowTaskServiceAdapter: defaultAgentId is required"
    );
    this.taskService = options.taskService;
    this.parentWorkspaceId = options.parentWorkspaceId;
    this.workflowRunId = options.workflowRunId;
    this.workflowName = options.workflowName;
    this.defaultAgentId = options.defaultAgentId;
    this.patchToolConfig = options.patchToolConfig;
    this.applyPatchArtifact = options.applyPatchArtifact;
    this.getProjectTrusted = options.getProjectTrusted;
    this.experiments = options.experiments;
    this.modelString = options.modelString;
    this.thinkingLevel = options.thinkingLevel;
  }

  async applyPatch(
    spec: WorkflowApplyPatchSpec,
    options?: { abortSignal?: AbortSignal }
  ): Promise<TaskApplyGitPatchResult> {
    assert(spec.id.length > 0, "WorkflowTaskServiceAdapter.applyPatch: spec.id is required");
    assert(
      spec.sourceTaskId.length > 0,
      "WorkflowTaskServiceAdapter.applyPatch: sourceTaskId is required"
    );
    if ((await this.getProjectTrusted?.()) !== true) {
      throw new Error("applyPatch requires Project Trust");
    }

    // Applying one patch mutates HEAD, so complete each dry-run + real apply pair before
    // checking the next patch. This preserves the old Orchestrator conflict model.
    await using _lock = await this.patchApplyMutex.acquire();
    const apply = async (): Promise<TaskApplyGitPatchResult> => {
      const applyPatchArtifact = this.resolvePatchArtifactApplier();
      const baseArgs: TaskApplyGitPatchArgs = {
        task_id: spec.sourceTaskId,
        ...(spec.projectPath != null ? { project_path: spec.projectPath } : {}),
        ...(spec.expectedHeadSha != null ? { expected_head_sha: spec.expectedHeadSha } : {}),
        three_way: spec.threeWay,
        force: spec.force,
      };

      const dryRun = await applyPatchArtifact(
        {
          ...baseArgs,
          dry_run: true,
        },
        options
      );
      if (!dryRun.success) {
        return dryRun;
      }

      const pathViolation = await this.getAllowedPatchPathViolation(spec);
      if (pathViolation != null) {
        return { success: false, taskId: spec.sourceTaskId, error: pathViolation };
      }

      return await applyPatchArtifact(
        {
          ...baseArgs,
          dry_run: false,
        },
        options
      );
    };

    return this.taskService.withGitPatchArtifactOperationLock == null
      ? await apply()
      : await this.taskService.withGitPatchArtifactOperationLock(spec.sourceTaskId, apply);
  }

  private resolvePatchArtifactApplier(): WorkflowPatchArtifactApplier {
    if (this.applyPatchArtifact != null) {
      return this.applyPatchArtifact;
    }
    const patchToolConfig = this.patchToolConfig;
    if (patchToolConfig == null) {
      throw new Error("WorkflowTaskServiceAdapter.applyPatch requires patch tool configuration");
    }
    return async (args, options) =>
      await applyTaskGitPatchArtifact(
        {
          ...patchToolConfig,
          // applyPatch holds the stable-child lock across dry-run, policy validation, and apply.
          // Do not reacquire the non-reentrant lock inside the shared tool implementation.
          taskService: undefined,
          trusted: true,
        },
        args,
        { abortSignal: options?.abortSignal, allowAlreadyApplied: true }
      );
  }

  private async getAllowedPatchPathViolation(
    spec: WorkflowApplyPatchSpec
  ): Promise<string | undefined> {
    if (spec.allowedPathPrefixes == null || spec.allowedPathPrefixes.length === 0) {
      return undefined;
    }
    const workspaceSessionDir = this.patchToolConfig?.workspaceSessionDir;
    if (workspaceSessionDir == null || workspaceSessionDir.length === 0) {
      return "applyPatch allowedPathPrefixes requires patch artifact metadata";
    }

    const artifactLookup = await this.findPatchArtifactForPathValidation(
      workspaceSessionDir,
      spec.sourceTaskId
    );
    if (artifactLookup == null) {
      return `Patch artifact not found for task ${spec.sourceTaskId}`;
    }

    const projectArtifacts = artifactLookup.artifact.projectArtifacts.filter(
      (projectArtifact) =>
        spec.projectPath == null || projectArtifact.projectPath === spec.projectPath
    );
    const violations = new Set<string>();
    for (const projectArtifact of projectArtifacts) {
      if (projectArtifact.status === "skipped") {
        continue;
      }
      if (projectArtifact.status !== "ready") {
        return `Patch artifact for ${projectArtifact.projectName} is ${projectArtifact.status}; cannot validate allowedPathPrefixes.`;
      }
      const patchPath = await this.getProjectPatchMboxPath(
        artifactLookup.artifactSessionDir,
        spec.sourceTaskId,
        projectArtifact
      );
      if (patchPath == null) {
        return `Patch file is missing for task ${spec.sourceTaskId}`;
      }
      const patchText = await fs.readFile(patchPath, "utf-8");
      const patchPaths = extractGitPatchPaths(patchText);
      for (const patchPath of patchPaths) {
        if (!isPatchPathAllowed(patchPath, spec.allowedPathPrefixes)) {
          violations.add(patchPath);
        }
      }
    }

    if (violations.size === 0) {
      return undefined;
    }
    return `Patch touches paths outside allowed prefixes (${spec.allowedPathPrefixes.join(", ")}): ${Array.from(violations).join(", ")}`;
  }

  private async findPatchArtifactForPathValidation(
    workspaceSessionDir: string,
    sourceTaskId: string
  ): Promise<{ artifact: SubagentGitPatchArtifact; artifactSessionDir: string } | null> {
    const workspaceId = this.patchToolConfig?.workspaceId;
    if (workspaceId != null && workspaceId.length > 0) {
      return await findGitPatchArtifactInWorkspaceOrAncestors({
        workspaceId,
        workspaceSessionDir,
        childTaskId: sourceTaskId,
      });
    }

    const artifact = await readSubagentGitPatchArtifact(workspaceSessionDir, sourceTaskId);
    return artifact == null ? null : { artifact, artifactSessionDir: workspaceSessionDir };
  }

  private async getProjectPatchMboxPath(
    artifactSessionDir: string,
    taskId: string,
    projectArtifact: { storageKey: string; mboxPath?: string }
  ): Promise<string | undefined> {
    const expectedPatchPath = getSubagentGitPatchMboxPath(
      artifactSessionDir,
      taskId,
      projectArtifact.storageKey
    );
    const candidates = [projectArtifact.mboxPath, expectedPatchPath].filter(
      (candidate): candidate is string =>
        typeof candidate === "string" && isPathInsideDir(artifactSessionDir, candidate)
    );
    for (const candidate of candidates) {
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile()) {
          return candidate;
        }
      } catch {
        // Try the next candidate.
      }
    }
    return undefined;
  }

  async interruptRun(): Promise<void> {
    await this.taskService.terminateAllDescendantAgentTasks?.(this.parentWorkspaceId, {
      workflowRunId: this.workflowRunId,
    });
  }

  async onRunEnded(): Promise<void> {
    await this.taskService.markWorkflowRunEnded?.(this.workflowRunId);
  }

  async createAgentTasks(
    specs: WorkflowAgentSpec[],
    lifecycle?: { onTaskCreated?: (index: number, taskId: string) => Promise<void> | void }
  ): Promise<Array<{ taskId: string; status: "queued" | "starting" | "running" }>> {
    assert(specs.length > 0, "WorkflowTaskServiceAdapter.createAgentTasks: specs are required");
    if (this.taskService.createMany == null) {
      const created: Array<{ taskId: string; status: "queued" | "starting" | "running" }> = [];
      for (const [index, spec] of specs.entries()) {
        const createResult = await this.taskService.create(this.buildCreateArgs(spec));
        if (!createResult.success) {
          throw new Error(createResult.error);
        }
        assert(createResult.data.taskId.length > 0, "createAgentTasks: taskId is required");
        await lifecycle?.onTaskCreated?.(index, createResult.data.taskId);
        created.push({ taskId: createResult.data.taskId, status: createResult.data.status });
      }
      return created;
    }

    const createResult = await this.taskService.createMany(
      specs.map((spec) => this.buildCreateArgs(spec)),
      {
        onTaskReserved: async (index, result) => {
          assert(result.taskId.length > 0, "createAgentTasks: taskId is required");
          await lifecycle?.onTaskCreated?.(index, result.taskId);
        },
      }
    );
    if (!createResult.success) {
      throw new Error(createResult.error);
    }
    if (createResult.data.length !== specs.length) {
      throw new Error("WorkflowTaskServiceAdapter.createAgentTasks: result length mismatch");
    }

    const created: Array<{ taskId: string; status: "queued" | "starting" | "running" }> = [];
    for (const result of createResult.data) {
      assert(result.taskId.length > 0, "createAgentTasks: taskId is required");
      created.push({ taskId: result.taskId, status: result.status });
    }
    return created;
  }

  private buildCreateArgs(
    spec: WorkflowAgentSpec
  ): Parameters<WorkflowTaskServiceLike["create"]>[0] {
    assert(spec.id.length > 0, "WorkflowTaskServiceAdapter: spec.id is required");
    assert(spec.prompt.length > 0, "WorkflowTaskServiceAdapter: spec.prompt is required");

    const workflowTask: {
      runId: string;
      stepId: string;
      workflowName?: string;
      outputSchema?: unknown;
    } = {
      runId: this.workflowRunId,
      stepId: spec.id,
    };
    if (this.workflowName !== undefined) {
      workflowTask.workflowName = this.workflowName;
    }
    if (spec.outputSchema !== undefined) {
      workflowTask.outputSchema = spec.outputSchema;
    }

    const agentId = spec.agentId ?? this.defaultAgentId;
    const experiments = this.getExperimentsForAgent(agentId);
    const modelString = spec.modelString ?? this.modelString;
    const thinkingLevel = spec.thinkingLevel ?? this.thinkingLevel;
    return {
      parentWorkspaceId: this.parentWorkspaceId,
      kind: "agent",
      agentId,
      prompt: spec.prompt,
      title: spec.title ?? spec.id,
      workflowTask,
      ...(spec.isolation !== undefined ? { isolation: spec.isolation } : {}),
      ...(experiments !== undefined ? { experiments } : {}),
      ...(modelString !== undefined ? { modelString } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      // Refusal policy must survive both the single-step and parallel
      // (createAgentTasks) paths: a verifier step marked onRefusal: "fail"
      // must fail honestly instead of silently continuing on a fallback model.
      ...(spec.onRefusal !== undefined ? { onRefusal: spec.onRefusal } : {}),
    };
  }

  async runAgent(
    spec: WorkflowAgentSpec,
    lifecycle?: { onTaskCreated?: (taskId: string) => Promise<void> | void },
    waitOptions?: WorkflowAgentWaitOptions
  ): Promise<WorkflowAgentResult> {
    assert(spec.id.length > 0, "WorkflowTaskServiceAdapter.runAgent: spec.id is required");
    assert(spec.prompt.length > 0, "WorkflowTaskServiceAdapter.runAgent: spec.prompt is required");

    const createResult = await this.taskService.create(this.buildCreateArgs(spec));
    if (!createResult.success) {
      throw new Error(createResult.error);
    }

    await lifecycle?.onTaskCreated?.(createResult.data.taskId);

    return await this.waitForAgentTask(createResult.data.taskId, spec, waitOptions);
  }

  private getExperimentsForAgent(agentId: string): WorkflowTaskExperiments | undefined {
    const experiments = this.experiments;
    if (experiments == null) {
      return undefined;
    }

    if (agentId.trim().toLowerCase() !== "explore" || experiments.subagentFileReports !== true) {
      return experiments;
    }

    // Explore is intentionally read-only and cannot create report.md/structured-output.json.
    // Keep workflow Explore steps compatible when file-backed reporting is enabled globally.
    return { ...experiments, subagentFileReports: false };
  }

  async requestAgentFinalReportForTimeout(
    taskId: string,
    options: {
      workflowRunId: string;
      stepId: string;
      inputHash: string;
      finalizationToken: string;
      finalInstructions?: string;
    }
  ): Promise<"prompted" | "queued" | "already_reported" | "not_active"> {
    assert(
      this.taskService.requestAgentFinalReportForTimeout != null,
      "WorkflowTaskServiceAdapter requires TaskService timeout finalization support"
    );
    return await this.taskService.requestAgentFinalReportForTimeout(taskId, options);
  }

  async failAgentTaskForHardTimeout(
    taskId: string,
    options: { workflowRunId: string; stepId: string; inputHash: string; reason: string }
  ): Promise<void> {
    assert(
      this.taskService.failAgentTaskForHardTimeout != null,
      "WorkflowTaskServiceAdapter requires TaskService hard timeout support"
    );
    await this.taskService.failAgentTaskForHardTimeout(taskId, options);
  }

  async waitForAgentTask(
    taskId: string,
    _spec: WorkflowAgentSpec,
    waitOptions?: WorkflowAgentWaitOptions
  ): Promise<WorkflowAgentResult> {
    const report = await this.taskService.waitForAgentReport(taskId, {
      ...(waitOptions?.abortSignal != null ? { abortSignal: waitOptions.abortSignal } : {}),
      ...(waitOptions?.timeoutMs != null ? { timeoutMs: waitOptions.timeoutMs } : {}),
      ...(waitOptions?.onExecutionStarted != null
        ? { onExecutionStarted: waitOptions.onExecutionStarted }
        : {}),
      requestingWorkspaceId: this.parentWorkspaceId,
      backgroundOnMessageQueued: waitOptions?.backgroundOnMessageQueued ?? true,
    });

    return {
      taskId,
      reportMarkdown: report.reportMarkdown,
      ...(report.title != null ? { title: report.title } : {}),
      ...(report.planFilePath !== undefined ? { planFilePath: report.planFilePath } : {}),
      ...(report.structuredOutput !== undefined
        ? { structuredOutput: report.structuredOutput }
        : {}),
    };
  }
}

function extractGitPatchPaths(patchText: string): string[] {
  const paths = new Set<string>();
  for (const line of patchText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const parts = splitGitPatchWords(line.slice("diff --git ".length));
      if (parts.length >= 2) {
        addPatchPath(paths, parts[0]);
        addPatchPath(paths, parts[1]);
      } else {
        paths.add("<unparseable diff header>");
      }
    } else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      addPatchPath(paths, line.slice(4));
    } else if (line.startsWith("rename from ")) {
      addPatchPath(paths, line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      addPatchPath(paths, line.slice("rename to ".length));
    } else if (line.startsWith("copy from ")) {
      addPatchPath(paths, line.slice("copy from ".length));
    } else if (line.startsWith("copy to ")) {
      addPatchPath(paths, line.slice("copy to ".length));
    }
  }
  return Array.from(paths);
}

function splitGitPatchWords(value: string): string[] {
  const words: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quoted) {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      current += char;
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (current.length > 0) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    words.push(current);
  }
  return words;
}

function addPatchPath(paths: Set<string>, rawPath: string | undefined): void {
  const normalized = normalizePatchPath(rawPath);
  if (normalized != null) {
    paths.add(normalized);
  }
}

function normalizePatchPath(rawPath: string | undefined): string | undefined {
  if (rawPath == null) {
    return undefined;
  }
  let value = rawPath.trim();
  if (value.length === 0 || value === "/dev/null") {
    return undefined;
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      value = JSON.parse(value) as string;
    } catch {
      value = value.slice(1, -1);
    }
  }
  if (value.startsWith("a/") || value.startsWith("b/")) {
    value = value.slice(2);
  }
  const segments = value.split("/");
  if (path.posix.isAbsolute(value) || segments.includes("..")) {
    return value;
  }
  return segments.filter((segment) => segment.length > 0 && segment !== ".").join("/");
}

function isPatchPathAllowed(patchPath: string, allowedPrefixes: string[]): boolean {
  return allowedPrefixes.some((prefix) => {
    const normalizedPrefix = normalizePatchPath(prefix);
    if (normalizedPrefix == null) {
      return false;
    }
    return patchPath === normalizedPrefix || patchPath.startsWith(`${normalizedPrefix}/`);
  });
}
