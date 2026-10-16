import { getCreationDraftStore } from "@/browser/stores/CreationDraftStore";
import type { CreationDraftExecution } from "@/common/orpc/schemas/drafts";
import type { ProjectConfig } from "@/common/types/project";
import {
  normalizeRuntimeEnablement,
  RUNTIME_MODE,
  type ParsedRuntime,
  type RuntimeEnablement,
} from "@/common/types/runtime";
import { resolveWorkspaceCreationScope } from "@/common/utils/subProjects";

/** The runtimes a project's creation offers: its Settings → Runtimes overrides, else the global ones. */
export function projectRuntimeEnablement(
  project: ProjectConfig | undefined,
  global: RuntimeEnablement
): RuntimeEnablement {
  if (!project) return global;
  const hasOverrides =
    project.runtimeOverridesEnabled === true ||
    Boolean(project.runtimeEnablement) ||
    project.defaultRuntime !== undefined;
  return hasOverrides ? normalizeRuntimeEnablement(project.runtimeEnablement) : global;
}

/** A project agent exists only in its project; built-in and global agents exist everywhere. */
function portableAgent(agent: CreationDraftExecution["agent"] | undefined) {
  return agent?.scope === "project" ? null : (agent ?? null);
}

/** Local and Worktree need no host, so they travel where the target's Settings allow them. */
function portableRuntime(
  runtime: ParsedRuntime | null | undefined,
  enablement: RuntimeEnablement | null
): ParsedRuntime | null {
  if (!runtime || !enablement) return null;
  const hostless = runtime.mode === RUNTIME_MODE.LOCAL || runtime.mode === RUNTIME_MODE.WORKTREE;
  return hostless && enablement[runtime.mode] ? runtime : null;
}

/**
 * The execution choices that stay valid in the target project. Choices tied to the old project
 * (a project agent, the trunk branch, an SSH or container host) reset, so a draft never sends to
 * another project's host. Scratch (no enablement) runs no runtime.
 */
function choicesForTarget(
  execution: CreationDraftExecution | null,
  enablement: RuntimeEnablement | null
): CreationDraftExecution {
  return {
    agent: portableAgent(execution?.agent),
    runtime: portableRuntime(execution?.runtime, enablement),
    trunkBranch: null,
  };
}

/**
 * Moves a creation draft to the scope picked in its composer (a project, a sub-project or
 * Scratch). Only fields change: the id, text, attachments, manual name and AI choices stay, and
 * no project's defaults are written. Returns the project to open the draft in.
 */
export function changeCreationDraftProject(
  draftId: string,
  scope: string,
  projects: Map<string, ProjectConfig>,
  globalEnablement: RuntimeEnablement
): string {
  const store = getCreationDraftStore();
  const draft = store.getView(draftId).draft;
  // Scratch is not a configured project, so it resolves to itself with no sub-project.
  const target = resolveWorkspaceCreationScope(scope, projects);
  if (!draft) return target.projectPath;
  const targetConfig = projects.get(target.projectPath);
  // A sub-project switch keeps the parent repository, so its runtime and trunk still apply; its
  // agents are listed from the sub-project, so another (sub-)project's agent resets.
  const sameAgents =
    (target.subProjectPath ?? target.projectPath) === (draft.subProjectPath ?? draft.projectPath);
  const execution =
    target.projectPath !== draft.projectPath
      ? choicesForTarget(
          draft.execution,
          targetConfig ? projectRuntimeEnablement(targetConfig, globalEnablement) : null
        )
      : draft.execution && !sameAgents
        ? { ...draft.execution, agent: portableAgent(draft.execution.agent) }
        : draft.execution;
  store.update(draftId, { ...target, execution });
  return target.projectPath;
}
