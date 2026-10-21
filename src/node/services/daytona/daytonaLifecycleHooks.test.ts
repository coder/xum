import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import type { CoderWorkspaceArchiveBehavior } from "@/common/config/coderArchiveBehavior";
import type { DaytonaSandboxConfig } from "@/common/orpc/schemas/daytona";
import { Err, Ok, type Result } from "@/common/types/result";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { DaytonaSSHRuntime } from "@/node/runtime/DaytonaSSHRuntime";
import { SSHRuntime } from "@/node/runtime/SSHRuntime";
import { createSSHTransport } from "@/node/runtime/transports";
import {
  createDaytonaTestRig,
  localShellTransport,
  type DaytonaTestRig,
} from "./daytona.testHarness";
import { createDaytonaArchiveHook, type DaytonaArchiveHookOptions } from "./daytonaLifecycleHooks";
import { listDaytonaWorkspaceRefs } from "./daytonaReconciler";

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

  it("applies the archive policy once the last active workspace on a sandbox is archived", async () => {
    rig.plane.addSandbox({ id: "sb-shared" });
    const owner = {
      workspaceId: "owner",
      runtimeConfig: metadata({ sandboxId: "sb-shared", shared: false }).runtimeConfig,
      archived: false,
    };
    rig.workspaces.push(owner);
    const fork = { sandboxId: "sb-shared", forked: true, shared: false };

    // The owner still works in the sandbox: archiving the fork leaves it running.
    expect((await archive(fork, "stop")).success).toBe(true);
    expect(rig.plane.find("sb-shared")?.state).toBe("started");

    // Archived first, the owner no longer uses it: archiving the fork applies the policy.
    owner.archived = true;
    expect((await archive(fork, "stop")).success).toBe(true);
    expect(rig.plane.find("sb-shared")?.state).toBe("stopped");

    // Delete stops instead: the owner's checkout on it was never checked, and it may come back.
    rig.plane.find("sb-shared")!.state = "started";
    const warnings: string[] = [];
    expect((await archive(fork, "delete", cleanCheck, (w) => warnings.push(w))).success).toBe(true);
    expect(rig.plane.find("sb-shared")?.state).toBe("stopped");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("archived workspace");
  });

  it("leaves a sandbox alone that another workspace attached by its id, or that cannot be looked up", async () => {
    // Created by Xum under a name; the attach picker stored the same sandbox's real id.
    rig.plane.addSandbox({ id: "sb-9", name: "xum-owner-def456" });
    rig.workspaces.push({
      workspaceId: "attached",
      runtimeConfig: metadata({ sandboxId: "sb-9", shared: true }).runtimeConfig,
    });
    const owner = { sandboxId: "xum-owner-def456", shared: false };

    expect((await archive(owner, "delete")).success).toBe(true);
    expect(rig.plane.find("sb-9")?.state).toBe("started");

    // Without the lookup Xum cannot tell: it keeps the sandbox.
    rig.workspaces[0] = {
      workspaceId: "attached",
      runtimeConfig: metadata({ sandboxId: "sb-other", shared: true }).runtimeConfig,
    };
    rig.plane.failingRoutes.add("GET /sandbox/xum-owner-def456");
    expect((await archive(owner, "delete")).success).toBe(true);
    expect(rig.plane.find("sb-9")?.state).toBe("started");
  });

  it("releases an alias no other workspace stores, keeping the sandbox another one uses", async () => {
    // The owner stores the generated name, the attached workspace the real id: ssh access
    // (token, include block, pooled sessions, forwards) is per stored string.
    rig.plane.addSandbox({ id: "sb-9", name: "xum-owner-def456" });
    rig.workspaces.push({
      workspaceId: "attached",
      runtimeConfig: metadata({ sandboxId: "sb-9", shared: true }).runtimeConfig,
    });
    await rig.service.ensureSshAccess("xum-owner-def456"); // tok1
    await rig.service.ensureSshAccess("sb-9");

    expect((await archive({ sandboxId: "xum-owner-def456", shared: false }, "stop")).success).toBe(
      true
    );

    expect(rig.plane.find("sb-9")?.state).toBe("started");
    expect(rig.plane.revokedTokens).toEqual(["tok1"]);
    expect(rig.writer.removed).toEqual(["xum-owner-def456"]);
    expect(rig.service.tokenNeedsRefresh("sb-9")).toBe(false);
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

  it("applies the archive policy to a sandbox whose only other user is a side chat", async () => {
    rig.plane.addSandbox({ id: "sb-main" });
    const daytona = { sandboxId: "sb-main", shared: false };
    // A side chat copies its main chat's runtime config but borrows its checkout.
    const sideChat = {
      id: "side",
      runtimeConfig: metadata(daytona).runtimeConfig,
      taskIsolation: "none" as const,
    };
    rig.workspaces.push(
      ...listDaytonaWorkspaceRefs({
        projects: new Map([["/tmp/proj", { workspaces: [sideChat] }]]),
      })
    );

    expect((await archive(daytona, "stop")).success).toBe(true);

    expect(rig.plane.find("sb-main")?.state).toBe("stopped");
  });

  it("never deletes or stops a sandbox under an unverified job on a model-driven archive delete", async () => {
    const modelArchive = (
      sandboxId: string,
      check: DaytonaArchiveHookOptions["checkSandboxDeletable"],
      probe?: DaytonaArchiveHookOptions["hasUnsettledRemoteBackgroundJobs"]
    ) =>
      createDaytonaArchiveHook({
        daytonaService: rig.service,
        getArchiveBehavior: () => "delete",
        checkSandboxDeletable: check,
        hasUnsettledRemoteBackgroundJobs: probe,
      })({
        workspaceId: "ws",
        workspaceMetadata: metadata({ sandboxId, shared: false }),
        refuseStopUnderUnverifiedRemoteJobs: true,
      });
    const dirtyCheck = (): Promise<Result<void, string>> =>
      Promise.resolve(Err("Workspace contains uncommitted changes."));
    const jobRuns = () => Promise.resolve(Ok(true));
    for (const id of ["sb-job", "sb-job-dirty", "sb-unprobed", "sb-idle"]) {
      rig.plane.addSandbox({ id });
    }

    // A surviving job refuses both outcomes: the delete (clean checks) and the stop (dirty).
    expect((await modelArchive("sb-job", cleanCheck, jobRuns)).success).toBe(false);
    expect((await modelArchive("sb-job-dirty", dirtyCheck, jobRuns)).success).toBe(false);
    // No probe: Xum cannot verify, so it refuses too.
    expect((await modelArchive("sb-unprobed", cleanCheck)).success).toBe(false);
    for (const id of ["sb-job", "sb-job-dirty", "sb-unprobed"]) {
      expect(rig.plane.find(id)?.state).toBe("started");
    }

    // Verified idle: the delete goes ahead.
    const idle = () => Promise.resolve(Ok(false));
    expect((await modelArchive("sb-idle", cleanCheck, idle)).success).toBe(true);
    expect(rig.plane.find("sb-idle")).toBeUndefined();
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

  it("keeps a sandbox whose only unsaved work is an untracked file on archive delete", async () => {
    rig.plane.addSandbox({ id: "sb-untracked" });
    const daytona = { sandboxId: "sb-untracked", shared: false };
    const config = { host: "x.xum--daytona", srcBaseDir: "~/src", daytona };
    // Real git in a local "sandbox": a clean, committed checkout plus one new file.
    const runtime = new DaytonaSSHRuntime(config, localShellTransport(rig.rootDir), rig.service);
    const checkout = runtime.getWorkspacePath("/tmp/proj", "ws").replace(/^~/, rig.rootDir);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", checkout, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    await fs.mkdir(checkout, { recursive: true });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "init");
    await fs.writeFile(`${checkout}/notes.md`, "not committed yet\n");
    const warnings: string[] = [];

    const result = await archive(
      daytona,
      "delete",
      (workspaceMetadata) =>
        runtime.checkSandboxDeletable(workspaceMetadata.projectPath, workspaceMetadata.name, true),
      (warning) => warnings.push(warning)
    );

    expect(result.success).toBe(true);
    expect(rig.plane.find("sb-untracked")?.state).toBe("stopped");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("untracked");
  });
});
