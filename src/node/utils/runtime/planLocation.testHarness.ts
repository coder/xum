import { randomUUID } from "crypto";
import * as os from "os";
import * as path from "path";
import type { PlanLocationConfig } from "./planLocation";

/** A fixed installation identity for tests that resolve SSH plan locations. */
export const TEST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";

/**
 * PlanLocationConfig without a real Config: a fixed installation identity and a row that is
 * migrated unless `migrated: false` (then `markRemotePlanMigrated()` flips it, as Config would).
 */
export function createTestPlanStorage(
  options: { installationId?: string; migrated?: boolean } = {}
): PlanLocationConfig & { markCalls: number } {
  let migrated = options.migrated ?? true;
  const storage = {
    markCalls: 0,
    // Holds the migration lock files of rows not yet migrated.
    sessionsDir: path.join(os.tmpdir(), `xum-test-plan-sessions-${randomUUID()}`),
    getInstallationId: () => Promise.resolve(options.installationId ?? TEST_INSTALLATION_ID),
    isRemotePlanMigrated: () => migrated,
    markRemotePlanMigrated: () => {
      storage.markCalls += 1;
      migrated = true;
      return Promise.resolve();
    },
  };
  return storage;
}
