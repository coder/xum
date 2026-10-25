import { Err, Ok, type Result } from "@/common/types/result";
import { getDaytonaSandboxId, ownsDaytonaSandbox } from "@/common/types/runtime";
import { getErrorMessage } from "@/common/utils/errors";
import type { BeforeArchiveHook } from "@/node/services/workspaceLifecycleHooks";
import type { DaytonaAccount } from "./daytonaAccount";
import type { DaytonaSandboxes } from "./daytonaSandboxes";

/**
 * Archiving the workspace that created a Daytona sandbox deletes the sandbox, whatever the
 * Coder archive setting says; a fork's archive leaves it alone. No uncommitted work check, as
 * for a Coder workspace deleted on archive. No unarchive hook: the deleted sandbox is gone.
 */
export interface DaytonaArchiveHookOptions {
  daytonaService: {
    account: Pick<DaytonaAccount, "withAccountLease">;
    sandboxes: Pick<DaytonaSandboxes, "deleteSandbox">;
  };
}

export function createDaytonaArchiveHook(options: DaytonaArchiveHookOptions): BeforeArchiveHook {
  return (args) =>
    options.daytonaService.account.withAccountLease(async (): Promise<Result<void>> => {
      const sandboxId = ownsDaytonaSandbox(args.workspaceMetadata)
        ? getDaytonaSandboxId(args.workspaceMetadata.runtimeConfig)
        : undefined;
      if (!sandboxId) return Ok(undefined);
      try {
        await options.daytonaService.sandboxes.deleteSandbox(sandboxId);
        return Ok(undefined);
      } catch (error) {
        return Err(`Failed to delete Daytona sandbox "${sandboxId}": ${getErrorMessage(error)}`);
      }
    });
}
