import type { ProjectsConfig, Workspace } from "@/common/types/project";
import type { Config } from "@/node/config";
import { DaytonaApiError } from "./daytonaClient";

/**
 * Daytona's ids of the sandboxes Xum created, as the workspace config records them
 * (`daytona.sandboxId`, next to the `sandboxName` the ssh alias uses). Every control-plane
 * request about a workspace's sandbox goes to this id: another sandbox can take the name once
 * the workspace's is gone, never the id.
 */
export interface DaytonaSandboxIds {
  /** The recorded id; undefined while the sandbox is not created (or its create never finished). */
  get(sandboxName: string): string | undefined;
  /**
   * Record a created sandbox's id on the workspace that names it. False when no workspace
   * names it any more (it was removed during the create).
   */
  record(sandboxName: string, sandboxId: string): Promise<boolean>;
}

function workspaceRows(config: ProjectsConfig): Workspace[] {
  return [...config.projects.values()].flatMap((project) => project.workspaces);
}

function daytonaOf(row: Workspace) {
  return row.runtimeConfig?.type === "ssh" ? row.runtimeConfig.daytona : undefined;
}

/** Reads and records ids in the workspace config (the app's DaytonaService uses this). */
export function createConfigSandboxIds(
  config: Pick<Config, "loadConfigOrDefault" | "editConfig">
): DaytonaSandboxIds {
  return {
    get(sandboxName) {
      // The creating workspace's record: a fork copies the whole config, record included.
      return workspaceRows(config.loadConfigOrDefault())
        .map(daytonaOf)
        .find((daytona) => daytona?.sandboxName === sandboxName && daytona.forked !== true)
        ?.sandboxId;
    },
    async record(sandboxName, sandboxId) {
      let recorded = false;
      await config.editConfig((current) => {
        // editConfig may run this again after waiting for the file lock.
        recorded = false;
        for (const row of workspaceRows(current)) {
          const daytona = daytonaOf(row);
          if (daytona?.sandboxName !== sandboxName || daytona.forked === true) continue;
          daytona.sandboxId = sandboxId;
          recorded = true;
        }
        return current;
      });
      return recorded;
    },
  };
}

/** For tests and the live suite: ids kept in memory, as if every workspace still named them. */
export class InMemoryDaytonaSandboxIds implements DaytonaSandboxIds {
  readonly ids = new Map<string, string>();

  get(sandboxName: string): string | undefined {
    return this.ids.get(sandboxName);
  }

  record(sandboxName: string, sandboxId: string): Promise<boolean> {
    this.ids.set(sandboxName, sandboxId);
    return Promise.resolve(true);
  }
}

/** The recorded id, or a `not_found` error: an unrecorded sandbox is not Xum's to reach. */
export function requireSandboxId(ids: Pick<DaytonaSandboxIds, "get">, sandboxName: string): string {
  const sandboxId = ids.get(sandboxName);
  if (sandboxId) return sandboxId;
  throw new DaytonaApiError(
    "not_found",
    `Daytona sandbox ${sandboxName} has no recorded id: Xum never finished creating it`,
    404
  );
}
