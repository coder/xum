import { describe, expect, test } from "bun:test";
import { WorkspaceConfigSchema } from "./project";

describe("WorkspaceConfig taskExperiments", () => {
  test("stale programmaticToolCallingExclusive entries parse cleanly and drop the key", () => {
    // The exclusive experiment was removed (PTC is exclusive-only now).
    // Workspaces stamped by older builds may still carry the flag on disk;
    // it must be ignored, never rejected.
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
    expect(
      parsed.taskExperiments && "programmaticToolCallingExclusive" in parsed.taskExperiments
    ).toBe(false);
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

  test("a legacy exclusive false is dropped without aliasing", () => {
    const parsed = WorkspaceConfigSchema.parse({
      path: "/tmp/ws",
      taskExperiments: {
        programmaticToolCallingExclusive: false,
      },
    });
    expect(parsed.taskExperiments?.programmaticToolCalling).toBeUndefined();
  });
});
