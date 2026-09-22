import { execSync } from "node:child_process";

import type { RuntimeConfig } from "@/common/types/runtime";
import {
  bindTaskCheckoutIdentity,
  buildTaskCheckoutPreparation,
  claimTaskCheckoutIdentity,
  newMaterializationId,
  type TaskCheckoutPreparation,
} from "@/node/services/taskCheckoutPreparation";

/**
 * A REAL prepared dedicated task checkout for consumer tests: a git worktree of `projectPath`
 * (a real repository with a `main` branch, e.g. taskService.testHarness `createTestProject`)
 * added at `checkout`, then claimed and bound exactly like a materializer does. The returned
 * proof is valid only on the row that publishes `path: checkout` with this `runtimeConfig`
 * (`canonicalRuntimeConfigJson` is signed) — the validator refuses anything else by design, so
 * consumer suites model prepared rows with this instead of bypassing the validator.
 */
export async function prepareDedicatedTaskCheckout(args: {
  projectPath: string;
  checkout: string;
  branch: string;
  runtimeConfig: RuntimeConfig | undefined;
}): Promise<TaskCheckoutPreparation> {
  execSync(`git worktree add -q -b "${args.branch}" "${args.checkout}" main`, {
    cwd: args.projectPath,
    stdio: "ignore",
  });
  const materializationId = newMaterializationId();
  const claimed = await claimTaskCheckoutIdentity(
    { workspacePath: args.checkout },
    materializationId
  );
  if (claimed instanceof Error) throw claimed;
  const bound = await bindTaskCheckoutIdentity(
    { workspacePath: args.checkout },
    materializationId,
    claimed
  );
  if (bound instanceof Error) throw bound;
  return buildTaskCheckoutPreparation(bound, args.runtimeConfig);
}
