import { afterEach, beforeEach, describe, expect, it, spyOn, type Mock } from "bun:test";
import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import type { DaytonaSandboxConfig } from "@/common/orpc/schemas/daytona";
import type { RuntimeConfig } from "@/common/types/runtime";
import { DaytonaCredentialsStore } from "@/node/config/daytonaCredentialsStore";
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

  it("keep the token out of what the terminal prints", async () => {
    rig.plane.addSandbox({ id: "sb-term-tok" });
    await rig.service.ssh.ensureSshAccess("sb-term-tok");
    const token = rig.writer.tokens.get("sb-term-tok");
    if (!token) throw new Error("expected a minted token");
    let emit: (data: string) => void = () => undefined;
    const runtime = makeRuntime({ sandboxId: "sb-term-tok" }, rig, {
      transport: {
        ...localShellTransport(rig.rootDir),
        createPtySession: () =>
          Promise.resolve({
            write: () => undefined,
            resize: () => undefined,
            kill: () => undefined,
            onData: (handler: (data: string) => void) => {
              emit = handler;
              return { dispose: () => undefined };
            },
            onExit: () => ({ dispose: () => undefined }),
          }),
      },
    });

    const pty = await runtime.createPtySession({
      workspacePath: "~/src/project/feature",
      cols: 80,
      rows: 24,
    });
    const printed: string[] = [];
    pty.onData((data) => printed.push(data));
    emit(`${token}@gateway: Permission denied (publickey).\r\n`);

    expect(printed.join("")).toBe(
      `${DAYTONA_TOKEN_PLACEHOLDER}@gateway: Permission denied (publickey).\r\n`
    );
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
  it("refuses to create from a Windows or GPU snapshot before persisting", async () => {
    rig.plane.snapshots.push(
      { name: "windows-small", sandboxClass: "windows" },
      { name: "daytona-gpu", sandboxClass: "linux-vm", gpu: 1 },
      { name: "daytona-small", sandboxClass: "container" }
    );
    const runtime = makeRuntime({});
    const validate = async (daytona: DaytonaSandboxConfig) => {
      const finalized = await runtime.finalizeConfig("b", sshDaytonaConfig(daytona));
      if (!finalized.success) return finalized;
      return runtime.validateBeforePersist("b", finalized.data);
    };

    const created = await validate({ snapshot: "windows-small" });
    expect(created.success ? "" : created.error).toContain("Windows");
    const createdGpu = await validate({ snapshot: "daytona-gpu" });
    expect(createdGpu.success ? "" : createdGpu.error).toContain("GPU");

    expect((await validate({ snapshot: "daytona-small" })).success).toBe(true);
    expect(rig.plane.countCalls("POST /sandbox")).toBe(0);
  });

  it("refuses a snapshot Daytona no longer has before persisting", async () => {
    // A general snapshot may come only with the list, not by name.
    rig.plane.snapshots.push({
      name: "general-small",
      sandboxClass: "container",
      listedOnly: true,
    });
    const runtime = makeRuntime({});
    const validate = async (snapshot: string) => {
      const finalized = await runtime.finalizeConfig("b", sshDaytonaConfig({ snapshot }));
      if (!finalized.success) return finalized;
      return runtime.validateBeforePersist("b", finalized.data);
    };

    // A stale project default: deleted after it was saved.
    const stale = await validate("deleted-snapshot");
    expect(stale.success ? "" : stale.error).toContain('"deleted-snapshot" was not found');
    expect((await validate("general-small")).success).toBe(true);
    expect(rig.plane.countCalls("POST /sandbox")).toBe(0);
  });

  it("refuses a Windows deployment default when no snapshot is chosen", async () => {
    rig.plane.snapshots.push({ name: "default-snap", sandboxClass: "windows" });
    rig.plane.defaultSnapshot = "default-snap";
    const runtime = makeRuntime({});
    const finalized = await runtime.finalizeConfig("b", sshDaytonaConfig({}));
    if (!finalized.success) throw new Error(finalized.error);
    const refused = await runtime.validateBeforePersist("b", finalized.data);
    expect(refused.success ? "" : refused.error).toContain('"default-snap" creates Windows');
    expect(rig.plane.countCalls("POST /sandbox")).toBe(0);
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

  it("falls back to create-then-resize when the snapshot has fixed resources", async () => {
    rig.plane.rejectCreateResources = true;
    const medium = { cpu: 4, memoryGiB: 8, diskGiB: 20 };

    await makeRuntime({
      sandboxId: "xum-fixed",
      snapshot: "fixed-snap",
      ...medium,
    }).postCreateSetup(initParams());

    expect(rig.plane.createBodies).toHaveLength(2);
    expect(rig.plane.createBodies[1].cpu).toBeUndefined();
    expect(rig.plane.find("xum-fixed")).toMatchObject({
      state: "started",
      cpu: 4,
      memory: 8,
      disk: 20,
    });
  });

  it("never sends a preset disk over a disk size Daytona did not report", async () => {
    rig.plane.rejectCreateResources = true;
    rig.plane.omitDisk = true;
    // The snapshot's disk is larger than the preset's: sending the preset would shrink it.
    rig.plane.snapshotResources = { cpu: 1, memory: 1, disk: 30 };

    await makeRuntime({
      sandboxId: "xum-unknown-disk",
      snapshot: "fixed-snap",
      cpu: 4,
      memoryGiB: 8,
      diskGiB: 20,
    }).postCreateSetup(initParams());

    expect(rig.plane.find("xum-unknown-disk")).toMatchObject({
      state: "started",
      cpu: 4,
      memory: 8,
      disk: 30,
    });
  });

  it("resizes a sandbox whose cpu and memory Daytona did not report while it is stopped", async () => {
    rig.plane.rejectCreateResources = true;
    rig.plane.omitCompute = true;
    // Above the preset: resizing the running sandbox to it would be a shrink Daytona refuses.
    rig.plane.snapshotResources = { cpu: 8, memory: 16, disk: 30 };

    await makeRuntime({
      sandboxId: "xum-unknown-compute",
      snapshot: "fixed-snap",
      cpu: 4,
      memoryGiB: 8,
      diskGiB: 20,
    }).postCreateSetup(initParams());

    expect(rig.plane.find("xum-unknown-compute")).toMatchObject({
      state: "started",
      cpu: 4,
      memory: 8,
      disk: 30,
    });
  });

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

  it("refuses a settings change while it creates a sandbox, and takes one afterwards", async () => {
    const newAccount = rig.addAccount("new-key");
    // The user saves another account's key while the create request is in flight.
    let refusal: unknown;
    rig.plane.onRequest.set("POST /sandbox", () =>
      rig.service.account.setConfig({ apiKey: "new-key" }).catch((error: unknown) => {
        refusal = error;
      })
    );

    await makeRuntime({ sandboxId: "xum-kept", ...SMALL }).postCreateSetup(initParams());

    expect(String(refusal)).toContain("Daytona is busy");
    expect(rig.plane.find("xum-kept")?.state).toBe("started");
    expect(newAccount.calls).toEqual([]);
    expect((await rig.service.account.setConfig({ apiKey: "new-key" })).apiKeySource).toBe(
      "settings"
    );
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

  it("refuses a settings change between its checks and the sandbox delete", async () => {
    rig.plane.addSandbox({ id: "sb-clean" });
    const newAccount = rig.addAccount("new-key");
    let refusal: unknown;
    sshDeleteSpy.mockImplementation(async () => {
      await rig.service.account.setConfig({ apiKey: "new-key" }).catch((error: unknown) => {
        refusal = error;
      });
      return { success: true, deletedPath: "/path" };
    });

    const result = await makeRuntime({ sandboxId: "sb-clean" }).deleteWorkspace(
      "/home/me/project",
      "feature",
      false
    );

    expect(result.success).toBe(true);
    expect(String(refusal)).toContain("Daytona is busy");
    expect(rig.plane.find("sb-clean")).toBeUndefined();
    expect(newAccount.calls).toEqual([]);
    expect((await rig.service.account.setConfig({ apiKey: "new-key" })).apiKeySource).toBe(
      "settings"
    );
  });

  it("starts a delete after a settings change being saved, in the new account only", async () => {
    // The same name in both accounts: the delete must check and delete the new one's.
    rig.plane.addSandbox({ id: "sb-1", name: "xum-same" });
    const newAccount = rig.addAccount("new-key");
    newAccount.addSandbox({ id: "sb-9", name: "xum-same" });
    let releaseUpdate = () => undefined as void;
    const updateGate = new Promise<void>((resolve) => (releaseUpdate = resolve));
    const updateSpy = spyOn(DaytonaCredentialsStore.prototype, "update").mockImplementation(
      async function (this: DaytonaCredentialsStore, patch) {
        await updateGate;
        updateSpy.mockRestore();
        return this.update(patch);
      }
    );
    try {
      const saved = rig.service.account.setConfig({ apiKey: "new-key" });
      const deleted = makeRuntime({ sandboxId: "xum-same" }).deleteWorkspace(
        "/home/me/project",
        "feature",
        false
      );
      releaseUpdate();
      await saved;
      expect((await deleted).success).toBe(true);
    } finally {
      updateSpy.mockRestore();
    }

    expect(rig.plane.calls.filter((call) => call.includes("xum-same"))).toEqual([]);
    expect(rig.plane.find("xum-same")).toBeDefined();
    expect(newAccount.find("xum-same")).toBeUndefined();
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
  it("keeps the token (the ssh user name) out of command stderr and thrown errors", async () => {
    execSpy.mockRestore();
    rig.plane.addSandbox({ id: "sb-tok" });
    await rig.service.ssh.ensureSshAccess("sb-tok");
    const token = rig.writer.tokens.get("sb-tok");
    if (!token) throw new Error("expected a minted token");
    let refuseConnections = false;
    const local = localShellTransport(rig.rootDir);
    const runtime = makeRuntime({ sandboxId: "sb-tok" }, rig, {
      transport: {
        ...local,
        spawnRemoteProcess: (command, options) =>
          refuseConnections
            ? Promise.reject(
                new RuntimeError(`${token}@127.0.0.1: Permission denied (publickey).`, "network")
              )
            : local.spawnRemoteProcess(command, options),
      },
    });

    // OpenSSH's message, split across two writes inside the token.
    const result = await runtimeHelpers.execBuffered(
      runtime,
      `printf '%s' '${token.slice(0, 2)}' >&2; sleep 0.05; ` +
        `printf '%s@127.0.0.1: Permission denied (publickey).\\n' '${token.slice(2)}' >&2; exit 255`,
      { cwd: "/tmp", timeout: 10 }
    );
    expect(result.stderr).not.toContain(token);
    expect(result.stderr).toContain(`${DAYTONA_TOKEN_PLACEHOLDER}@127.0.0.1: Permission denied`);

    refuseConnections = true;
    const error = await runtime.exec("true", { cwd: "/tmp", timeout: 10 }).then(
      () => new Error("exec unexpectedly succeeded"),
      (rejection: unknown) => rejection
    );
    expect(String(error)).not.toContain(token);
    expect(String(error)).toContain(DAYTONA_TOKEN_PLACEHOLDER);
  });
  it("keeps a token an earlier Xum process left in the include file out of errors", async () => {
    // Never minted in this process: only the include file, read at startup, knows it.
    const stale = "earlier-process-token-7f3a";
    rig.plane.addSandbox({ id: "sb-old" });
    rig.writer.tokens.set("sb-old", stale);
    await rig.service.ssh.loadPersistedTokens();
    const runtime = makeRuntime({ sandboxId: "sb-old" }, rig, {
      transport: {
        ...localShellTransport(rig.rootDir),
        // What a skills listing or a workspace open hits right after a restart.
        spawnRemoteProcess: () =>
          Promise.reject(
            new RuntimeError(`${stale}@127.0.0.1: Permission denied (publickey).`, "network")
          ),
      },
    });

    const error = await runtime.exec("true", { cwd: "/tmp", timeout: 10 }).then(
      () => new Error("exec unexpectedly succeeded"),
      (rejection: unknown) => rejection
    );
    expect(String(error)).not.toContain(stale);
    expect(String(error)).toContain(`${DAYTONA_TOKEN_PLACEHOLDER}@127.0.0.1: Permission denied`);
  });

  it("keeps the token out of an error that gets no retry", async () => {
    rig.plane.addSandbox({ id: "sb-tok" });
    await rig.service.ssh.ensureSshAccess("sb-tok");
    const token = rig.writer.tokens.get("sb-tok");
    if (!token) throw new Error("expected a minted token");
    let spawns = 0;
    // A UI runtime never restarts the sandbox, so a dropped connection is not retried.
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
    expect(spawns).toBe(1);
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

  it("refetches a gateway that moved or rotated its keys within the config cache, then retries once", async () => {
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
    const turn = () => makeRuntime({ sandboxId: "sb-moved" }, rig, { transport });
    expect(await turn().ensureReady()).toEqual({ ready: true });
    const configFetches = () => rig.plane.countCalls("GET /config");

    const moves = [
      { ...rig.plane.gateway, host: "ssh2.daytona.test", port: 2222 },
      { ...rig.plane.gateway, hostKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRotated"] },
    ];
    for (const gateway of moves) {
      // Within the five-minute cache: nothing refetches /config on its own.
      rig.plane.gateway = gateway;
      const [fetches, tries, resets] = [configFetches(), attempts, healthResets];
      const runtime = turn();
      expect(await runtime.ensureReady()).toEqual({ ready: true });
      // Two commands fail together; they share one refetch.
      const streams = await Promise.all(
        [1, 2].map(() => runtime.exec("echo ok", { cwd: "/tmp", timeout: 10 }))
      );
      for (const stream of streams) {
        expect(await new Response(stream.stdout).text()).toBe("ok\n");
      }
      expect(attempts - tries).toBe(4);
      expect(configFetches()).toBe(fetches + 1);
      expect(rig.writer.repoints.at(-1)).toEqual(gateway);
      expect(healthResets).toBeGreaterThan(resets);
    }

    // The gateway did not change: the failure is something else, so no retry.
    const before = {
      fetches: configFetches(),
      tries: attempts,
      repoints: rig.writer.repoints.length,
    };
    const unchanged = turn();
    expect(await unchanged.ensureReady()).toEqual({ ready: true });
    rig.writer.gateway = { ...rig.plane.gateway, host: "unreachable.test" };
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(unchanged.exec("echo ok", { cwd: "/tmp", timeout: 10 })).rejects.toThrow(
      "Host key verification failed"
    );
    expect(attempts - before.tries).toBe(1);
    expect(configFetches()).toBe(before.fetches + 1);
    expect(rig.writer.repoints).toHaveLength(before.repoints);
  });

  it("puts back the gateway's pins after a host key failure when the gateway did not move", async () => {
    rig.plane.addSandbox({ id: "sb-pins" });
    const local = localShellTransport(rig.rootDir);
    let attempts = 0;
    // OpenSSH (StrictHostKeyChecking yes) refuses the gateway without its pinned key.
    const transport: SSHTransport = {
      ...local,
      spawnRemoteProcess: (command, options) => {
        attempts++;
        return JSON.stringify(rig.writer.pins) === JSON.stringify(rig.plane.gateway)
          ? local.spawnRemoteProcess(command, options)
          : Promise.reject(new RuntimeError("Host key verification failed.", "network"));
      },
    };
    const turn = makeRuntime({ sandboxId: "sb-pins" }, rig, { transport });
    expect(await turn.ensureReady()).toEqual({ ready: true });
    rig.writer.deletePins();

    const stream = await turn.exec("echo ok", { cwd: "/tmp", timeout: 10 });

    expect(await new Response(stream.stdout).text()).toBe("ok\n");
    expect(attempts).toBe(2);
    // The keys /config advertises are pinned, never the one a server offers.
    expect(rig.writer.pins).toEqual(rig.plane.gateway);
    expect(rig.writer.repoints).toHaveLength(0);
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

  it("restarts a stopped sandbox that refuses ssh, keeping its token", async () => {
    const sandbox = rig.plane.addSandbox({ id: "sb-nap2" });
    const transport = refusingTransportWhile("sb-nap2", () => sandbox.state !== "started");
    const turn = makeRuntime({ sandboxId: "sb-nap2" }, rig, { transport });
    expect(await turn.ensureReady()).toEqual({ ready: true });
    const token = rig.writer.tokens.get("sb-nap2");
    // Stopped within the ready cache: the next command goes straight to ssh.
    sandbox.state = "stopped";

    const stream = await turn.exec("echo ok", { cwd: "/tmp", timeout: 10 });
    expect(await new Response(stream.stdout).text()).toBe("ok\n");
    expect(rig.plane.countCalls("POST /sandbox/sb-nap2/start")).toBe(1);
    expect(rig.plane.countCalls("POST /sandbox/sb-nap2/ssh-access")).toBe(1);
    expect(rig.writer.tokens.get("sb-nap2")).toBe(token);
    expect(rig.plane.revokedTokens).toEqual([]);
  });

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

  it("never replaces a token that a concurrent command already replaced", async () => {
    rig.plane.addSandbox({ id: "sb-race" });
    await rig.service.ssh.ensureSshAccess("sb-race");
    const first = rig.writer.tokens.get("sb-race");
    if (!first) throw new Error("expected a minted token");
    const local = localShellTransport(rig.rootDir);
    const refuse = (user: string) =>
      Promise.reject(
        new RuntimeError(`${user}@127.0.0.1: Permission denied (publickey).`, "network")
      );
    // Command A: the gateway refuses the first token until the include file holds another.
    const runtimeA = makeRuntime({ sandboxId: "sb-race" }, rig, {
      transport: {
        ...local,
        spawnRemoteProcess: (command, options) =>
          rig.writer.tokens.get("sb-race") === first
            ? refuse(first)
            : local.spawnRemoteProcess(command, options),
      },
    });
    // Command B ran on the first token too, but its refusal arrives once A has replaced it, with
    // the token already redacted (as the OpenSSH pool reports a probe failure).
    let attemptsB = 0;
    const runtimeB = makeRuntime({ sandboxId: "sb-race" }, rig, {
      transport: {
        ...local,
        spawnRemoteProcess: async (command, options) => {
          if (attemptsB++ > 0) return local.spawnRemoteProcess(command, options);
          const streamA = await runtimeA.exec("true", { cwd: "/tmp", timeout: 10 });
          expect(await streamA.exitCode).toBe(0);
          return refuse(DAYTONA_TOKEN_PLACEHOLDER);
        },
      },
    });

    const stream = await runtimeB.exec("echo ok", { cwd: "/tmp", timeout: 10 });

    expect(await new Response(stream.stdout).text()).toBe("ok\n");
    // Only A's refused token was revoked; the one A minted stays live.
    expect(rig.plane.revokedTokens).toEqual([first]);
    expect(rig.plane.countCalls("POST /sandbox/sb-race/ssh-access")).toBe(2);
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
