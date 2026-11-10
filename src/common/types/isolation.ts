/**
 * Project × workspace isolation model.
 *
 * The user-facing choice is two independent axes (see src/common/schemas/isolation.ts). Workspaces
 * are still created and persisted with the existing RuntimeConfig union, so this module owns the
 * single mapping between the two models:
 *
 * | Project \ Workspace | none   | worktree | docker | devcontainer |
 * | ------------------- | ------ | -------- | ------ | ------------ |
 * | local               | local  | worktree | docker | devcontainer |
 * | ssh                 | -      | ssh      | -      | -            |
 * | coder               | -      | coder    | -      | -            |
 *
 * Cells marked "-" have no backend yet. They stay visible (disabled, with a reason) so the
 * composition is discoverable and future backends only need to fill in the table.
 */
import type { z } from "zod";
import type {
  IsolationChoiceSchema,
  ProjectIsolationSchema,
  WorkspaceIsolationSchema,
} from "@/common/schemas/isolation";
import type { RuntimeEnablement, RuntimeEnablementId } from "./runtime";

export type ProjectIsolation = z.infer<typeof ProjectIsolationSchema>;
export type WorkspaceIsolation = z.infer<typeof WorkspaceIsolationSchema>;
export type IsolationChoice = z.infer<typeof IsolationChoiceSchema>;

export const PROJECT_ISOLATIONS: readonly ProjectIsolation[] = ["local", "ssh", "coder"];
export const WORKSPACE_ISOLATIONS: readonly WorkspaceIsolation[] = [
  "none",
  "worktree",
  "docker",
  "devcontainer",
];

export const DEFAULT_ISOLATION: IsolationChoice = { project: "local", workspace: "worktree" };

/** Legacy flat runtime choice → isolation pair. Every legacy value has exactly one pair. */
const ISOLATION_FOR_RUNTIME_ID: Record<RuntimeEnablementId, IsolationChoice> = {
  local: { project: "local", workspace: "none" },
  worktree: { project: "local", workspace: "worktree" },
  docker: { project: "local", workspace: "docker" },
  devcontainer: { project: "local", workspace: "devcontainer" },
  ssh: { project: "ssh", workspace: "worktree" },
  coder: { project: "coder", workspace: "worktree" },
};

/** Isolation pair → backend runtime choice; null where no backend supports the pair yet. */
const RUNTIME_ID_FOR_ISOLATION: Record<
  ProjectIsolation,
  Record<WorkspaceIsolation, RuntimeEnablementId | null>
> = {
  local: { none: "local", worktree: "worktree", docker: "docker", devcontainer: "devcontainer" },
  ssh: { none: null, worktree: "ssh", docker: null, devcontainer: null },
  coder: { none: null, worktree: "coder", docker: null, devcontainer: null },
};

export function isolationFromRuntimeId(id: RuntimeEnablementId): IsolationChoice {
  return ISOLATION_FOR_RUNTIME_ID[id];
}

export function runtimeIdFromIsolation(choice: IsolationChoice): RuntimeEnablementId | null {
  return RUNTIME_ID_FOR_ISOLATION[choice.project][choice.workspace];
}

export function isIsolationSupported(choice: IsolationChoice): boolean {
  return runtimeIdFromIsolation(choice) !== null;
}

const PROJECT_ISOLATION_LABEL: Record<ProjectIsolation, string> = {
  local: "Local",
  ssh: "SSH",
  coder: "Coder",
};

/** Why a pair cannot be created yet, or null when a backend supports it. */
export function getUnsupportedIsolationReason(choice: IsolationChoice): string | null {
  if (isIsolationSupported(choice)) {
    return null;
  }
  return `Not yet supported on ${PROJECT_ISOLATION_LABEL[choice.project]} projects`;
}

/** The workspace isolation to fall back to when the project axis changes to an unsupported pair. */
export function nearestSupportedIsolation(choice: IsolationChoice): IsolationChoice {
  if (isIsolationSupported(choice)) {
    return choice;
  }
  const workspace =
    WORKSPACE_ISOLATIONS.find((candidate) =>
      isIsolationSupported({ project: choice.project, workspace: candidate })
    ) ?? DEFAULT_ISOLATION.workspace;
  return { project: choice.project, workspace };
}

/**
 * Settings → Runtimes enablement keeps its legacy on-disk keys so upgrade↔downgrade stays lossless.
 * Each isolation option owns one key: workspace "none" is the legacy project-dir "local" runtime.
 * Project "local" has no key because it cannot be disabled (it is where the project already is).
 */
export const WORKSPACE_ISOLATION_ENABLEMENT_ID: Record<WorkspaceIsolation, RuntimeEnablementId> = {
  none: "local",
  worktree: "worktree",
  docker: "docker",
  devcontainer: "devcontainer",
};

export const PROJECT_ISOLATION_ENABLEMENT_ID: Record<ProjectIsolation, RuntimeEnablementId | null> =
  {
    local: null,
    ssh: "ssh",
    coder: "coder",
  };

export function isProjectIsolationEnabled(
  enablement: RuntimeEnablement | undefined,
  project: ProjectIsolation
): boolean {
  const id = PROJECT_ISOLATION_ENABLEMENT_ID[project];
  return id === null || enablement?.[id] !== false;
}

export function isWorkspaceIsolationEnabled(
  enablement: RuntimeEnablement | undefined,
  workspace: WorkspaceIsolation
): boolean {
  return enablement?.[WORKSPACE_ISOLATION_ENABLEMENT_ID[workspace]] !== false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/** Parse a persisted isolation pair; anything malformed (or from a newer build) yields undefined. */
export function normalizeIsolationChoice(value: unknown): IsolationChoice | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (!includes(PROJECT_ISOLATIONS, value.project)) {
    return undefined;
  }
  if (!includes(WORKSPACE_ISOLATIONS, value.workspace)) {
    return undefined;
  }
  return { project: value.project, workspace: value.workspace };
}

/**
 * Config migration: prefer the new `defaultIsolation` field and fall back to the legacy
 * `defaultRuntime` written by older builds.
 */
export function resolveDefaultIsolation(
  isolation: unknown,
  legacyRuntimeId: RuntimeEnablementId | null | undefined
): IsolationChoice | undefined {
  const parsed = normalizeIsolationChoice(isolation);
  if (parsed) {
    return parsed;
  }
  return legacyRuntimeId != null ? isolationFromRuntimeId(legacyRuntimeId) : undefined;
}

export function isolationEquals(
  a: IsolationChoice | null | undefined,
  b: IsolationChoice | null | undefined
): boolean {
  if (a == null || b == null) {
    return a == b;
  }
  return a.project === b.project && a.workspace === b.workspace;
}
