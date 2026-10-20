import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { CoderWorkspaceArchiveBehavior } from "@/common/config/coderArchiveBehavior";
import type { DaytonaSandboxConfig } from "@/common/orpc/schemas/daytona";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { createDaytonaTestRig, type DaytonaTestRig } from "./daytona.testHarness";
import { createDaytonaArchiveHook } from "./daytonaLifecycleHooks";

let rig: DaytonaTestRig;

beforeEach(async () => {
  rig = await createDaytonaTestRig();
});

afterEach(async () => {
  await rig.cleanup();
});

function metadata(daytona: DaytonaSandboxConfig): WorkspaceMetadata {
  return {
    id: "ws",
    name: "ws",
    projectName: "proj",
    projectPath: "/tmp/proj",
    runtimeConfig: { type: "ssh", host: "x.xum--daytona", srcBaseDir: "~/src", daytona },
  };
}

function archive(daytona: DaytonaSandboxConfig, behavior: CoderWorkspaceArchiveBehavior) {
  const hook = createDaytonaArchiveHook({
    daytonaService: rig.service,
    getArchiveBehavior: () => behavior,
  });
  return hook({ workspaceId: "ws", workspaceMetadata: metadata(daytona) });
}

describe("createDaytonaArchiveHook", () => {
  it("applies the archive behavior to a sandbox Xum created", async () => {
    rig.plane.addSandbox({ id: "sb-keep" });
    rig.plane.addSandbox({ id: "sb-stop" });
    rig.plane.addSandbox({ id: "sb-delete" });

    expect((await archive({ sandboxId: "sb-keep", shared: false }, "keep")).success).toBe(true);
    expect((await archive({ sandboxId: "sb-stop", shared: false }, "stop")).success).toBe(true);
    expect((await archive({ sandboxId: "sb-delete", shared: false }, "delete")).success).toBe(true);

    expect(rig.plane.find("sb-keep")?.state).toBe("started");
    expect(rig.plane.find("sb-stop")?.state).toBe("stopped");
    expect(rig.plane.find("sb-delete")).toBeUndefined();
  });

  it("never stops or deletes an attached or shared sandbox", async () => {
    rig.plane.addSandbox({ id: "sb-users" });

    expect((await archive({ sandboxId: "sb-users", shared: true }, "delete")).success).toBe(true);
    expect((await archive({ sandboxId: "sb-users", shared: true }, "stop")).success).toBe(true);

    expect(rig.plane.find("sb-users")?.state).toBe("started");
  });
});
