/**
 * The story suite's pause (#5714, ../bugbash/hostPause.ts). e2e.config.ts imports this module
 * first, so the refusal comes before the bug-bash config runs: that config can throw first (for
 * example on an unresolved app AI mode), and then no message would name the pause.
 *
 * Every story drives the app with `agent.*` steps, so a model picks its actions. The suite runs
 * only in the bug-bash sandbox with a provider proxy for the job (`make test-stories`,
 * ../bugbash/sandbox/launch.ts). Everywhere else every e2e command with this config refuses.
 */
import { modelDrivenRefusal } from "../bugbash/hostPause";
import { modelDrivenSandbox } from "../bugbash/sandbox/inContainer";

if (!modelDrivenSandbox()) {
  throw new Error(
    modelDrivenRefusal("the story suite (agent.*, tests/stories/e2e.config.ts)") ?? "refused"
  );
}
