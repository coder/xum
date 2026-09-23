import { execSync } from "node:child_process";

import type { RuntimeConfig } from "@/common/types/runtime";
import type { ProjectRef } from "@/common/types/workspace";
import {
  bindTaskCheckoutIdentity,
  buildTaskCheckoutPreparation,
  claimTaskCheckoutIdentity,
  newMaterializationId,
  type TaskCheckoutPreparation,
  type TaskCheckoutSecondaryTarget,
} from "@/node/services/taskCheckoutPreparation";

/**
 * A REAL prepared dedicated task checkout for consumer tests: a git worktree of `projectPath`
 * (a real repository with a `main` branch, e.g. taskService.testHarness `createTestProject`)
 * added at `checkout`, then claimed and bound exactly like a materializer does. The returned
 * proof is valid only on the row that publishes `path: checkout` with this `runtimeConfig`
 * (`canonicalRuntimeConfigJson` is signed) — the validator refuses anything else by design, so
 * consumer suites model prepared rows with this instead of bypassing the validator.
 *
 * `secondaries` (a multi-project task): the same branch is added as a worktree of each secondary
 * project at its `checkout`, and all checkouts are bound together with `projects` (a v2 proof,
 * valid on a row whose `projects` list is exactly that one: paths, names and order).
 */
export async function prepareDedicatedTaskCheckout(args: {
  projectPath: string;
  checkout: string;
  branch: string;
  runtimeConfig: RuntimeConfig | undefined;
  secondaries?: Array<{ projectPath: string; checkout: string }>;
  projects?: ProjectRef[];
}): Promise<TaskCheckoutPreparation> {
  for (const { projectPath, checkout } of [args, ...(args.secondaries ?? [])]) {
    execSync(`git worktree add -q -b "${args.branch}" "${checkout}" main`, {
      cwd: projectPath,
      stdio: "ignore",
    });
  }
  return await prepareExistingTaskCheckout({
    workspacePath: args.checkout,
    runtimeConfig: args.runtimeConfig,
    secondaries: args.secondaries?.map((secondary) => ({
      projectPath: secondary.projectPath,
      workspacePath: secondary.checkout,
    })),
    projects: args.projects,
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
  secondaries?: TaskCheckoutSecondaryTarget[];
  projects?: ProjectRef[];
}): Promise<TaskCheckoutPreparation> {
  const materializationId = newMaterializationId();
  const target = {
    workspacePath: args.workspacePath,
    secondaries: args.secondaries,
    projects: args.projects,
  };
  const claimed = await claimTaskCheckoutIdentity(target, materializationId);
  if (claimed instanceof Error) throw claimed;
  const bound = await bindTaskCheckoutIdentity(target, materializationId, claimed);
  if (bound instanceof Error) throw bound;
  return buildTaskCheckoutPreparation(bound, args.runtimeConfig);
}
