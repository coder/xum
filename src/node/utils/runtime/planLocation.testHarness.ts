import { randomUUID } from "crypto";
import * as os from "os";
import * as path from "path";
import type { PlanLocationConfig } from "./planLocation";

/** A fixed installation identity for tests that resolve SSH plan locations. */
export const TEST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";

/**
 * PlanLocationConfig without a real Config: a fixed installation identity and a legacy fallback
 * that is retired unless `retired: false` (then `retire()` flips it, as Config would).
 */
export function createTestPlanStorage(
  options: { installationId?: string; retired?: boolean } = {}
): PlanLocationConfig & { retireCalls: number } {
  let retired = options.retired ?? true;
  const storage = {
    retireCalls: 0,
    // Holds the legacy-plan lock files of rows whose fallback is open.
    sessionsDir: path.join(os.tmpdir(), `xum-test-plan-sessions-${randomUUID()}`),
    getInstallationId: () => Promise.resolve(options.installationId ?? TEST_INSTALLATION_ID),
    isRemotePlanLegacyFallbackRetired: () => retired,
    retireRemotePlanLegacyFallback: () => {
      storage.retireCalls += 1;
      retired = true;
      return Promise.resolve();
    },
  };
  return storage;
}
