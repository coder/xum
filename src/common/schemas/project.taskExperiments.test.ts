import { describe, expect, test } from "bun:test";
import { toPersistedTaskExperiments, WorkspaceConfigSchema } from "./project";

describe("WorkspaceConfig taskExperiments", () => {
  test("legacy programmaticToolCallingExclusive entries parse cleanly and are retained", () => {
    // The exclusive experiment was merged into PTC (exclusive-only now).
    // Workspaces stamped by older builds may still carry the flag on disk;
    // it must parse cleanly and survive round-trips so a downgrade still
    // sees it (downgrade-compat mirror).
    const parsed = WorkspaceConfigSchema.parse({
      path: "/tmp/ws",
      taskExperiments: {
        programmaticToolCalling: true,
        rlm: true,
        programmaticToolCallingExclusive: true,
      },
    });
    expect(parsed.taskExperiments?.programmaticToolCalling).toBe(true);
    expect(parsed.taskExperiments?.rlm).toBe(true);
    expect(parsed.taskExperiments?.programmaticToolCallingExclusive).toBe(true);
  });

  test("exclusive-only legacy tasks keep PTC (and therefore RLM) on resumption", () => {
    // A task stamped by an older build with ONLY the exclusive flag opted into
    // exactly the posture merged PTC activates; stripping the key would drop
    // PTC and make the stamped rlm flag inert on restart-safe resumption.
    const parsed = WorkspaceConfigSchema.parse({
      path: "/tmp/ws",
      taskExperiments: {
        rlm: true,
        programmaticToolCallingExclusive: true,
      },
    });
    expect(parsed.taskExperiments?.programmaticToolCalling).toBe(true);
    expect(parsed.taskExperiments?.rlm).toBe(true);
  });

  test("a legacy exclusive false is not aliased onto PTC", () => {
    const parsed = WorkspaceConfigSchema.parse({
      path: "/tmp/ws",
      taskExperiments: {
        programmaticToolCallingExclusive: false,
      },
    });
    expect(parsed.taskExperiments?.programmaticToolCalling).toBeUndefined();
  });
});

describe("toPersistedTaskExperiments", () => {
  test("mirrors an enabled PTC onto the legacy exclusive key for downgrades", () => {
    expect(toPersistedTaskExperiments({ programmaticToolCalling: true, rlm: true })).toEqual({
      programmaticToolCalling: true,
      rlm: true,
      programmaticToolCallingExclusive: true,
    });
  });

  test("leaves PTC-off and undefined snapshots untouched", () => {
    expect(toPersistedTaskExperiments({ programmaticToolCalling: false })).toEqual({
      programmaticToolCalling: false,
    });
    expect(toPersistedTaskExperiments(undefined)).toBeUndefined();
  });
});
