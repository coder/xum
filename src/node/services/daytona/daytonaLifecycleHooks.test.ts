import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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

function archive(workspaceMetadata: WorkspaceMetadata) {
  const hook = createDaytonaArchiveHook({ daytonaService: rig.service });
  return hook({ workspaceId: workspaceMetadata.id, workspaceMetadata });
}

describe("createDaytonaArchiveHook", () => {
  it("deletes the sandbox of the workspace that created it, and Xum's ssh access to it", async () => {
    rig.plane.addSandbox({ id: "sb-own" });
    await rig.service.sandboxes.ensureSandboxReady("sb-own");
    expect(rig.writer.tokens.has("sb-own")).toBe(true);

    expect((await archive(metadata({ sandboxName: "sb-own" }))).success).toBe(true);

    expect(rig.plane.find("sb-own")).toBeUndefined();
    expect(rig.writer.tokens.has("sb-own")).toBe(false);
  });

  it("leaves the sandbox alone when a fork or a shared-checkout task is archived", async () => {
    rig.plane.addSandbox({ id: "sb-parent" });

    const fork = metadata({ sandboxName: "sb-parent", forked: true });
    // An isolation:none task copies the parent's runtime config, sandbox ID included.
    const sharedCheckout = {
      ...metadata({ sandboxName: "sb-parent" }),
      taskIsolation: "none" as const,
    };
    expect((await archive(fork)).success).toBe(true);
    expect((await archive(sharedCheckout)).success).toBe(true);

    expect(rig.plane.find("sb-parent")?.state).toBe("started");
    expect(rig.plane.countCalls("DELETE /sandbox/sb-parent")).toBe(0);
  });

  it("archives a workspace whose sandbox is already gone", async () => {
    expect((await archive(metadata({ sandboxName: "sb-gone" }))).success).toBe(true);
  });
});
