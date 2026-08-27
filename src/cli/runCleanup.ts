/**
 * Best-effort teardown runner for `xum run`.
 *
 * Teardown executes after the run outcome (including the run-complete JSON
 * event) has already been produced. A disposer that throws or rejects there
 * must not flip a finished run into a failing exit code: benchmark harnesses
 * treat a nonzero exit as an infrastructure error and discard the whole
 * trial. Contain each step, report the failure, and keep running the
 * remaining steps.
 */
export interface RunCleanupStep {
  name: string;
  run: () => void | Promise<void>;
}

export async function runBestEffortCleanup(
  steps: readonly RunCleanupStep[],
  reportError: (stepName: string, error: unknown) => void
): Promise<void> {
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      try {
        reportError(step.name, error);
      } catch {
        // Reporting must never break the remaining cleanup steps.
      }
    }
  }
}
