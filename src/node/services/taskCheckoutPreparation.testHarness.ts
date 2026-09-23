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
  return await prepareExistingTaskCheckout({
    workspacePath: args.checkout,
    runtimeConfig: args.runtimeConfig,
  });
}

/**
 * Fixture preparation for an ALREADY materialized, test-owned, known-clean dedicated worktree
 * checkout: claims and binds its identity and returns the proof. It does not exercise the full
 * producer protocol (no plugin-override prune, no registration-lock publication); it only models
 * the proof a producer would have published. The proof is server-owned (Config.addWorkspace never
 * takes it from metadata), so the caller writes it onto the row it models, with the same `path`
 * and `runtimeConfig`, before any tested admission.
 */
export async function prepareExistingTaskCheckout(args: {
  workspacePath: string;
  runtimeConfig: RuntimeConfig | undefined;
}): Promise<TaskCheckoutPreparation> {
  const materializationId = newMaterializationId();
  const claimed = await claimTaskCheckoutIdentity(
    { workspacePath: args.workspacePath },
    materializationId
  );
  if (claimed instanceof Error) throw claimed;
  const bound = await bindTaskCheckoutIdentity(
    { workspacePath: args.workspacePath },
    materializationId,
    claimed
  );
  if (bound instanceof Error) throw bound;
  return buildTaskCheckoutPreparation(bound, args.runtimeConfig);
}
