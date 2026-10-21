import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { CoderWorkspaceArchiveBehavior } from "@/common/config/coderArchiveBehavior";
import type { DaytonaSandboxConfig } from "@/common/orpc/schemas/daytona";
import { Ok, type Result } from "@/common/types/result";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { DaytonaSSHRuntime } from "@/node/runtime/DaytonaSSHRuntime";
import { SSHRuntime } from "@/node/runtime/SSHRuntime";
import { createSSHTransport } from "@/node/runtime/transports";
import { createDaytonaTestRig, type DaytonaTestRig } from "./daytona.testHarness";
import { createDaytonaArchiveHook, type DaytonaArchiveHookOptions } from "./daytonaLifecycleHooks";

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

const cleanCheck = (): Promise<Result<void, string>> => Promise.resolve(Ok(undefined));

function archive(
  daytona: DaytonaSandboxConfig,
  behavior: CoderWorkspaceArchiveBehavior,
  checkSandboxDeletable: DaytonaArchiveHookOptions["checkSandboxDeletable"] = cleanCheck,
  reportWarning?: (warning: string) => void
) {
  const hook = createDaytonaArchiveHook({
    daytonaService: rig.service,
    getArchiveBehavior: () => behavior,
    checkSandboxDeletable,
  });
  return hook({ workspaceId: "ws", workspaceMetadata: metadata(daytona), reportWarning });
}

/** The production checker: the runtime's own dirty and unpushed check, as serviceContainer wires it. */
function runtimeCheck(daytona: DaytonaSandboxConfig) {
  const config = { host: "x.xum--daytona", srcBaseDir: "~/src", daytona };
  const runtime = new DaytonaSSHRuntime(config, createSSHTransport(config, false), rig.service);
  return (workspaceMetadata: WorkspaceMetadata) =>
    runtime.checkSandboxDeletable(workspaceMetadata.projectPath, workspaceMetadata.name, true);
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

  it("leaves a sandbox another workspace references alone, else releases Xum's ssh access", async () => {
    rig.plane.addSandbox({ id: "sb-shared" });
    await rig.service.ensureSshAccess("sb-shared");
    rig.workspaces.push({
      workspaceId: "fork",
      runtimeConfig: metadata({ sandboxId: "sb-shared", forked: true }).runtimeConfig,
    });

    // The fork still works in the sandbox: no stop, no delete, its token stays live.
    expect((await archive({ sandboxId: "sb-shared", shared: false }, "delete")).success).toBe(true);
    expect(rig.plane.find("sb-shared")?.state).toBe("started");
    expect(rig.plane.revokedTokens).toEqual([]);

    // The last workspace on an attached sandbox: the sandbox stays, the token goes.
    rig.workspaces.length = 0;
    expect((await archive({ sandboxId: "sb-shared", shared: true }, "delete")).success).toBe(true);
    expect(rig.plane.find("sb-shared")?.state).toBe("started");
    expect(rig.plane.revokedTokens).toHaveLength(1);
    expect(rig.writer.removed).toEqual(["sb-shared"]);
  });

  it("leaves the parent's sandbox alone when a shared-checkout sub-agent is archived", async () => {
    rig.plane.addSandbox({ id: "sb-parent" });
    const hook = createDaytonaArchiveHook({
      daytonaService: rig.service,
      getArchiveBehavior: () => "delete",
      checkSandboxDeletable: cleanCheck,
    });

    // An isolation:none child copies the parent's runtime config, sandbox ID included.
    const result = await hook({
      workspaceId: "child",
      workspaceMetadata: {
        ...metadata({ sandboxId: "sb-parent", shared: false }),
        taskIsolation: "none",
      },
    });

    expect(result.success).toBe(true);
    expect(rig.plane.find("sb-parent")?.state).toBe("started");
  });

  it("keeps a dirty sandbox on archive delete: starts it for the check, then stops it and warns", async () => {
    rig.plane.addSandbox({ id: "sb-dirty", state: "stopped" });
    const sshCheck = spyOn(
      SSHRuntime.prototype as unknown as {
        checkWorkspaceDeletable: () => Promise<"ok" | "missing" | { error: string }>;
      },
      "checkWorkspaceDeletable"
    ).mockResolvedValue({ error: "Workspace contains uncommitted changes." });
    // The Daytona check resolves the `~` workspace path on the sandbox first.
    const resolvePath = spyOn(SSHRuntime.prototype, "resolvePath").mockResolvedValue(
      "/home/daytona/src/proj/ws"
    );
    const warnings: string[] = [];
    try {
      const daytona = { sandboxId: "sb-dirty", shared: false };
      const result = await archive(daytona, "delete", runtimeCheck(daytona), (warning) =>
        warnings.push(warning)
      );

      expect(result.success).toBe(true);
      expect(rig.plane.countCalls("POST /sandbox/sb-dirty/start")).toBe(1);
      expect(sshCheck).toHaveBeenCalledTimes(1);
      expect(rig.plane.find("sb-dirty")?.state).toBe("stopped");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("uncommitted changes");
    } finally {
      sshCheck.mockRestore();
      resolvePath.mockRestore();
    }
  });
});
