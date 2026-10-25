import { afterEach, beforeEach, describe, expect, it, spyOn, type Mock } from "bun:test";
import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import type { DaytonaSandboxConfig } from "@/common/orpc/schemas/daytona";
import type { RuntimeConfig } from "@/common/types/runtime";
import {
  createDaytonaTestRig,
  localShellTransport,
  type DaytonaTestRig,
} from "@/node/services/daytona/daytona.testHarness";
import { DAYTONA_READY_CACHE_MS } from "@/node/services/daytona/daytonaReadiness";
import * as runtimeHelpers from "@/node/utils/runtime/helpers";
import { DaytonaSSHRuntime } from "./DaytonaSSHRuntime";
import type { InitLogger, RuntimeStatusEvent, WorkspaceInitParams } from "./Runtime";
import { RuntimeError } from "./Runtime";
import { SSHRuntime } from "./SSHRuntime";
import { DAYTONA_TOKEN_PLACEHOLDER } from "./daytonaTokenRedaction";
import { createSSHTransport, type SSHTransport } from "./transports";

let rig: DaytonaTestRig;
let execSpy: Mock<typeof runtimeHelpers.execBuffered>;

beforeEach(async () => {
  rig = await createDaytonaTestRig();
  execSpy = spyOn(runtimeHelpers, "execBuffered").mockResolvedValue({
    stdout: "",
    stderr: "",
    exitCode: 0,
    duration: 0,
  });
});

afterEach(async () => {
  execSpy.mockRestore();
  await rig.cleanup();
});

function makeRuntime(
  daytona: DaytonaSandboxConfig,
  testRig = rig,
  options: {
    workspaceId?: string;
    transport?: SSHTransport;
    /** Both set: ensureReady also checks this workspace's checkout. */
    projectPath?: string;
    workspaceName?: string;
  } = {}
): DaytonaSSHRuntime {
  const config = { host: "placeholder.xum--daytona", srcBaseDir: "~/src", daytona };
  const transport = options.transport ?? createSSHTransport(config, false);
  return new DaytonaSSHRuntime(config, transport, testRig.service, {
    workspaceId: options.workspaceId ?? "ws-1",
    projectPath: options.projectPath,
    workspaceName: options.workspaceName,
  });
}

function sshDaytonaConfig(daytona: DaytonaSandboxConfig): RuntimeConfig {
  return { type: "ssh", host: "placeholder.xum--daytona", srcBaseDir: "~/src", daytona };
}

function initParams(): WorkspaceInitParams & { log: string[] } {
  const logLines: string[] = [];
  const initLogger: InitLogger = {
    logStep: (line) => logLines.push(line),
    logStdout: (line) => logLines.push(line),
    logStderr: (line) => logLines.push(line),
    logComplete: () => undefined,
  };
  return {
    projectPath: "/home/me/project",
    branchName: "feature",
    trunkBranch: "main",
    workspacePath: "~/src/project/feature",
    initLogger,
    log: logLines,
  };
}

const SMALL = { cpu: 2, memoryGiB: 4, diskGiB: 10 };

describe("DaytonaSSHRuntime.ensureReady", () => {
  it("trusts a ready result for 60 s across runtime instances, then checks again", async () => {
    rig.plane.addSandbox({ id: "sb-ready" });
    expect(await makeRuntime({ sandboxId: "sb-ready" }).ensureReady()).toEqual({ ready: true });
    const getsAfterFirst = rig.plane.countCalls("GET /sandbox/sb-ready");

    // A stream start builds a fresh runtime; it must not hit the control plane again.
    expect(await makeRuntime({ sandboxId: "sb-ready" }).ensureReady()).toEqual({ ready: true });
    expect(rig.plane.countCalls("GET /sandbox/sb-ready")).toBe(getsAfterFirst);

    rig.clock.now += DAYTONA_READY_CACHE_MS;
    await makeRuntime({ sandboxId: "sb-ready" }).ensureReady();
    expect(rig.plane.countCalls("GET /sandbox/sb-ready")).toBeGreaterThan(getsAfterFirst);
  });

  it("puts back the ~/.ssh/config block for an external ssh client within the ready cache", async () => {
    rig.plane.addSandbox({ id: "sb-ready" });
    expect(await makeRuntime({ sandboxId: "sb-ready" }).ensureReady()).toEqual({ ready: true });
    rig.writer.managedBlockPresent = false;

    // Xum's own commands read only daytona.conf: a cached check leaves the block alone.
    expect(await makeRuntime({ sandboxId: "sb-ready" }).ensureReady()).toEqual({ ready: true });
    expect(rig.writer.managedBlockPresent).toBe(false);

    const forEditor = await makeRuntime({ sandboxId: "sb-ready" }).ensureReady({
      externalSshClient: true,
    });
    expect(forEditor).toEqual({ ready: true });
    expect(rig.writer.managedBlockPresent).toBe(true);
  });

  it("checks each workspace's checkout while their shared sandbox is cached as ready", async () => {
    execSpy.mockRestore();
    rig.plane.addSandbox({ id: "sb-shared" });
    const runtimeFor = (workspaceName: string) =>
      makeRuntime({ sandboxId: "sb-shared" }, rig, {
        transport: localShellTransport(rig.rootDir),
        projectPath: "/home/me/project",
        workspaceName,
      });
    const checkout = runtimeFor("ws-a").getWorkspacePath("/home/me/project", "ws-a");
    execFileSync("git", ["init", "-q", checkout.replace(/^~/, rig.rootDir)]);

    expect(await runtimeFor("ws-a").ensureReady()).toEqual({ ready: true });
    // A fork on the same sandbox whose checkout is gone, within the ready cache.
    const fork = await runtimeFor("ws-b").ensureReady();

    expect(fork.ready).toBe(false);
    if (!fork.ready) expect(fork.error).toContain("repository not found");
  });

  it("starts a stopped sandbox, reports it in the status sink, and writes the ssh token", async () => {
    rig.plane.addSandbox({ id: "sb-stopped", state: "stopped" });
    const events: RuntimeStatusEvent[] = [];

    const result = await makeRuntime({ sandboxId: "sb-stopped" }).ensureReady({
      statusSink: (event) => events.push(event),
    });

    expect(result).toEqual({ ready: true });
    expect(rig.plane.countCalls("POST /sandbox/sb-stopped/start")).toBe(1);
    expect(events.map((event) => event.phase)).toContain("starting");
    expect(events.at(-1)?.phase).toBe("ready");
    expect(rig.writer.tokens.get("sb-stopped")).toBeDefined();
  });

  it("shares one start between concurrent checks", async () => {
    rig.plane.addSandbox({ id: "sb-archived", state: "archived" });
    const phases: string[][] = [[], []];
    const results = await Promise.all(
      phases.map((seen) =>
        makeRuntime({ sandboxId: "sb-archived" }).ensureReady({
          statusSink: (event) => seen.push(event.phase),
        })
      )
    );
    expect(results).toEqual([{ ready: true }, { ready: true }]);
    // The second check joins the first one's start; only the first reports it.
    expect(phases.map((seen) => seen.includes("starting"))).toEqual([true, false]);
    expect(rig.plane.countCalls("POST /sandbox/sb-archived/start")).toBe(1);
    expect(rig.plane.countCalls("POST /sandbox/sb-archived/ssh-access")).toBe(1);
  });

  it("reports a sandbox removed outside Xum as runtime_not_ready and never recreates it", async () => {
    const result = await makeRuntime({ sandboxId: "sb-gone" }).ensureReady();

    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.errorType).toBe("runtime_not_ready");
      expect(result.error).toContain("no longer exists");
    }
    expect(rig.plane.countCalls("POST /sandbox")).toBe(0);
  });
});

