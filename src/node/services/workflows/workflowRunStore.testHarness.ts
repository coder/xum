/** Test-only helpers shared by the WorkflowRunStore / WorkflowRunner lease-fencing suites. */
import type { WorkflowRunRecord } from "@/common/types/workflow";
import type { WorkflowRunStore } from "./WorkflowRunStore";

export function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

/**
 * One-shot pause on the store's next `getRunUnlocked` call. In the owner-checked writes
 * (appendNextEvent, appendStepRecord) that call runs after withWorkflowMutationLock took the
 * events lock and withExpectedLeaseOwner took the lease lock and checked the owner, so the pause
 * holds a writer inside its owner-check-then-write section.
 */
export function pauseNextOwnerCheckedWrite(store: WorkflowRunStore) {
  const entered = createDeferred();
  const release = createDeferred();
  // Private seam, reached the same way other store/service tests reach internals.
  const internals = store as unknown as {
    getRunUnlocked: (runId: string) => Promise<WorkflowRunRecord>;
  };
  const original = internals.getRunUnlocked.bind(store);
  internals.getRunUnlocked = async (runId: string): Promise<WorkflowRunRecord> => {
    internals.getRunUnlocked = original;
    entered.resolve();
    await release.promise;
    return await original(runId);
  };
  return { entered: entered.promise, release: () => release.resolve() };
}
