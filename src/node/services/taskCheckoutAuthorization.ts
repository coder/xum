/**
 * Consumer seam over taskCheckoutPreparation: the ONE representation of "what a stream-starting
 * or MCP-activating path was authorized against", shared by the task admissions, the deep MCP
 * override read, the MCP manager, the turn builder and AIService's provider gate.
 *
 * The core validator authorizes only host-local task rows (`ready` → TaskCheckoutAuthority) and
 * reports roots / off-host task rows as EXCLUDED (the protocol does not apply; today's behavior).
 * Consumers still have to re-prove that exemption at their late, synchronous fences: an absent
 * authority is never an unconditional allow after an await — a row that gained a proof, became a
 * task row, or vanished from the registry meanwhile must refuse. Hence the two-kind
 * authorization value below, and `isTaskCheckoutAuthorizationCurrent`, which re-derives either
 * kind strictly from the fresh registry (config only: no filesystem, no checkout locks, safe
 * under the override writer's fence and inside config-edit callbacks).
 */
import type { ProjectsConfig } from "@/common/types/project";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import { Err, Ok, type Result } from "@/common/types/result";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import {
  assertCurrentTaskCheckoutAuthority,
  classifyTaskCheckoutKind,
  validateTaskCheckoutPreparation,
  type TaskCheckoutAuthority,
  type TaskCheckoutPreparationState,
} from "@/node/services/taskCheckoutPreparation";

type ConfigReader = Pick<Config, "loadConfigOrDefault">;

/** Plain JSON data: threaded from the async validation to every later synchronous fence. */
export type TaskCheckoutAuthorization =
  | { kind: "authority"; authority: TaskCheckoutAuthority }
  | { kind: "exempt"; workspaceId: string; exemption: "root" | "offhost" };

export type TaskCheckoutExemption = Extract<TaskCheckoutAuthorization, { kind: "exempt" }>;

/** A refusing validator state (everything except `ready` and the two exclusions). */
export type TaskCheckoutRefusal = Exclude<
  TaskCheckoutPreparationState,
  { kind: "ready" | "excluded-root" | "excluded-offhost" }
>;

/** Stable refusal code for a validator state (`PREP_LEGACY`, `PREP_SHARED_BROKEN`, ...). */
export function taskCheckoutRefusalCode(state: TaskCheckoutRefusal): string {
  return `PREP_${state.kind.toUpperCase().replace(/-/g, "_")}`;
}

/** The inspectable, user-facing refusal for a workspace whose checkout preparation refused. */
export function taskCheckoutRefusalMessage(
  workspaceId: string,
  state: TaskCheckoutRefusal
): string {
  const detail =
    state.kind === "legacy"
      ? "its checkout was created before checkout preparation existed and carries no proof"
      : state.kind === "missing"
        ? "its prepared checkout no longer exists"
        : state.kind === "mismatch"
          ? `its checkout identity no longer matches its preparation proof (${state.dimension})`
          : state.detail;
  return `Task workspace ${workspaceId} cannot run: ${detail} (${taskCheckoutRefusalCode(state)}). The workspace stays inspectable; create a fresh task to continue the work.`;
}

/** The refusal for a fence whose fresh registry no longer derives the captured authorization. */
export function taskCheckoutStaleMessage(workspaceId: string, reason: string): string {
  return `Task workspace ${workspaceId} cannot run: its checkout preparation changed after this send was decided — ${reason} (PREP_STALE). Retry.`;
}

/**
 * Async, bounded capture (the physical validation) of what `workspaceId` may execute or activate
 * MCP under. Never throws. `Err` carries the inspectable refusal message.
 */
export async function captureTaskCheckoutAuthorization(
  config: ConfigReader,
  workspaceId: string
): Promise<Result<TaskCheckoutAuthorization, string>> {
  const state = await validateTaskCheckoutPreparation(config, workspaceId);
  switch (state.kind) {
    case "ready":
      return Ok({ kind: "authority", authority: state.authority });
    case "excluded-root":
      return Ok({ kind: "exempt", workspaceId, exemption: "root" });
    case "excluded-offhost":
      return Ok({ kind: "exempt", workspaceId, exemption: "offhost" });
    default:
      return Err(taskCheckoutRefusalMessage(workspaceId, state));
  }
}

/**
 * Config-only exemption of a registry row: an ordinary root or an off-host task row that carries
 * NO preparation proof. A present proof is never exempt (the validator refuses it as unsupported /
 * runtime-mismatch); a missing row is never exempt.
 */
export function deriveTaskCheckoutExemption(
  snapshot: ProjectsConfig,
  workspaceId: string
): TaskCheckoutExemption | undefined {
  const row = findWorkspaceEntry(snapshot, workspaceId)?.workspace;
  if (row == null || row.taskCheckoutPreparation !== undefined) return undefined;
  const kind = classifyTaskCheckoutKind(row);
  if (kind === "root" || kind === "offhost")
    return { kind: "exempt", workspaceId, exemption: kind };
  return undefined;
}

/** Whether `row` is a host-local task row (shared or dedicated): the rows the protocol governs. */
export function isTaskCheckoutDomainRow(row: WorkspaceConfigEntry): boolean {
  const kind = classifyTaskCheckoutKind(row);
  return kind === "shared" || kind === "dedicated";
}

export function taskCheckoutAuthorizationEqual(
  a: TaskCheckoutAuthorization | undefined,
  b: TaskCheckoutAuthorization | undefined
): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "exempt" && b.kind === "exempt") {
    return a.workspaceId === b.workspaceId && a.exemption === b.exemption;
  }
  if (a.kind === "authority" && b.kind === "authority") {
    return (
      a.authority.workspaceId === b.authority.workspaceId &&
      a.authority.signature === b.authority.signature
    );
  }
  return false;
}

/**
 * Synchronous, strict, config-only re-check at a late fence: the fresh registry must still derive
 * exactly `captured` for `workspaceId`. With no captured value (a path that could not run the
 * async capture) only a fresh EXEMPTION satisfies — never a task row, never a missing row.
 * `config` is a reader: the live Config (a throwing read) or a config-edit callback's snapshot.
 */
export function isTaskCheckoutAuthorizationCurrent(
  config: ConfigReader,
  workspaceId: string,
  captured: TaskCheckoutAuthorization | undefined
): { current: true } | { current: false; reason: string } {
  if (captured !== undefined && captured.kind === "authority") {
    if (captured.authority.workspaceId !== workspaceId) {
      return { current: false, reason: "the captured authority names another workspace" };
    }
    return assertCurrentTaskCheckoutAuthority(config, captured.authority);
  }
  let snapshot: ProjectsConfig;
  try {
    snapshot = config.loadConfigOrDefault({ throwOnError: true });
  } catch (error: unknown) {
    return {
      current: false,
      reason: `task registry unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const fresh = deriveTaskCheckoutExemption(snapshot, workspaceId);
  if (fresh === undefined) {
    return {
      current: false,
      reason:
        captured === undefined
          ? "the workspace is a host-local task row (or is unregistered) and nothing was captured for it"
          : "the workspace is no longer exempt from checkout preparation",
    };
  }
  if (captured !== undefined && !taskCheckoutAuthorizationEqual(captured, fresh)) {
    return { current: false, reason: "the workspace's exemption changed" };
  }
  return { current: true };
}

/** A reader over an already-loaded snapshot (config-edit callbacks). */
export function snapshotConfigReader(snapshot: ProjectsConfig): ConfigReader {
  return { loadConfigOrDefault: () => snapshot };
}