describe("DaytonaSSHRuntime integrated terminals", () => {
  it("start a stopped sandbox before the terminal's ssh session opens", async () => {
    const sandbox = rig.plane.addSandbox({ id: "sb-term", state: "stopped" });
    let stateWhenOpened: string | undefined;
    const runtime = makeRuntime({ sandboxId: "sb-term" }, rig, {
      transport: {
        ...localShellTransport(rig.rootDir),
        createPtySession: () => {
          stateWhenOpened = sandbox.state;
          return Promise.resolve({} as Awaited<ReturnType<SSHTransport["createPtySession"]>>);
        },
      },
    });

    await runtime.createPtySession({ workspacePath: "~/src/project/feature", cols: 80, rows: 24 });

    expect(rig.plane.countCalls("POST /sandbox/sb-term/start")).toBe(1);
    expect(stateWhenOpened).toBe("started");
  });

  it("report a sandbox that cannot be brought up instead of opening ssh", async () => {
    let opened = false;
    const runtime = makeRuntime({ sandboxId: "sb-gone" }, rig, {
      transport: {
        ...localShellTransport(rig.rootDir),
        createPtySession: () => {
          opened = true;
          return Promise.resolve({} as Awaited<ReturnType<SSHTransport["createPtySession"]>>);
        },
      },
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      runtime.createPtySession({ workspacePath: "~/src/project/feature", cols: 80, rows: 24 })
    ).rejects.toThrow("no longer exists");
    expect(opened).toBe(false);
  });
});

describe("DaytonaSSHRuntime.finalizeConfig and validateBeforePersist", () => {
  it("names a new sandbox before persist and fills the default size", async () => {
    const runtime = makeRuntime({});
    const result = await runtime.finalizeConfig("Feature_X", sshDaytonaConfig({}));
    expect(result.success).toBe(true);
    if (!result.success || result.data.type !== "ssh") throw new Error("expected ssh config");
    const sandboxId = result.data.daytona?.sandboxId ?? "";
    expect(sandboxId).toMatch(/^xum-feature-x-[0-9a-f]{6}$/);
    expect(result.data.host).toBe(`${sandboxId}.xum--daytona`);
    expect(result.data.daytona).toMatchObject({ ...SMALL });
    expect(await runtime.validateBeforePersist("Feature_X", result.data)).toEqual({
      success: true,
      data: undefined,
    });
  });

  it("creates a new sandbox even when the creation request names an existing one", async () => {
    rig.plane.addSandbox({ id: "sb-mine" });
    const runtime = makeRuntime({});
    const result = await runtime.finalizeConfig(
      "b",
      sshDaytonaConfig({ sandboxId: "sb-mine", forked: true })
    );
    if (!result.success || result.data.type !== "ssh") throw new Error("expected ssh config");
    expect(result.data.daytona?.sandboxId).toMatch(/^xum-b-[0-9a-f]{6}$/);
    expect(result.data.daytona?.forked).toBeUndefined();
  });

  it("rejects missing credentials, non-preset sizes and taken names", async () => {
    const noKey = await createDaytonaTestRig({ apiKey: null });
    try {
      const result = await makeRuntime({}, noKey).finalizeConfig("b", sshDaytonaConfig({}));
      expect(result.success).toBe(false);
    } finally {
      await noKey.cleanup();
    }

    const runtime = makeRuntime({});
    const odd = await runtime.finalizeConfig("b", sshDaytonaConfig({ cpu: 3 }));
    expect(odd.success).toBe(false);
    const handEdited = sshDaytonaConfig({ sandboxId: "xum-b-1", cpu: 64 });
    expect((await runtime.validateBeforePersist("b", handEdited)).success).toBe(false);

    rig.plane.addSandbox({ id: "sb-9", name: "xum-b-taken" });
    const taken = sshDaytonaConfig({ sandboxId: "xum-b-taken", ...SMALL });
    expect((await runtime.validateBeforePersist("b", taken)).success).toBe(false);
  });
});

describe("DaytonaSSHRuntime Windows and GPU sandboxes", () => {
  // Xum provisions over ssh with POSIX commands; a Windows sandbox runs cmd.exe or PowerShell.
  // Daytona deletes a GPU sandbox when it stops, and Xum lets workspaces auto-stop.
  async function validate(daytona: DaytonaSandboxConfig) {
    rig.plane.snapshots.push(
      { name: "windows-small", sandboxClass: "windows" },
      { name: "daytona-gpu", sandboxClass: "linux-vm", gpu: 1 },
      { name: "daytona-small", sandboxClass: "container" },
      // A general snapshot may come only with the list, not by name.
      { name: "general-small", sandboxClass: "container", listedOnly: true },
      { name: "default-snap", sandboxClass: "windows" }
    );
    rig.plane.defaultSnapshot = "default-snap";
    const runtime = makeRuntime({});
    const finalized = await runtime.finalizeConfig("b", sshDaytonaConfig(daytona));
    const result = finalized.success
      ? await runtime.validateBeforePersist("b", finalized.data)
      : finalized;
    expect(rig.plane.countCalls("POST /sandbox")).toBe(0);
    return result.success ? "ok" : result.error;
  }

  it.each([
    ["a Windows snapshot", { snapshot: "windows-small" }, '"windows-small" creates Windows'],
    ["a GPU snapshot", { snapshot: "daytona-gpu" }, '"daytona-gpu" creates GPU'],
    // A stale project default: deleted after it was saved.
    ["a deleted snapshot", { snapshot: "deleted-snapshot" }, '"deleted-snapshot" was not found'],
    ["a Windows deployment default", {}, '"default-snap" creates Windows'],
  ])("refuses %s before persisting", async (_case, daytona, error) => {
    expect(await validate(daytona)).toContain(error);
  });

  it.each(["daytona-small", "general-small"])("accepts the Linux snapshot %s", async (snapshot) => {
    expect(await validate({ snapshot })).toBe("ok");
  });

  it("offers neither Windows nor GPU snapshots", async () => {
    rig.plane.snapshots.push(
      { name: "windows-small", sandboxClass: "windows" },
      { name: "daytona-gpu", sandboxClass: "linux-vm", gpu: 1 },
      { name: "daytona-small", sandboxClass: "container" },
      { name: "older" }
    );

    const snapshots = await rig.service.account.listSnapshots();

    expect(snapshots.ok && snapshots.snapshots.map((s) => s.name)).toEqual([
      "daytona-small",
      "older",
    ]);
  });
});

describe("DaytonaSSHRuntime.postCreateSetup", () => {
  // The save finishes (and drops the old account's ssh access) while the create is in flight.
  it("fails a setup, and undoes it in the old account, when the settings change during the create", async () => {
    rig.plane.onRequest.set("POST /sandbox", () =>
      rig.service.account.setConfig({ apiKey: "key-b" })
    );

    const failure = await makeRuntime({ sandboxId: "xum-switch", ...SMALL })
      .postCreateSetup(initParams())
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(String(failure)).toContain("settings changed during setup");
    const createAt = rig.plane.authorizedCalls.findIndex((call) =>
      call.startsWith("POST /sandbox ")
    );
    // GET /config is public and sends no key.
    const afterCreate = rig.plane.authorizedCalls
      .slice(createAt)
      .filter((c) => c.includes("Bearer"));
    expect(afterCreate.filter((call) => !call.endsWith("Bearer test-key"))).toEqual([]);
    expect(rig.plane.find("xum-switch")).toBeUndefined();
    expect(rig.writer.tokens.get("xum-switch")).toBeUndefined();
    expect((await rig.service.account.getClient()).credentials.apiKey).toBe("key-b");
  });

  it("fails a fork's setup, and drops the ssh access it wrote, when the settings change during it", async () => {
    rig.plane.addSandbox({ id: "sb-src" });
    rig.plane.onRequest.set("GET /sandbox/sb-src", () => {
      rig.plane.onRequest.delete("GET /sandbox/sb-src");
      return rig.service.account.setConfig({ apiKey: "key-b" });
    });

    const failure = await makeRuntime({ sandboxId: "sb-src", forked: true, ...SMALL })
      .postCreateSetup(initParams())
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(String(failure)).toContain("settings changed during setup");
    expect(rig.plane.find("sb-src")).toBeDefined();
    expect(rig.writer.tokens.get("sb-src")).toBeUndefined();
    expect(rig.plane.revokedTokens).toHaveLength(1);
  });

  it("creates the sandbox with preset resources, labels and lifecycle intervals", async () => {
    await makeRuntime({ sandboxId: "xum-new", ...SMALL }).postCreateSetup(initParams());

    expect(rig.plane.createBodies).toHaveLength(1);
    expect(rig.plane.createBodies[0]).toMatchObject({
      name: "xum-new",
      cpu: 2,
      memory: 4,
      disk: 10,
      autoStopInterval: 30,
      autoArchiveInterval: 1440,
      autoDeleteInterval: -1,
      labels: { "xum.workspaceId": "ws-1", "xum.project": "project" },
    });
    expect(rig.plane.find("xum-new")?.state).toBe("started");
    expect(rig.writer.tokens.get("xum-new")).toBeDefined();
  });

  // Daytona rejects resources for a snapshot with fixed ones: create, then resize to the preset.
  it.each([
    ["the snapshot's size is reported", {}, { cpu: 1, memory: 1, disk: 3 }, 20],
    // Sending the preset disk would shrink an unreported larger disk.
    ["the disk is not reported", { omitDisk: true }, { cpu: 1, memory: 1, disk: 30 }, 30],
    // Above the preset: only a stopped sandbox may shrink.
    [
      "cpu and memory are not reported",
      { omitCompute: true },
      { cpu: 8, memory: 16, disk: 30 },
      30,
    ],
  ])(
    "creates a fixed-size snapshot, then resizes it to the preset when %s",
    async (_case, omit, snapshotResources, disk) => {
      Object.assign(rig.plane, { rejectCreateResources: true, snapshotResources, ...omit });

      await makeRuntime({
        sandboxId: "xum-fixed",
        snapshot: "fixed-snap",
        cpu: 4,
        memoryGiB: 8,
        diskGiB: 20,
      }).postCreateSetup(initParams());

      expect(rig.plane.createBodies).toHaveLength(2);
      expect(rig.plane.createBodies[1].cpu).toBeUndefined();
      expect(rig.plane.find("xum-fixed")).toMatchObject({
        state: "started",
        cpu: 4,
        memory: 8,
        disk,
      });
    }
  );

  it("deletes the sandbox it created when setup fails afterwards", async () => {
    rig.writer.writeError = new Error("No space left on device");
    const params = initParams();

    const failure = await makeRuntime({ sandboxId: "xum-doomed", ...SMALL })
      .postCreateSetup(params)
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("No space left on device");

    expect(rig.plane.countCalls("POST /sandbox")).toBe(1);
    expect(rig.plane.find("xum-doomed")).toBeUndefined();
  });

  it("keeps a sandbox its failed setup could not delete for the workspace removal to delete", async () => {
    const sshDelete = spyOn(SSHRuntime.prototype, "deleteWorkspace").mockResolvedValue({
      success: true,
      deletedPath: "/path",
    });
    try {
      // A setup error that persists blocks the removal's checks, so only a forced one goes.
      for (const [sandboxId, force] of [
        ["xum-transient", false],
        ["xum-persistent", true],
      ] as const) {
        rig.writer.writeError = new Error("No space left on device");
        rig.plane.failingRoutes.add(`DELETE /sandbox/${sandboxId}`);
        const daytona = { sandboxId, ...SMALL };

        // eslint-disable-next-line @typescript-eslint/await-thenable
        await expect(makeRuntime(daytona).postCreateSetup(initParams())).rejects.toThrow(
          "setup failed"
        );
        expect(rig.plane.find(sandboxId)).toBeDefined();

        // The persisted workspace still names the sandbox; removing it deletes the sandbox.
        rig.plane.failingRoutes.clear();
        if (!force) rig.writer.writeError = undefined;
        const removal = await makeRuntime(daytona).deleteWorkspace(
          "/home/me/project",
          "feature",
          force
        );
        expect(removal.success).toBe(true);
        expect(rig.plane.find(sandboxId)).toBeUndefined();
      }
    } finally {
      sshDelete.mockRestore();
    }
  });

  it("never deletes a sandbox that took its name before the create request", async () => {
    // Another Xum install created this name between validateBeforePersist and the create.
    const other = rig.plane.addSandbox({
      id: "sb-other",
      name: "xum-raced",
      labels: { "xum.instance": "another-install", "xum.workspaceId": "ws-other" },
    });

    const failure = await makeRuntime({ sandboxId: "xum-raced", ...SMALL })
      .postCreateSetup(initParams())
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(String(failure)).toContain("already exists");
    expect(rig.plane.calls.filter((call) => call.startsWith("DELETE /sandbox/"))).toEqual([]);
    expect(rig.plane.find("xum-raced")).toBe(other);
  });

  it("after a create of unknown outcome, deletes the sandbox only when it has its labels", async () => {
    const setUp = (sandboxId: string) =>
      makeRuntime({ sandboxId, ...SMALL })
        .postCreateSetup(initParams())
        .then(
          () => undefined,
          (error: unknown) => error
        );

    // The create went through, but the answer was a 500: the sandbox is this setup's.
    rig.plane.failAfterCreate = true;
    expect(String(await setUp("xum-maybe"))).toContain("HTTP 500");
    expect(rig.plane.find("xum-maybe")).toBeUndefined();

    // A 500 without a create, while another install holds the name: keep that sandbox.
    rig.plane.failAfterCreate = false;
    rig.plane.failingRoutes.add("POST /sandbox");
    const other = rig.plane.addSandbox({
      id: "sb-other",
      name: "xum-theirs",
      labels: { "xum.instance": "another-install", "xum.workspaceId": "ws-1" },
    });
    expect(String(await setUp("xum-theirs"))).toContain("HTTP 500");
    expect(rig.plane.find("xum-theirs")).toBe(other);
  });
});

describe("DaytonaSSHRuntime.deleteWorkspace", () => {
  let sshDeleteSpy: Mock<typeof SSHRuntime.prototype.deleteWorkspace>;

  beforeEach(() => {
    sshDeleteSpy = spyOn(SSHRuntime.prototype, "deleteWorkspace").mockResolvedValue({
      success: true,
      deletedPath: "/path",
    });
  });

  afterEach(() => {
    sshDeleteSpy.mockRestore();
  });

  it("keeps the sandbox when a fork's forced removal cannot delete its checkout", async () => {
    rig.plane.addSandbox({ id: "sb-1" });
    await rig.service.ssh.ensureSshAccess("sb-1");
    sshDeleteSpy.mockResolvedValue({ success: false, error: "ssh: host unreachable" });

    const forced = await makeRuntime({ sandboxId: "sb-1", forked: true }, rig, {
      workspaceId: "ws-fork",
    }).deleteWorkspace("/home/me/project", "ws-fork", true);

    expect(forced.success).toBe(true);
    expect(rig.plane.find("sb-1")?.state).toBe("started");
    // The workspace that created the sandbox still uses Xum's access to it.
    expect(rig.writer.removed).not.toContain("sb-1");
  });

  it("runs the dirty check on a running sandbox and keeps a dirty workspace", async () => {
    rig.plane.addSandbox({ id: "sb-dirty" });
    sshDeleteSpy.mockResolvedValue({ success: false, error: "uncommitted changes" });

    const result = await makeRuntime({ sandboxId: "sb-dirty" }).deleteWorkspace(
      "/home/me/project",
      "feature",
      false
    );

    expect(result).toEqual({ success: false, error: "uncommitted changes" });
    expect(rig.plane.find("sb-dirty")).toBeDefined();
  });

  it("deletes an owned sandbox after a clean check and drops its ssh access", async () => {
    rig.plane.addSandbox({ id: "sb-clean" });
    await rig.service.ssh.ensureSshAccess("sb-clean");

    const result = await makeRuntime({ sandboxId: "sb-clean" }).deleteWorkspace(
      "/home/me/project",
      "feature",
      false
    );

    expect(result.success).toBe(true);
    expect(sshDeleteSpy).toHaveBeenCalledTimes(1);
    expect(rig.plane.find("sb-clean")).toBeUndefined();
    expect(rig.writer.removed).toContain("sb-clean");
    expect(rig.plane.revokedTokens).toHaveLength(1);
  });

  it("never starts a stopped or archived sandbox for removal checks, as for Coder", async () => {
    for (const state of ["stopped", "archived"]) {
      const sandboxId = `sb-${state}`;
      rig.plane.addSandbox({ id: sandboxId, state });

      const fork = await makeRuntime({ sandboxId, forked: true }).deleteWorkspace(
        "/home/me/project",
        "feature-fork",
        false
      );
      expect(fork.success).toBe(true);
      expect(rig.plane.find(sandboxId)?.state).toBe(state);

      const owner = await makeRuntime({ sandboxId }).deleteWorkspace(
        "/home/me/project",
        "feature",
        false
      );
      expect(owner.success).toBe(true);
      expect(rig.plane.find(sandboxId)).toBeUndefined();
      expect(rig.plane.countCalls(`POST /sandbox/${sandboxId}/start`)).toBe(0);
    }
    expect(sshDeleteSpy).not.toHaveBeenCalled();
  });

  it("keeps the sandbox when a fork is removed, deletes it with the workspace that created it", async () => {
    rig.plane.addSandbox({ id: "sb-parent" });
    const forkSpy = spyOn(SSHRuntime.prototype, "forkWorkspace").mockResolvedValue({
      success: true,
      workspacePath: "/fork",
    });
    try {
      const sourceDaytona = { sandboxId: "sb-parent", ...SMALL };
      const fork = await makeRuntime(sourceDaytona).forkWorkspace({
        projectPath: "/home/me/project",
        sourceWorkspaceName: "feature",
        newWorkspaceName: "feature-fork",
        initLogger: initParams().initLogger,
      });
      const forkDaytona =
        fork.forkedRuntimeConfig?.type === "ssh" ? fork.forkedRuntimeConfig.daytona : undefined;
      if (!forkDaytona) throw new Error("expected a Daytona fork config");
      expect(fork.sourceRuntimeConfig).toBeUndefined();

      // The fork's setup (a fresh runtime from its config) connects; it creates nothing.
      await makeRuntime(forkDaytona, rig, { workspaceId: "ws-fork" }).postCreateSetup(initParams());
      expect(rig.plane.countCalls("POST /sandbox")).toBe(0);

      const deleteFork = makeRuntime(forkDaytona, rig, { workspaceId: "ws-fork" });
      expect(
        (await deleteFork.deleteWorkspace("/home/me/project", "feature-fork", false)).success
      ).toBe(true);
      expect(rig.plane.find("sb-parent")).toBeDefined();
      expect(rig.writer.removed).not.toContain("sb-parent");

      const deleteSource = makeRuntime(sourceDaytona);
      expect(
        (await deleteSource.deleteWorkspace("/home/me/project", "feature", false)).success
      ).toBe(true);
      expect(rig.plane.find("sb-parent")).toBeUndefined();
      expect(rig.writer.removed).toContain("sb-parent");
    } finally {
      forkSpy.mockRestore();
    }
  });

  it("starts a stopped source sandbox before forking, and fails a fork it cannot bring up", async () => {
    const sandbox = rig.plane.addSandbox({ id: "sb-parent", state: "stopped" });
    let stateWhenForked: string | undefined;
    const forkSpy = spyOn(SSHRuntime.prototype, "forkWorkspace").mockImplementation(() => {
      stateWhenForked = sandbox.state;
      return Promise.resolve({ success: true, workspacePath: "/fork" });
    });
    const forkFrom = (sandboxId: string) =>
      makeRuntime({ sandboxId, ...SMALL }).forkWorkspace({
        projectPath: "/home/me/project",
        sourceWorkspaceName: "feature",
        newWorkspaceName: "feature-fork",
        initLogger: initParams().initLogger,
      });
    try {
      expect((await forkFrom("sb-parent")).success).toBe(true);
      expect(stateWhenForked).toBe("started");

      const gone = await forkFrom("sb-gone");
      expect(gone).toMatchObject({ success: false, failureIsFatal: true });
      expect(gone.error).toContain("no longer exists");
      expect(forkSpy).toHaveBeenCalledTimes(1);
    } finally {
      forkSpy.mockRestore();
    }
  });

  it("deletes the sandbox with its source while a fork remains, then removes the fork", async () => {
    rig.plane.addSandbox({ id: "sb-parent" });
    const forkSpy = spyOn(SSHRuntime.prototype, "forkWorkspace").mockResolvedValue({
      success: true,
      workspacePath: "/fork",
    });
    try {
      const sourceDaytona = { sandboxId: "sb-parent", ...SMALL };
      const fork = await makeRuntime(sourceDaytona).forkWorkspace({
        projectPath: "/home/me/project",
        sourceWorkspaceName: "feature",
        newWorkspaceName: "feature-fork",
        initLogger: initParams().initLogger,
      });
      const forkDaytona =
        fork.forkedRuntimeConfig?.type === "ssh" ? fork.forkedRuntimeConfig.daytona : undefined;
      if (!forkDaytona) throw new Error("expected a Daytona fork config");

      const deleteSource = makeRuntime(sourceDaytona);
      expect(
        (await deleteSource.deleteWorkspace("/home/me/project", "feature", false)).success
      ).toBe(true);
      expect(rig.plane.find("sb-parent")).toBeUndefined();
      const sshDeletes = sshDeleteSpy.mock.calls.length;

      const deleteFork = makeRuntime(forkDaytona, rig, { workspaceId: "ws-fork" });
      expect(
        (await deleteFork.deleteWorkspace("/home/me/project", "feature-fork", false)).success
      ).toBe(true);
      // Nothing is left to check on a sandbox that is gone.
      expect(sshDeleteSpy.mock.calls.length).toBe(sshDeletes);
    } finally {
      forkSpy.mockRestore();
    }
  });

  it("names the sandbox left behind when a forced delete cannot delete it", async () => {
    rig.plane.addSandbox({ id: "sb-stuck" });
    rig.plane.failingRoutes.add("DELETE /sandbox/sb-stuck");

    const result = await makeRuntime({ sandboxId: "sb-stuck" }).deleteWorkspace(
      "/home/me/project",
      "feature",
      true
    );

    expect(result).toMatchObject({ success: false, leftoverPaths: ['Daytona sandbox "sb-stuck"'] });
  });
});

describe("DaytonaSSHRuntime delete checks on the unresolved ~ workspace path", () => {
  it("refuses to delete a dirty worktree under ~/... and keeps the sandbox", async () => {
    execSpy.mockRestore();
    const home = path.join(rig.rootDir, "sandbox-home");
    rig.plane.addSandbox({ id: "sb-dirty" });
    const runtime = makeRuntime({ sandboxId: "sb-dirty" }, rig, {
      transport: localShellTransport(home),
    });
    // Deferred access never resolves `~` at creation, so this is the path deletion sees.
    const workspacePath = runtime.getWorkspacePath("/home/me/project", "feature");
    expect(workspacePath.startsWith("~/")).toBe(true);
    const checkout = path.join(home, workspacePath.slice(2));
    await fs.mkdir(checkout, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd: checkout,
      });
    git("init", "-q", "-b", "main");
    await fs.writeFile(path.join(checkout, "a.txt"), "a\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    await fs.writeFile(path.join(checkout, "a.txt"), "uncommitted\n");

    const result = await runtime.deleteWorkspace("/home/me/project", "feature", false);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("uncommitted changes");
    expect(rig.plane.find("sb-dirty")).toBeDefined();
  });
});

describe("DaytonaSSHRuntime ssh token redaction", () => {
  it("keeps the token (the ssh user name) out of command stderr", async () => {
    execSpy.mockRestore();
    rig.plane.addSandbox({ id: "sb-tok" });
    await rig.service.ssh.ensureSshAccess("sb-tok");
    const token = rig.writer.tokens.get("sb-tok");
    if (!token) throw new Error("expected a minted token");
    const runtime = makeRuntime({ sandboxId: "sb-tok" }, rig, {
      transport: localShellTransport(rig.rootDir),
    });

    // OpenSSH's message, in one write.
    const result = await runtimeHelpers.execBuffered(
      runtime,
      `printf '%s@127.0.0.1: Permission denied (publickey).\\n' '${token}' >&2; exit 255`,
      { cwd: "/tmp", timeout: 10 }
    );
    expect(result.stderr).not.toContain(token);
    expect(result.stderr).toContain(`${DAYTONA_TOKEN_PLACEHOLDER}@127.0.0.1: Permission denied`);
  });
  it("keeps the token out of the error of a failed retry", async () => {
    rig.plane.addSandbox({ id: "sb-tok" });
    await rig.service.ssh.ensureSshAccess("sb-tok");
    const token = rig.writer.tokens.get("sb-tok");
    if (!token) throw new Error("expected a minted token");
    let spawns = 0;
    const runtime = makeRuntime({ sandboxId: "sb-tok" }, rig, {
      transport: {
        ...localShellTransport(rig.rootDir),
        spawnRemoteProcess: () => {
          spawns++;
          return Promise.reject(
            new RuntimeError(`Connection closed by user ${token} 127.0.0.1 port 22`, "network")
          );
        },
      },
    });

    const error = await runtime.exec("true", { cwd: "/tmp", timeout: 10 }).then(
      () => new Error("exec unexpectedly succeeded"),
      (rejection: unknown) => rejection
    );
    expect(spawns).toBe(2);
    expect(String(error)).not.toContain(token);
    expect(String(error)).toContain(DAYTONA_TOKEN_PLACEHOLDER);
  });

  it("runs no ssh command before the include file's tokens are loaded, retrying a failed load", async () => {
    const stale = "earlier-process-token-unloaded-9c1d";
    rig.plane.addSandbox({ id: "sb-old" });
    rig.writer.tokens.set("sb-old", stale);
    const readTokens = spyOn(rig.writer, "readTokens").mockRejectedValueOnce(
      new Error("EIO: i/o error, read")
    );
    // Startup goes on without them.
    let startupLoad: unknown;
    await rig.service.ssh.loadPersistedTokens().catch((error: unknown) => (startupLoad = error));
    expect(startupLoad).toBeInstanceOf(Error);

    let readsWhenSpawned: number | undefined;
    // A UI runtime: its commands never run ensureReady first.
    const runtime = makeRuntime({ sandboxId: "sb-old" }, rig, {
      transport: {
        ...localShellTransport(rig.rootDir),
        spawnRemoteProcess: () => {
          readsWhenSpawned ??= readTokens.mock.calls.length;
          return Promise.reject(
            new RuntimeError(`${stale}@127.0.0.1: Permission denied (publickey).`, "network")
          );
        },
      },
    });

    const error = await runtime.exec("true", { cwd: "/tmp", timeout: 10 }).then(
      () => new Error("exec unexpectedly succeeded"),
      (rejection: unknown) => rejection
    );
    expect(readsWhenSpawned).toBe(2);
    expect(String(error)).not.toContain(stale);
    expect(String(error)).toContain(`${DAYTONA_TOKEN_PLACEHOLDER}@127.0.0.1: Permission denied`);
  });
});

describe("DaytonaSSHRuntime reconnect after a stop", () => {
  it("restarts a sandbox that stopped within the ready cache and retries the command once", async () => {
    const sandbox = rig.plane.addSandbox({ id: "sb-nap" });
    const local = localShellTransport(rig.rootDir);
    const transport: SSHTransport = {
      ...local,
      spawnRemoteProcess: (command, options) =>
        sandbox.state === "started"
          ? local.spawnRemoteProcess(command, options)
          : Promise.reject(new RuntimeError("Connection closed by 127.0.0.1 port 22", "network")),
    };
    const turn = makeRuntime({ sandboxId: "sb-nap" }, rig, { transport });
    expect(await turn.ensureReady()).toEqual({ ready: true });
    sandbox.state = "stopped";

    // A UI or background runtime never starts the (billed) sandbox.
    const background = makeRuntime({ sandboxId: "sb-nap" }, rig, { transport });
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(background.exec("echo ok", { cwd: "/tmp", timeout: 10 })).rejects.toThrow(
      "Connection closed"
    );
    expect(rig.plane.countCalls("POST /sandbox/sb-nap/start")).toBe(0);

    const stream = await turn.exec("echo ok", { cwd: "/tmp", timeout: 10 });
    expect(await new Response(stream.stdout).text()).toBe("ok\n");
    expect(await stream.exitCode).toBe(0);
    expect(rig.plane.countCalls("POST /sandbox/sb-nap/start")).toBe(1);
  });

  it("starts a sandbox that stopped within the ready cache for a new runtime's ensureReady", async () => {
    execSpy.mockRestore();
    const sandbox = rig.plane.addSandbox({ id: "sb-nap3" });
    const local = localShellTransport(rig.rootDir);
    const transport: SSHTransport = {
      ...local,
      spawnRemoteProcess: (command, options) =>
        sandbox.state === "started"
          ? local.spawnRemoteProcess(command, options)
          : Promise.reject(new RuntimeError("Connection closed by 127.0.0.1 port 22", "network")),
    };
    const runtimeFor = () =>
      makeRuntime({ sandboxId: "sb-nap3" }, rig, {
        transport,
        projectPath: "/home/me/project",
        workspaceName: "ws-a",
      });
    const checkout = runtimeFor().getWorkspacePath("/home/me/project", "ws-a");
    execFileSync("git", ["init", "-q", checkout.replace(/^~/, rig.rootDir)]);
    expect(await runtimeFor().ensureReady()).toEqual({ ready: true });
    sandbox.state = "stopped";

    // The next turn or terminal builds a fresh runtime, still within the ready cache.
    expect(await runtimeFor().ensureReady()).toEqual({ ready: true });
    expect(rig.plane.countCalls("POST /sandbox/sb-nap3/start")).toBe(1);
  });

  it("refetches a gateway that moved, sharing one repair between concurrent failures", async () => {
    rig.plane.addSandbox({ id: "sb-moved" });
    const local = localShellTransport(rig.rootDir);
    let attempts = 0;
    let healthResets = 0;
    // ssh reaches the sandbox only through the gateway its include file and known_hosts name.
    const transport: SSHTransport = {
      ...local,
      resetConnectionHealth: () => healthResets++,
      spawnRemoteProcess: (command, options) => {
        attempts++;
        return JSON.stringify(rig.writer.gateway) === JSON.stringify(rig.plane.gateway)
          ? local.spawnRemoteProcess(command, options)
          : Promise.reject(new RuntimeError("Host key verification failed.", "network"));
      },
    };
    const runtime = makeRuntime({ sandboxId: "sb-moved" }, rig, { transport });
    expect(await runtime.ensureReady()).toEqual({ ready: true });
    const configFetches = rig.plane.countCalls("GET /config");
    const gateway = {
      host: "ssh2.daytona.test",
      port: 2222,
      hostKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRotated"],
    };
    rig.plane.gateway = gateway;

    const streams = await Promise.all(
      [1, 2].map(() => runtime.exec("echo ok", { cwd: "/tmp", timeout: 10 }))
    );
    for (const stream of streams) {
      expect(await new Response(stream.stdout).text()).toBe("ok\n");
    }
    expect(attempts).toBe(4);
    expect(rig.plane.countCalls("GET /config")).toBe(configFetches + 1);
    expect(rig.writer.repoints).toEqual([gateway]);
    expect(healthResets).toBe(2);
  });

  /** The gateway answers a stopped or deleted sandbox with the same refusal as a bad token. */
  function refusingTransportWhile(sandboxId: string, refuses: () => boolean): SSHTransport {
    const local = localShellTransport(rig.rootDir);
    return {
      ...local,
      spawnRemoteProcess: (command, options) =>
        refuses()
          ? Promise.reject(
              new RuntimeError(
                `${rig.writer.tokens.get(sandboxId) ?? ""}@127.0.0.1: Permission denied (publickey).`,
                "network"
              )
            )
          : local.spawnRemoteProcess(command, options),
    };
  }

  it("reports a sandbox that no longer exists instead of the refused token", async () => {
    rig.plane.addSandbox({ id: "sb-gone" });
    await rig.service.ssh.ensureSshAccess("sb-gone");
    rig.plane.sandboxes.delete("sb-gone");
    const runtime = makeRuntime({ sandboxId: "sb-gone" }, rig, {
      transport: refusingTransportWhile("sb-gone", () => true),
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(runtime.exec("true", { cwd: "/tmp", timeout: 10 })).rejects.toThrow(
      'Daytona sandbox "sb-gone" no longer exists'
    );
    expect(rig.plane.countCalls("POST /sandbox/sb-gone/ssh-access")).toBe(1);
  });

  it("mints no token for a started sandbox that lost this install's label", async () => {
    const sandbox = rig.plane.addSandbox({ id: "sb-relabeled" });
    await rig.service.ssh.ensureSshAccess("sb-relabeled");
    const minted = rig.plane.countCalls("POST /sandbox/sb-relabeled/ssh-access");
    sandbox.labels = {};
    const runtime = makeRuntime({ sandboxId: "sb-relabeled" }, rig, {
      transport: refusingTransportWhile("sb-relabeled", () => true),
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(runtime.exec("true", { cwd: "/tmp", timeout: 10 })).rejects.toThrow();
    expect(rig.plane.countCalls("POST /sandbox/sb-relabeled/ssh-access")).toBe(minted);
  });

  it("replaces a token the gateway refused and retries the command once", async () => {
    rig.plane.addSandbox({ id: "sb-rev" });
    await rig.service.ssh.ensureSshAccess("sb-rev");
    const refused = rig.writer.tokens.get("sb-rev");
    if (!refused) throw new Error("expected a minted token");
    const local = localShellTransport(rig.rootDir);
    let healthResets = 0;
    const transport: SSHTransport = {
      ...local,
      resetConnectionHealth: () => {
        healthResets++;
      },
      // Revoked outside Xum: the gateway refuses it until the include file holds another.
      spawnRemoteProcess: (command, options) =>
        rig.writer.tokens.get("sb-rev") === refused
          ? Promise.reject(
              new RuntimeError(`${refused}@127.0.0.1: Permission denied (publickey).`, "network")
            )
          : local.spawnRemoteProcess(command, options),
    };
    // Not a turn's runtime: a new token starts nothing, so any runtime replaces it.
    const runtime = makeRuntime({ sandboxId: "sb-rev" }, rig, { transport });

    const stream = await runtime.exec("echo ok", { cwd: "/tmp", timeout: 10 });
    expect(await new Response(stream.stdout).text()).toBe("ok\n");
    expect(await stream.exitCode).toBe(0);
    expect(rig.writer.tokens.get("sb-rev")).not.toBe(refused);
    expect(rig.plane.revokedTokens).toEqual([refused]);
    expect(healthResets).toBe(1);
    expect(rig.plane.countCalls("POST /sandbox/sb-rev/start")).toBe(0);
  });
});
