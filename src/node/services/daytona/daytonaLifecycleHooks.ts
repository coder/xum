import { Err, Ok, type Result } from "@/common/types/result";
import { getDaytonaSandboxId, ownsDaytonaSandbox } from "@/common/types/runtime";
import { getErrorMessage } from "@/common/utils/errors";
import type { BeforeArchiveHook } from "@/node/services/workspaceLifecycleHooks";
import { notOwnedSandboxNotice, type DaytonaService } from "./daytonaService";

/**
 * Archiving the workspace that created a Daytona sandbox deletes the sandbox, whatever the
 * Coder archive setting says; a fork's archive leaves it alone. No uncommitted work check, as
 * for a Coder workspace deleted on archive. No unarchive hook: the deleted sandbox is gone.
 */
export interface DaytonaArchiveHookOptions {
  daytonaService: Pick<DaytonaService, "deleteSandbox" | "withAccountLease">;
}

export function createDaytonaArchiveHook(options: DaytonaArchiveHookOptions): BeforeArchiveHook {
  return (args) =>
    options.daytonaService.withAccountLease(async (): Promise<Result<void>> => {
      const sandboxId = ownsDaytonaSandbox(args.workspaceMetadata)
        ? getDaytonaSandboxId(args.workspaceMetadata.runtimeConfig)
        : undefined;
      if (!sandboxId) return Ok(undefined);
      try {
        // Not Xum's after all (see deleteSandbox): it is kept.
        if ((await options.daytonaService.deleteSandbox(sandboxId)) === "notOwned") {
          args.reportWarning?.(notOwnedSandboxNotice(sandboxId));
        }
        return Ok(undefined);
      } catch (error) {
        return Err(`Failed to delete Daytona sandbox "${sandboxId}": ${getErrorMessage(error)}`);
      }
    });
}
