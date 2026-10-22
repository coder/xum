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
import { DaytonaReconciler } from "@/node/services/daytona/daytonaReconciler";
import {
  DAYTONA_LABEL_INSTANCE,
  DAYTONA_READY_CACHE_MS,
} from "@/node/services/daytona/daytonaService";
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

/**
 * Give every listed workspace a pendingRemoval marker, as each removal claims one: these
 * tests remove workspaces one after another without deregistering them.
 */
function claimRemovals(testRig = rig): void {
  for (const ref of testRig.workspaces) ref.pendingRemovalId ??= `rm-${ref.workspaceId}`;
}

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
    // Empty by default: tests that seed write files here.
    agentHomeSeedSources: {
      xumHome: path.join(testRig.rootDir, "host-xum"),
      home: path.join(testRig.rootDir, "host-home"),
    },
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

  it("never reports a start to a check cancelled while it waited for the shared one", async () => {
    rig.plane.addSandbox({ id: "sb-slow", state: "stopped" });
    let releaseState!: () => void;
    const stateHeld = new Promise<void>((resolve) => (releaseState = resolve));
    rig.plane.onRequest.set("GET /sandbox/sb-slow", () => {
      rig.plane.onRequest.delete("GET /sandbox/sb-slow");
      return stateHeld;
    });
    const cancelled: string[] = [];
    const other: string[] = [];
    const controller = new AbortController();
    const cancelledCheck = makeRuntime({ sandboxId: "sb-slow" }).ensureReady({
      signal: controller.signal,
      statusSink: (event) => cancelled.push(event.phase),
    });
    const otherCheck = makeRuntime({ sandboxId: "sb-slow" }).ensureReady({
      statusSink: (event) => other.push(event.phase),
    });

    // Cancelled while the state request is pending; the shared start then finds it stopped.
    controller.abort();
    expect((await cancelledCheck).ready).toBe(false);
    releaseState();
    expect(await otherCheck).toEqual({ ready: true });

    expect(other).toContain("starting");
    expect(cancelled).not.toContain("starting");
    expect(cancelled.at(-1)).toBe("error");
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
    // The second check joins the first one's start, so it reports that start too.
    expect(phases.map((seen) => seen.includes("starting"))).toEqual([true, true]);
    expect(rig.plane.countCalls("POST /sandbox/sb-archived/start")).toBe(1);
    expect(rig.plane.countCalls("POST /sandbox/sb-archived/ssh-access")).toBe(1);
  });

  it("never starts, mints for or runs ssh in a sandbox without this install's label", async () => {
    // After a restart: no setup failure is remembered for the workspace whose create lost the
    // name to another install's sandbox.
    rig.plane.addSandbox({
      id: "xum-theirs",
      state: "stopped",
      labels: { "xum.instance": "another-install" },
    });
    let spawned = 0;
    const local = localShellTransport(rig.rootDir);
    const transport: SSHTransport = {
      ...local,
      spawnRemoteProcess: (command, options) => {
        spawned++;
        return local.spawnRemoteProcess(command, options);
      },
    };
    const phases: string[] = [];

    const result = await makeRuntime({ sandboxId: "xum-theirs", shared: false }, rig, {
      transport,
      projectPath: "/home/me/project",
      workspaceName: "feature",
    }).ensureReady({ statusSink: (event) => phases.push(event.phase) });

    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.errorType).toBe("runtime_not_ready");
      expect(result.error).toContain("xum.instance");
    }
    expect(phases.at(-1)).toBe("error");
    expect(rig.plane.countCalls("POST /sandbox/xum-theirs/start")).toBe(0);
    expect(rig.plane.countCalls("POST /sandbox/xum-theirs/ssh-access")).toBe(0);
    expect(spawned).toBe(0);
  });

  it("refuses a sandbox without this install's label even when an attached workspace made it ready", async () => {
    // After a restart: the dedicated workspace's create lost the name to another install's
    // sandbox, which a workspace attached on purpose and just used.
    rig.plane.addSandbox({ id: "xum-theirs", labels: { "xum.instance": "another-install" } });
    expect(await makeRuntime({ sandboxId: "xum-theirs", shared: true }).ensureReady()).toEqual({
      ready: true,
    });
    expect(rig.service.isSandboxReady("xum-theirs")).toBe(true);
    let spawned = 0;
    const local = localShellTransport(rig.rootDir);
    const transport: SSHTransport = {
      ...local,
      spawnRemoteProcess: (command, options) => {
        spawned++;
        return local.spawnRemoteProcess(command, options);
      },
    };

    const result = await makeRuntime({ sandboxId: "xum-theirs", shared: false }, rig, {
      transport,
      projectPath: "/home/me/project",
      workspaceName: "feature",
    }).ensureReady();

    expect(result.ready).toBe(false);
    if (!result.ready) expect(result.error).toContain("xum.instance");
    expect(spawned).toBe(0);
  });

  it("sees a label removed after a turn once the ready cache window has passed", async () => {
    const sandbox = rig.plane.addSandbox({ id: "sb-handed-back" });
    const turn = () => makeRuntime({ sandboxId: "sb-handed-back", shared: false }).ensureReady();
    expect(await turn()).toEqual({ ready: true });

    // The user (or another backend) hands the sandbox back by dropping the label.
    sandbox.labels = {};
    rig.clock.now += DAYTONA_READY_CACHE_MS / 2;
    expect(await turn()).toEqual({ ready: true });
    rig.clock.now += DAYTONA_READY_CACHE_MS;
    const refused = await turn();
    expect(refused.ready).toBe(false);
    if (!refused.ready) expect(refused.error).toContain("xum.instance");
  });

  it("proves a sandbox is this install's once per ready cache window", async () => {
    rig.plane.addSandbox({ id: "sb-own" });
    const lookups = () => rig.plane.countCalls("GET /sandbox/sb-own");
    const perCheck: number[] = [];
    for (let check = 0; check < 2; check++) {
      rig.service.invalidateSandboxReady("sb-own");
      const before = lookups();
      expect(await makeRuntime({ sandboxId: "sb-own", shared: false }).ensureReady()).toEqual({
        ready: true,
      });
      perCheck.push(lookups() - before);
    }
    // The start's own state read, plus the label read on the first check only.
    expect(perCheck).toEqual([2, 1]);
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
    await rig.service.ensureSshAccess("sb-term-tok");
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
    expect(result.data.daytona).toMatchObject({ shared: false, ...SMALL });
    expect(await runtime.validateBeforePersist("Feature_X", result.data)).toEqual({
      success: true,
      data: undefined,
    });
  });

  it("attaches to a given sandbox as shared", async () => {
    rig.plane.addSandbox({ id: "sb-mine" });
    const runtime = makeRuntime({});
    const result = await runtime.finalizeConfig("b", sshDaytonaConfig({ sandboxId: "sb-mine" }));
    if (!result.success || result.data.type !== "ssh") throw new Error("expected ssh config");
    expect(result.data.daytona).toMatchObject({ sandboxId: "sb-mine", shared: true });
    expect((await runtime.validateBeforePersist("b", result.data)).success).toBe(true);
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
    const handEdited = sshDaytonaConfig({ sandboxId: "xum-b-1", shared: false, cpu: 64 });
    expect((await runtime.validateBeforePersist("b", handEdited)).success).toBe(false);

    rig.plane.addSandbox({ id: "sb-9", name: "xum-b-taken" });
    const taken = sshDaytonaConfig({ sandboxId: "xum-b-taken", shared: false, ...SMALL });
    expect((await runtime.validateBeforePersist("b", taken)).success).toBe(false);
  });
});

describe("DaytonaSSHRuntime Windows and GPU sandboxes", () => {
  // Xum provisions over ssh with POSIX commands; a Windows sandbox runs cmd.exe or PowerShell.
  // Daytona deletes a GPU sandbox when it stops, and Xum lets workspaces auto-stop.
  it("refuses to attach a Windows or GPU sandbox or create from such a snapshot before persisting", async () => {
    rig.plane.addSandbox({ id: "sb-win", sandboxClass: "windows" });
    rig.plane.addSandbox({ id: "sb-gpu", sandboxClass: "linux-vm", gpu: 1 });
    rig.plane.addSandbox({ id: "sb-linux", sandboxClass: "linux-vm", gpu: 0 });
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

    const attached = await validate({ sandboxId: "sb-win" });
    expect(attached.success ? "" : attached.error).toContain("Windows");
    const created = await validate({ snapshot: "windows-small" });
    expect(created.success ? "" : created.error).toContain("Windows");
    const attachedGpu = await validate({ sandboxId: "sb-gpu" });
    expect(attachedGpu.success ? "" : attachedGpu.error).toContain("GPU");
    const createdGpu = await validate({ snapshot: "daytona-gpu" });
    expect(createdGpu.success ? "" : createdGpu.error).toContain("GPU");

    expect((await validate({ sandboxId: "sb-linux" })).success).toBe(true);
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

  it.each([
    [{ name: "default-snap", sandboxClass: "windows" }, '"default-snap" creates Windows'],
    [{ name: "default-snap", state: "inactive" }, '"default-snap" is inactive'],
  ])(
    "refuses a deployment default Xum cannot use when no snapshot is chosen (%o)",
    async (snapshot, refusal) => {
      rig.plane.snapshots.push(snapshot);
      rig.plane.defaultSnapshot = "default-snap";
      const runtime = makeRuntime({});
      const finalized = await runtime.finalizeConfig("b", sshDaytonaConfig({}));
      if (!finalized.success) throw new Error(finalized.error);
      const refused = await runtime.validateBeforePersist("b", finalized.data);
      expect(refused.success ? "" : refused.error).toContain(refusal);
      expect(rig.plane.countCalls("POST /sandbox")).toBe(0);
    }
  );

  it("neither offers nor attaches a sandbox in an error state", async () => {
    rig.plane.addSandbox({ id: "sb-broken", state: "build_failed" });
    rig.plane.addSandbox({ id: "sb-ok" });
    const runtime = makeRuntime({});
    const finalized = await runtime.finalizeConfig(
      "b",
      sshDaytonaConfig({ sandboxId: "sb-broken" })
    );
    if (!finalized.success) throw new Error(finalized.error);

    // startAndWait never brings such a sandbox up: setup would fail on every retry.
    const refused = await runtime.validateBeforePersist("b", finalized.data);
    expect(refused.success ? "" : refused.error).toContain("build_failed");
    const listed = await rig.service.listSandboxes();
    expect(listed.ok && listed.sandboxes.map((s) => s.id)).toEqual(["sb-ok"]);
  });

  it("neither offers nor accepts a snapshot that is not active", async () => {
    rig.plane.snapshots.push(
      { name: "snap-building", state: "building" },
      { name: "snap-inactive", state: "inactive" },
      { name: "snap-active", state: "active" },
      // No state reported: accepted, as before Daytona reported one.
      { name: "snap-unknown" }
    );
    const runtime = makeRuntime({});
    const validate = async (snapshot: string) => {
      const finalized = await runtime.finalizeConfig("b", sshDaytonaConfig({ snapshot }));
      if (!finalized.success) return finalized;
      return runtime.validateBeforePersist("b", finalized.data);
    };
    const error = (result: Awaited<ReturnType<typeof validate>>) =>
      result.success ? "" : result.error;

    expect(error(await validate("snap-building"))).toContain("building");
    const inactive = error(await validate("snap-inactive"));
    expect(inactive).toContain("inactive");
    expect(inactive).toContain("activate");
    expect((await validate("snap-active")).success).toBe(true);
    expect((await validate("snap-unknown")).success).toBe(true);
    const listed = await rig.service.listSnapshots();
    expect(listed.ok && listed.snapshots.map((s) => s.name)).toEqual([
      "snap-active",
      "snap-unknown",
    ]);
    expect(rig.plane.countCalls("POST /sandbox")).toBe(0);
  });

  it("offers neither Windows nor GPU snapshots and sandboxes", async () => {
    rig.plane.addSandbox({ id: "sb-win", sandboxClass: "windows" });
    rig.plane.addSandbox({ id: "sb-gpu", sandboxClass: "linux-vm", gpu: 1 });
    rig.plane.addSandbox({ id: "sb-linux", sandboxClass: "linux-vm" });
    rig.plane.addSandbox({ id: "sb-older" });
    rig.plane.snapshots.push(
      { name: "windows-small", sandboxClass: "windows" },
      { name: "daytona-gpu", sandboxClass: "linux-vm", gpu: 1 },
      { name: "daytona-small", sandboxClass: "container" },
      { name: "older" }
    );

    const snapshots = await rig.service.listSnapshots();
    const sandboxes = await rig.service.listSandboxes();

    expect(snapshots.ok && snapshots.snapshots.map((s) => s.name)).toEqual([
      "daytona-small",
      "older",
    ]);
    expect(sandboxes.ok && sandboxes.sandboxes.map((s) => s.id)).toEqual(["sb-linux", "sb-older"]);
  });
});

describe("DaytonaSSHRuntime.postCreateSetup", () => {
  it("creates the sandbox with preset resources, labels and lifecycle intervals", async () => {
    await makeRuntime({ sandboxId: "xum-new", shared: false, ...SMALL }).postCreateSetup(
      initParams()
    );

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
      shared: false,
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
      shared: false,
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
      shared: false,
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

    const failure = await makeRuntime({ sandboxId: "xum-doomed", shared: false, ...SMALL })
      .postCreateSetup(params)
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("No space left on device");

    expect(rig.plane.countCalls("POST /sandbox")).toBe(1);
    expect(rig.plane.find("xum-doomed")).toBeUndefined();

    // A later turn learns why, not that the sandbox was "deleted outside Xum".
    const ready = await makeRuntime({
      sandboxId: "xum-doomed",
      shared: false,
      ...SMALL,
    }).ensureReady();
    expect(ready.ready).toBe(false);
    if (!ready.ready) {
      expect(ready.error).toContain("setup failed");
      expect(ready.error).toContain("No space left on device");
    }
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
        const daytona = { sandboxId, shared: false, ...SMALL };

        // eslint-disable-next-line @typescript-eslint/await-thenable
        await expect(makeRuntime(daytona).postCreateSetup(initParams())).rejects.toThrow(
          "setup failed"
        );
        expect(rig.plane.find(sandboxId)).toBeDefined();

        // The persisted workspace still names the sandbox; removing it deletes the sandbox.
        rig.plane.failingRoutes.clear();
        if (!force) rig.writer.writeError = undefined;
        rig.workspaces.splice(0, rig.workspaces.length, {
          workspaceId: "ws-1",
          runtimeConfig: sshDaytonaConfig(daytona),
        });
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

  it("reports a failed setup only to its own workspace, not to one that attached the sandbox", async () => {
    const sshDelete = spyOn(SSHRuntime.prototype, "deleteWorkspace").mockResolvedValue({
      success: true,
      deletedPath: "/path",
    });
    try {
      const dedicated = { sandboxId: "xum-left", shared: false, ...SMALL };
      rig.writer.writeError = new Error("No space left on device");
      rig.plane.failingRoutes.add("DELETE /sandbox/xum-left");
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(makeRuntime(dedicated).postCreateSetup(initParams())).rejects.toThrow(
        "setup failed"
      );
      expect(rig.plane.find("xum-left")).toBeDefined();
      rig.plane.failingRoutes.clear();
      rig.writer.writeError = undefined;

      // The surviving sandbox is picked in the Existing picker for a new workspace.
      const attached = { sandboxId: "xum-left", shared: true };
      const attach = () => makeRuntime(attached, rig, { workspaceId: "ws-2" });
      await attach().postCreateSetup(initParams());
      expect(await attach().ensureReady()).toEqual({ ready: true });

      const failed = await makeRuntime(dedicated).ensureReady();
      expect(failed.ready).toBe(false);
      if (!failed.ready) expect(failed.error).toContain("No space left on device");

      // Removing the failed workspace forgets its failure.
      rig.workspaces.splice(
        0,
        rig.workspaces.length,
        { workspaceId: "ws-1", runtimeConfig: sshDaytonaConfig(dedicated) },
        { workspaceId: "ws-2", runtimeConfig: sshDaytonaConfig(attached) }
      );
      claimRemovals();
      const removal = await makeRuntime(dedicated).deleteWorkspace(
        "/home/me/project",
        "feature",
        true
      );
      expect(removal.success).toBe(true);
      expect(rig.service.getSetupFailure("ws-1")).toBeUndefined();
    } finally {
      sshDelete.mockRestore();
    }
  });

  it("refuses a settings change while it creates a sandbox, and takes one afterwards", async () => {
    const newAccount = rig.addAccount("new-key");
    // The user saves another account's key while the create request is in flight.
    let refusal: unknown;
    rig.plane.onRequest.set("POST /sandbox", () =>
      rig.service.setConfig({ apiKey: "new-key" }).catch((error: unknown) => {
        refusal = error;
      })
    );

    await makeRuntime({ sandboxId: "xum-kept", shared: false, ...SMALL }).postCreateSetup(
      initParams()
    );

    expect(String(refusal)).toContain("Daytona is busy");
    expect(rig.plane.find("xum-kept")?.state).toBe("started");
    expect(newAccount.calls).toEqual([]);
    expect((await rig.service.setConfig({ apiKey: "new-key" })).apiKeySource).toBe("settings");
  });

  it("deletes its sandbox in the account that created it if the settings still change", async () => {
    // Defense behind the refusal above: setup fails, and cleans up where it created.
    spyOn(rig.service, "isAccountCurrent").mockReturnValue(false);

    const failure = await makeRuntime({ sandboxId: "xum-moved", shared: false, ...SMALL })
      .postCreateSetup(initParams())
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(String(failure)).toContain("Daytona settings changed");
    expect(rig.plane.find("xum-moved")).toBeUndefined();
  });

  it("never deletes a sandbox that took its name before the create request", async () => {
    // Another Xum install created this name between validateBeforePersist and the create.
    const other = rig.plane.addSandbox({
      id: "sb-other",
      name: "xum-raced",
      labels: { "xum.instance": "another-install", "xum.workspaceId": "ws-other" },
    });

    const failure = await makeRuntime({ sandboxId: "xum-raced", shared: false, ...SMALL })
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
      makeRuntime({ sandboxId, shared: false, ...SMALL })
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

  it("never touches a sandbox without this install's label when the failed workspace is removed", async () => {
    const sshDelete = spyOn(SSHRuntime.prototype, "deleteWorkspace").mockResolvedValue({
      success: true,
      deletedPath: "/path",
    });
    try {
      // The create failed ambiguously while another install's sandbox held the name.
      rig.plane.failingRoutes.add("POST /sandbox");
      const other = rig.plane.addSandbox({
        id: "sb-other",
        name: "xum-theirs",
        labels: { "xum.instance": "another-install", "xum.workspaceId": "ws-1" },
      });
      const daytona = { sandboxId: "xum-theirs", shared: false, ...SMALL };
      await makeRuntime(daytona)
        .postCreateSetup(initParams())
        .catch(() => undefined);
      rig.plane.failingRoutes.clear();

      // The persisted workspace still says Xum created it. Their sandbox may hold a checkout at
      // this workspace's path: no removal starts it, checks it, deletes that checkout or it.
      for (const state of ["started", "stopped"]) {
        for (const force of [false, true]) {
          other.state = state;
          const removal = await makeRuntime(daytona).deleteWorkspace(
            "/home/me/project",
            "feature",
            force
          );
          expect(removal.success).toBe(true);
          if (removal.success) expect(removal.notice).toContain("xum.instance");
          expect(rig.plane.find("xum-theirs")).toBe(other);
          expect(other.state).toBe(state);
        }
      }
      expect(sshDelete).not.toHaveBeenCalled();
      expect(rig.plane.countCalls("POST /sandbox/xum-theirs/start")).toBe(0);
      expect(rig.plane.countCalls("DELETE /sandbox/xum-theirs")).toBe(0);
    } finally {
      sshDelete.mockRestore();
    }
  });

  it("seeds the agent home of a created sandbox but never of an attached one", async () => {
    const hostXum = path.join(rig.rootDir, "host-xum");
    await fs.mkdir(hostXum, { recursive: true });
    await fs.writeFile(path.join(hostXum, "tool_env"), "export JOBS=4\n");
    const seedCalls = () => execSpy.mock.calls.filter(([, command]) => command === "sh -s");

    await makeRuntime({ sandboxId: "xum-seeded", shared: false, ...SMALL }).postCreateSetup(
      initParams()
    );
    expect(seedCalls()).toHaveLength(1);
    expect(seedCalls()[0][2].stdin).toContain('"$HOME/.mux/tool_env"');

    rig.plane.addSandbox({ id: "sb-users", state: "stopped" });
    await makeRuntime({ sandboxId: "sb-users", shared: true }).postCreateSetup(initParams());
    expect(seedCalls()).toHaveLength(1);
    expect(rig.plane.countCalls("POST /sandbox")).toBe(1);
    expect(rig.plane.find("sb-users")?.state).toBe("started");
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

  it("keeps a sandbox another workspace attached by its id while the owner stores its name", async () => {
    // Xum created it under a name; the attach picker stores the real id of the same sandbox.
    rig.plane.addSandbox({ id: "sb-7", name: "xum-owner-abc123" });
    const owner = { sandboxId: "xum-owner-abc123", shared: false, ...SMALL };
    rig.workspaces.push(
      { workspaceId: "ws-1", runtimeConfig: sshDaytonaConfig(owner) },
      {
        workspaceId: "ws-attached",
        runtimeConfig: sshDaytonaConfig({ sandboxId: "sb-7", shared: true }),
      }
    );

    for (const force of [false, true]) {
      const result = await makeRuntime(owner).deleteWorkspace("/home/me/project", "feature", force);
      expect(result.success).toBe(true);
      expect(rig.plane.find("sb-7")).toBeDefined();
    }
    expect(rig.plane.calls.filter((call) => /^DELETE \/sandbox\/[^/]+$/.test(call))).toEqual([]);
  });

  it("refuses a settings change between its checks and the sandbox delete", async () => {
    rig.plane.addSandbox({ id: "sb-clean" });
    const newAccount = rig.addAccount("new-key");
    let refusal: unknown;
    sshDeleteSpy.mockImplementation(async () => {
      await rig.service.setConfig({ apiKey: "new-key" }).catch((error: unknown) => {
        refusal = error;
      });
      return { success: true, deletedPath: "/path" };
    });

    const result = await makeRuntime({ sandboxId: "sb-clean", shared: false }).deleteWorkspace(
      "/home/me/project",
      "feature",
      false
    );

    expect(result.success).toBe(true);
    expect(String(refusal)).toContain("Daytona is busy");
    expect(rig.plane.find("sb-clean")).toBeUndefined();
    expect(newAccount.calls).toEqual([]);
    expect((await rig.service.setConfig({ apiKey: "new-key" })).apiKeySource).toBe("settings");
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
      const saved = rig.service.setConfig({ apiKey: "new-key" });
      const deleted = makeRuntime({ sandboxId: "xum-same", shared: false }).deleteWorkspace(
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

  it("still hands off a started sandbox when a forced removal cannot delete the checkout", async () => {
    const labels = { [DAYTONA_LABEL_INSTANCE]: await rig.service.getInstanceId() };
    rig.plane.addSandbox({ id: "sb-1", name: "xum-owner", labels });
    const owner = { sandboxId: "xum-owner", shared: false, ...SMALL };
    rig.workspaces.push(
      { workspaceId: "ws-o", runtimeConfig: sshDaytonaConfig(owner) },
      { workspaceId: "ws-t", runtimeConfig: sshDaytonaConfig({ sandboxId: "sb-1", shared: true }) }
    );
    claimRemovals();
    await rig.service.ensureSshAccess("xum-owner");
    sshDeleteSpy.mockResolvedValue({ success: false, error: "ssh: host unreachable" });

    const forced = await makeRuntime(owner, rig, { workspaceId: "ws-o" }).deleteWorkspace(
      "/home/me/project",
      "ws-o",
      true
    );

    expect(forced.success).toBe(true);
    expect(forced.success ? forced.notice : forced.error).toContain("ssh: host unreachable");
    expect(rig.plane.find("sb-1")?.labels).toEqual({});
    expect(rig.writer.removed).toContain("xum-owner");
  });

  it("starts a stopped sandbox to run the dirty check and keeps a dirty workspace", async () => {
    rig.plane.addSandbox({ id: "sb-dirty", state: "stopped" });
    sshDeleteSpy.mockResolvedValue({ success: false, error: "uncommitted changes" });

    const result = await makeRuntime({ sandboxId: "sb-dirty", shared: false }).deleteWorkspace(
      "/home/me/project",
      "feature",
      false
    );

    expect(result).toEqual({ success: false, error: "uncommitted changes" });
    expect(rig.plane.countCalls("POST /sandbox/sb-dirty/start")).toBe(1);
    expect(sshDeleteSpy).toHaveBeenCalledTimes(1);
    expect(rig.plane.find("sb-dirty")).toBeDefined();
  });

  it("deletes an owned sandbox after a clean check and drops its ssh access", async () => {
    rig.plane.addSandbox({ id: "sb-clean", state: "stopped" });

    const result = await makeRuntime({ sandboxId: "sb-clean", shared: false }).deleteWorkspace(
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

  it("keeps the sandbox for a fork's source, deletes it with the last workspace", async () => {
    rig.plane.addSandbox({ id: "sb-parent" });
    const forkSpy = spyOn(SSHRuntime.prototype, "forkWorkspace").mockResolvedValue({
      success: true,
      workspacePath: "/fork",
    });
    try {
      const sourceDaytona = { sandboxId: "sb-parent", shared: false, ...SMALL };
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
      rig.workspaces.push(
        { workspaceId: "ws-1", runtimeConfig: sshDaytonaConfig(sourceDaytona) },
        { workspaceId: "ws-fork", runtimeConfig: sshDaytonaConfig(forkDaytona) }
      );

      // The fork's setup (a fresh runtime from its config) connects; it creates nothing.
      await makeRuntime(forkDaytona, rig, { workspaceId: "ws-fork" }).postCreateSetup(initParams());
      expect(rig.plane.countCalls("POST /sandbox")).toBe(0);

      const deleteFork = makeRuntime(forkDaytona, rig, { workspaceId: "ws-fork" });
      expect(
        (await deleteFork.deleteWorkspace("/home/me/project", "feature-fork", false)).success
      ).toBe(true);
      expect(rig.plane.find("sb-parent")).toBeDefined();
      rig.workspaces.splice(1, 1);

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
      makeRuntime({ sandboxId, shared: false, ...SMALL }).forkWorkspace({
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

  it("deletes the sandbox with a fork that outlives its source", async () => {
    rig.plane.addSandbox({ id: "sb-parent" });
    const forkSpy = spyOn(SSHRuntime.prototype, "forkWorkspace").mockResolvedValue({
      success: true,
      workspacePath: "/fork",
    });
    try {
      const sourceDaytona = { sandboxId: "sb-parent", shared: false, ...SMALL };
      const fork = await makeRuntime(sourceDaytona).forkWorkspace({
        projectPath: "/home/me/project",
        sourceWorkspaceName: "feature",
        newWorkspaceName: "feature-fork",
        initLogger: initParams().initLogger,
      });
      const forkDaytona =
        fork.forkedRuntimeConfig?.type === "ssh" ? fork.forkedRuntimeConfig.daytona : undefined;
      if (!forkDaytona) throw new Error("expected a Daytona fork config");
      rig.workspaces.push(
        { workspaceId: "ws-1", runtimeConfig: sshDaytonaConfig(sourceDaytona) },
        { workspaceId: "ws-fork", runtimeConfig: sshDaytonaConfig(forkDaytona) }
      );

      const deleteSource = makeRuntime(sourceDaytona);
      expect(
        (await deleteSource.deleteWorkspace("/home/me/project", "feature", false)).success
      ).toBe(true);
      expect(rig.plane.find("sb-parent")).toBeDefined();
      rig.workspaces.splice(0, 1);

      const deleteFork = makeRuntime(forkDaytona, rig, { workspaceId: "ws-fork" });
      expect(
        (await deleteFork.deleteWorkspace("/home/me/project", "feature-fork", false)).success
      ).toBe(true);
      expect(rig.plane.find("sb-parent")).toBeUndefined();
    } finally {
      forkSpy.mockRestore();
    }
  });

  describe("two workspaces on one sandbox removed at the same time", () => {
    // Neither removal is persisted yet, so the workspace list shows both throughout.
    function removeBoth() {
      rig.plane.addSandbox({ id: "sb-pair" });
      const source = { sandboxId: "sb-pair", shared: false, ...SMALL };
      const fork = { ...source, forked: true };
      rig.workspaces.push(
        { workspaceId: "ws-1", runtimeConfig: sshDaytonaConfig(source), pendingRemovalId: "rm-1" },
        { workspaceId: "ws-fork", runtimeConfig: sshDaytonaConfig(fork), pendingRemovalId: "rm-2" }
      );
      return Promise.all([
        makeRuntime(source).deleteWorkspace("/home/me/project", "feature", false),
        makeRuntime(fork, rig, { workspaceId: "ws-fork" }).deleteWorkspace(
          "/home/me/project",
          "feature-fork",
          false
        ),
      ]);
    }

    it("deletes the sandbox exactly once", async () => {
      const results = await removeBoth();

      expect(results.map((result) => result.success)).toEqual([true, true]);
      expect(rig.plane.countCalls("DELETE /sandbox/sb-pair")).toBe(1);
      expect(rig.writer.removed).toContain("sb-pair");
    });

    it("keeps the sandbox when the other removal is refused for uncommitted work", async () => {
      sshDeleteSpy.mockImplementation((_projectPath, workspaceName) =>
        Promise.resolve(
          workspaceName === "feature-fork"
            ? { success: false, error: "uncommitted changes" }
            : { success: true, deletedPath: "/path" }
        )
      );

      const results = await removeBoth();

      expect(results.map((result) => result.success)).toEqual([true, false]);
      expect(rig.plane.countCalls("DELETE /sandbox/sb-pair")).toBe(0);
      expect(rig.plane.find("sb-pair")).toBeDefined();
    });
  });

  it("waits for a sandbox Daytona is already deleting instead of refusing the delete", async () => {
    // A failed setup deletes the sandbox it created while the workspace's removal runs.
    // Daytona's documented state is "deleting"; "destroying" is the older spelling.
    for (const [sandboxId, state] of [
      ["sb-going", "deleting"],
      ["sb-going-old", "destroying"],
    ] as const) {
      rig.plane.addSandbox({ id: sandboxId, state, pendingPolls: 2 });

      const result = await makeRuntime({ sandboxId, shared: false }).deleteWorkspace(
        "/home/me/project",
        "feature",
        false
      );

      expect(result.success).toBe(true);
      expect(rig.plane.find(sandboxId)).toBeUndefined();
    }
  });

  it("names the sandbox left behind when a forced delete cannot delete it", async () => {
    rig.plane.addSandbox({ id: "sb-stuck" });
    rig.plane.failingRoutes.add("DELETE /sandbox/sb-stuck");

    const result = await makeRuntime({ sandboxId: "sb-stuck", shared: false }).deleteWorkspace(
      "/home/me/project",
      "feature",
      true
    );

    expect(result).toMatchObject({ success: false, leftoverPaths: ['Daytona sandbox "sb-stuck"'] });
  });

  it("never deletes a sandbox Xum created through a workspace that attached it, and says so", async () => {
    const labels = { [DAYTONA_LABEL_INSTANCE]: await rig.service.getInstanceId() };
    const owner = (sandboxId: string) => ({ sandboxId, shared: false, ...SMALL });
    const attached = (sandboxId: string) => ({ sandboxId, shared: true });
    const remove = (workspaceId: string, daytona: DaytonaSandboxConfig) =>
      makeRuntime(daytona, rig, { workspaceId }).deleteWorkspace(
        "/home/me/project",
        workspaceId,
        false
      );
    const deletes = () =>
      rig.plane.calls.filter((call) => /^DELETE \/sandbox\/[^/]+$/.test(call)).length;
    const notice = (result: Awaited<ReturnType<typeof remove>>) =>
      result.success ? result.notice : result.error;
    // Each sandbox: the owner stores its name, another workspace attached it by its id.
    rig.plane.addSandbox({ id: "sb-1", name: "xum-owner-first", labels });
    rig.plane.addSandbox({ id: "sb-2", name: "xum-attached-first", labels });
    rig.workspaces.push(
      { workspaceId: "ws-o1", runtimeConfig: sshDaytonaConfig(owner("xum-owner-first")) },
      { workspaceId: "ws-t1", runtimeConfig: sshDaytonaConfig(attached("sb-1")) },
      { workspaceId: "ws-o2", runtimeConfig: sshDaytonaConfig(owner("xum-attached-first")) },
      { workspaceId: "ws-t2", runtimeConfig: sshDaytonaConfig(attached("sb-2")) }
    );
    claimRemovals();

    // The owner goes first: its removal says the sandbox now outlives Xum's workspaces, and the
    // attached workspace's removal only releases it.
    const ownerFirst = await remove("ws-o1", owner("xum-owner-first"));
    expect(ownerFirst.success).toBe(true);
    expect(notice(ownerFirst)).toContain('"xum-owner-first"');
    const attachedLast = await remove("ws-t1", attached("sb-1"));
    expect(attachedLast).toEqual({ success: true, deletedPath: expect.any(String) as string });
    expect(rig.plane.find("sb-1")).toBeDefined();
    expect(deletes()).toBe(0);
    // Handed to the user: no longer labeled as this install's, so no sweep stops it as an orphan.
    expect(rig.plane.find("sb-1")?.labels).toEqual({});
    await new DaytonaReconciler({
      daytonaService: rig.service,
      listWorkspaces: () => [],
      isWorkspaceActive: () => Promise.resolve(false),
    }).sweep();
    expect(rig.plane.find("sb-1")?.state).toBe("started");

    // The attached workspace goes first: the owner's removal deletes it, with nothing to say.
    const attachedFirst = await remove("ws-t2", attached("sb-2"));
    expect(attachedFirst).toEqual({ success: true, deletedPath: expect.any(String) as string });
    expect(rig.plane.find("sb-2")).toBeDefined();
    const ownerLast = await remove("ws-o2", owner("xum-attached-first"));
    expect(ownerLast).toEqual({ success: true, deletedPath: expect.any(String) as string });
    expect(rig.plane.find("sb-2")).toBeUndefined();
    expect(deletes()).toBe(1);
  });

  it("keeps the owner's workspace when its sandbox cannot be handed off", async () => {
    const labels = { [DAYTONA_LABEL_INSTANCE]: await rig.service.getInstanceId() };
    rig.plane.addSandbox({ id: "sb-1", name: "xum-owner", labels });
    const owner = { sandboxId: "xum-owner", shared: false, ...SMALL };
    rig.workspaces.push(
      { workspaceId: "ws-o", runtimeConfig: sshDaytonaConfig(owner) },
      { workspaceId: "ws-t", runtimeConfig: sshDaytonaConfig({ sandboxId: "sb-1", shared: true }) }
    );
    claimRemovals();
    const remove = () =>
      makeRuntime(owner, rig, { workspaceId: "ws-o" }).deleteWorkspace(
        "/home/me/project",
        "ws-o",
        false
      );

    rig.plane.failingRoutes.add("PUT /sandbox/xum-owner/labels");
    const refused = await remove();
    expect(refused.success ? "" : refused.error).toContain("Xum-owned");
    expect(rig.plane.find("sb-1")?.labels).toEqual(labels);

    rig.plane.failingRoutes.clear();
    expect((await remove()).success).toBe(true);
    expect(rig.plane.find("sb-1")?.labels).toEqual({});
  });

  it("warns a forced removal that could not hand off its sandbox, and releases its access", async () => {
    const labels = { [DAYTONA_LABEL_INSTANCE]: await rig.service.getInstanceId() };
    rig.plane.addSandbox({ id: "sb-1", name: "xum-owner", labels, state: "stopped" });
    const owner = { sandboxId: "xum-owner", shared: false, ...SMALL };
    rig.workspaces.push(
      { workspaceId: "ws-o", runtimeConfig: sshDaytonaConfig(owner) },
      { workspaceId: "ws-t", runtimeConfig: sshDaytonaConfig({ sandboxId: "sb-1", shared: true }) }
    );
    claimRemovals();
    rig.plane.failingRoutes.add("PUT /sandbox/xum-owner/labels");

    const forced = await makeRuntime(owner, rig, { workspaceId: "ws-o" }).deleteWorkspace(
      "/home/me/project",
      "ws-o",
      true
    );

    // A forced removal goes on, so the warning is the user's only cue to drop the label.
    expect(forced.success ? forced.notice : forced.error).toContain(DAYTONA_LABEL_INSTANCE);
    expect(forced.success).toBe(true);
    expect(rig.writer.removed).toContain("xum-owner");
  });

  it("counts a workspace whose removal failed after its checkout step as a reference again", async () => {
    rig.plane.addSandbox({ id: "sb-kept", state: "stopped" });
    const owner = { sandboxId: "sb-kept", shared: false, ...SMALL };
    const fork = { ...owner, forked: true };
    // Each removal claims its workspace's pendingRemoval marker before any destructive step.
    const forkRef = {
      workspaceId: "ws-fork",
      runtimeConfig: sshDaytonaConfig(fork),
      pendingRemovalId: "rm-1" as string | undefined,
    };
    rig.workspaces.push(
      { workspaceId: "ws-owner", runtimeConfig: sshDaytonaConfig(owner), pendingRemovalId: "rm-o" },
      forkRef
    );

    // Forced on a stopped sandbox: the fork's checkout stays on it, unchecked.
    const forced = await makeRuntime(fork, rig, { workspaceId: "ws-fork" }).deleteWorkspace(
      "/home/me/project",
      "feature-fork",
      true
    );
    expect(forced.success).toBe(true);
    // Deregistration then fails: the fork stays registered and its marker is released, or a
    // retry claims a new one.
    for (const pendingRemovalId of [undefined, "rm-2"]) {
      forkRef.pendingRemovalId = pendingRemovalId;
      const removal = await makeRuntime(owner, rig, { workspaceId: "ws-owner" }).deleteWorkspace(
        "/home/me/project",
        "feature",
        false
      );
      expect(removal.success).toBe(true);
      expect(rig.plane.find("sb-kept")).toBeDefined();
    }
    expect(rig.plane.countCalls("DELETE /sandbox/sb-kept")).toBe(0);
  });

  it("never starts a stopped sandbox for the checks a forced removal skips", async () => {
    rig.plane.addSandbox({ id: "sb-users", state: "stopped" });
    rig.workspaces.push({
      workspaceId: "ws-1",
      runtimeConfig: sshDaytonaConfig({ sandboxId: "sb-users", shared: true }),
    });

    const result = await makeRuntime({ sandboxId: "sb-users", shared: true }).deleteWorkspace(
      "/home/me/project",
      "feature",
      true
    );

    expect(result.success).toBe(true);
    expect(rig.plane.find("sb-users")?.state).toBe("stopped");
    expect(rig.plane.calls.filter((call) => call.startsWith("POST /sandbox/sb-users/"))).toEqual(
      []
    );
    expect(rig.writer.removed).toContain("sb-users");
  });

  it("says where a forced removal left the checkout of a sandbox that was not running", async () => {
    rig.plane.addSandbox({ id: "sb-users", state: "archived" });
    const attached = { sandboxId: "sb-users", shared: true };
    const forced = await makeRuntime(attached).deleteWorkspace("/home/me/project", "feature", true);
    if (!forced.success) throw new Error(forced.error);
    expect(forced.notice).toContain(forced.deletedPath);
    expect(forced.notice).toContain('"sb-users"');

    // Gone: no checkout was left anywhere.
    const gone = await makeRuntime({ sandboxId: "sb-gone", shared: true }).deleteWorkspace(
      "/home/me/project",
      "feature",
      true
    );
    expect(gone).toEqual({ success: true, deletedPath: expect.any(String) as string });
  });

  it("drops the removed workspace's ssh access to a sandbox another workspace keeps", async () => {
    const labels = { [DAYTONA_LABEL_INSTANCE]: await rig.service.getInstanceId() };
    rig.plane.addSandbox({ id: "sb-7", name: "xum-owner-abc123", labels });
    const owner = { sandboxId: "xum-owner-abc123", shared: false, ...SMALL };
    const attached = { sandboxId: "sb-7", shared: true };
    rig.workspaces.push(
      { workspaceId: "ws-owner", runtimeConfig: sshDaytonaConfig(owner) },
      { workspaceId: "ws-fork", runtimeConfig: sshDaytonaConfig({ ...owner, forked: true }) },
      { workspaceId: "ws-attached", runtimeConfig: sshDaytonaConfig(attached) }
    );
    claimRemovals();
    // Tokens and include blocks are per stored string: the name and the id.
    await rig.service.ensureSshAccess("xum-owner-abc123");
    await rig.service.ensureSshAccess("sb-7");
    const remove = (workspaceId: string, daytona: DaytonaSandboxConfig) =>
      makeRuntime(daytona, rig, { workspaceId }).deleteWorkspace(
        "/home/me/project",
        workspaceId,
        false
      );

    // The fork still uses the name: its access stays.
    expect((await remove("ws-owner", owner)).success).toBe(true);
    expect(rig.writer.removed).toEqual([]);
    // The fork was the last one to use the name.
    expect((await remove("ws-fork", { ...owner, forked: true })).success).toBe(true);
    expect(rig.writer.removed).toEqual(["xum-owner-abc123"]);
    expect(rig.writer.tokens.has("sb-7")).toBe(true);
    expect(rig.plane.find("sb-7")).toBeDefined();
  });

  it("applies the archive setting when removing the last attached workspace leaves only an archived owner", async () => {
    const sshDelete = spyOn(SSHRuntime.prototype, "deleteWorkspace").mockResolvedValue({
      success: true,
      deletedPath: "/path",
    });
    try {
      const sandbox = rig.plane.addSandbox({ id: "xum-owner" });
      // The owner was archived while the attached workspace worked there: it left the sandbox alone.
      rig.workspaces.splice(0, rig.workspaces.length, {
        workspaceId: "ws-owner",
        runtimeConfig: sshDaytonaConfig({ sandboxId: "xum-owner", shared: false }),
        archived: true,
      });
      const attached = { sandboxId: "xum-owner", shared: true };
      for (const [behavior, expected] of [
        ["stop", "stopped"],
        ["delete", "stopped"],
        ["keep", "started"],
      ] as const) {
        sandbox.state = "started";
        rig.archiveBehavior = behavior;
        const removal = await makeRuntime(attached, rig, {
          workspaceId: "ws-attached",
        }).deleteWorkspace("/home/me/project", "feature", false);
        expect(removal.success).toBe(true);
        expect(sandbox.state).toBe(expected);
        if (behavior === "delete" && removal.success) {
          expect(removal.notice).toContain("stopped, not deleted");
        }
      }
      // The archived owner's checkout is still on it: never deleted.
      expect(rig.plane.find("xum-owner")).toBe(sandbox);
    } finally {
      sshDelete.mockRestore();
    }
  });

  it("never deletes an attached sandbox, even with its last workspace", async () => {
    rig.plane.addSandbox({ id: "sb-users" });
    rig.workspaces.push({
      workspaceId: "ws-1",
      runtimeConfig: sshDaytonaConfig({ sandboxId: "sb-users", shared: true }),
    });

    for (const force of [false, true]) {
      const runtime = makeRuntime({ sandboxId: "sb-users", shared: true });
      expect((await runtime.deleteWorkspace("/home/me/project", "feature", force)).success).toBe(
        true
      );
    }
    expect(rig.plane.find("sb-users")).toBeDefined();
    // Only Xum's own access goes: the token is revoked and the include block removed.
    expect(rig.writer.removed).toContain("sb-users");
  });
});

describe("DaytonaSSHRuntime delete checks on the unresolved ~ workspace path", () => {
  it("refuses to delete a dirty worktree under ~/... and keeps the sandbox", async () => {
    execSpy.mockRestore();
    const home = path.join(rig.rootDir, "sandbox-home");
    rig.plane.addSandbox({ id: "sb-dirty" });
    const runtime = makeRuntime({ sandboxId: "sb-dirty", shared: false }, rig, {
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
    await rig.service.ensureSshAccess("sb-tok");
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
    await rig.service.loadPersistedTokens();
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

  it("runs no ssh command before the include file's tokens are loaded, retrying a failed load", async () => {
    const stale = "earlier-process-token-unloaded-9c1d";
    rig.plane.addSandbox({ id: "sb-old" });
    rig.writer.tokens.set("sb-old", stale);
    const readTokens = spyOn(rig.writer, "readTokens").mockRejectedValueOnce(
      new Error("EIO: i/o error, read")
    );
    // Startup goes on without them.
    let startupLoad: unknown;
    await rig.service.loadPersistedTokens().catch((error: unknown) => (startupLoad = error));
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

  // A settings change must not leave an alias behind that a UI runtime's next ssh (which never
  // runs ensureReady) would use to reach the old account's sandbox with a still-live token.
  it("refuses ssh to an old account's alias until the settings change removed it", async () => {
    execSpy.mockRestore();
    rig.plane.addSandbox({ id: "sb-old" });
    rig.addAccount("new-key");
    await rig.service.ensureSshAccess("sb-old");
    const oldToken = rig.writer.tokens.get("sb-old");
    const unwritable = () => new Error("EACCES: permission denied, open 'daytona.conf'");
    const removeTokens = spyOn(rig.writer, "removeSandboxTokens")
      .mockImplementationOnce(() => Promise.reject(unwritable()))
      .mockImplementationOnce(() => Promise.reject(unwritable()));
    await rig.service.setConfig({ apiKey: "new-key" });
    expect(rig.writer.tokens.get("sb-old")).toBe(oldToken);
    let spawned = 0;
    const local = localShellTransport(rig.rootDir);
    const runtime = makeRuntime({ sandboxId: "sb-old" }, rig, {
      transport: {
        ...local,
        spawnRemoteProcess: (command, options) => {
          spawned++;
          return local.spawnRemoteProcess(command, options);
        },
      },
    });

    const refused = await runtime.exec("true", { cwd: "/tmp", timeout: 10 }).then(
      () => new Error("exec unexpectedly succeeded"),
      (rejection: unknown) => rejection
    );
    expect(String(refused)).toContain("old Daytona account");
    expect(String(refused)).not.toContain(oldToken ?? "missing");
    expect(spawned).toBe(0);
    expect(removeTokens).toHaveBeenCalledTimes(2);

    // Writable again: the next attempt removes the alias first, then goes on.
    const result = await runtimeHelpers.execBuffered(runtime, "true", { cwd: "/tmp", timeout: 10 });
    expect(result.exitCode).toBe(0);
    expect(removeTokens).toHaveBeenCalledTimes(3);
    expect(rig.writer.tokens.has("sb-old")).toBe(false);
    expect(spawned).toBe(1);
  });

  // Writing the sandbox's block for the new account replaces the old token, which is all the
  // removal was for: a removal that keeps failing does not block that sandbox for good.
  it("lets the new account set a sandbox up again while the old alias cleanup fails", async () => {
    execSpy.mockRestore();
    rig.plane.addSandbox({ id: "sb-both" });
    const next = rig.addAccount("new-key");
    next.tokenPrefix = "new-tok";
    next.addSandbox({ id: "sb-both" });
    await rig.service.ensureSshAccess("sb-both");
    const oldToken = rig.writer.tokens.get("sb-both");
    spyOn(rig.writer, "removeSandboxTokens").mockImplementation(() =>
      Promise.reject(new Error("EACCES: permission denied, open 'daytona.conf'"))
    );
    await rig.service.setConfig({ apiKey: "new-key" });

    await rig.service.ensureSshAccess("sb-both");

    expect(rig.writer.tokens.get("sb-both")).not.toBe(oldToken);
    const runtime = makeRuntime({ sandboxId: "sb-both" }, rig, {
      transport: localShellTransport(rig.rootDir),
    });
    const result = await runtimeHelpers.execBuffered(runtime, "true", { cwd: "/tmp", timeout: 10 });
    expect(result.exitCode).toBe(0);
  });

  it("revokes the token another backend wrote as a sandbox's first alias once it replaces it", async () => {
    rig.plane.addSandbox({ id: "sb-theirs-first" });
    await rig.service.loadPersistedTokens();
    // After this backend's startup load, another one sets the sandbox up first.
    rig.writer.tokens.set("sb-theirs-first", "other-backend-first-token");

    await rig.service.ensureSshAccess("sb-theirs-first");

    expect(rig.writer.tokens.get("sb-theirs-first")).not.toBe("other-backend-first-token");
    expect(rig.writer.fullWrites).toEqual(["sb-theirs-first"]);
    expect(rig.plane.revokedTokens).toEqual(["other-backend-first-token"]);
  });

  it("follows the include file another backend sharing the root edits", async () => {
    rig.plane.addSandbox({ id: "sb-both" });
    await rig.service.ensureSshAccess("sb-both");
    const ours = rig.writer.tokens.get("sb-both");

    // Another backend archives a workspace on the sandbox and removes its alias.
    rig.writer.tokens.delete("sb-both");
    await rig.service.ensureSshAccess("sb-both");
    expect(rig.writer.fullWrites).toEqual(["sb-both", "sb-both"]);
    const rewritten = rig.writer.tokens.get("sb-both");
    expect(rewritten).toBeDefined();
    expect(rewritten).not.toBe(ours);

    // Another backend mints and writes its own token; ssh now sends that one.
    const theirs = "other-backend-token-5e2b";
    rig.writer.tokens.set("sb-both", theirs);
    const runtime = makeRuntime({ sandboxId: "sb-both" }, rig, {
      transport: {
        ...localShellTransport(rig.rootDir),
        spawnRemoteProcess: () =>
          Promise.reject(
            new RuntimeError(`${theirs}@127.0.0.1: Permission denied (publickey).`, "network")
          ),
      },
    });
    const error = await runtime.exec("true", { cwd: "/tmp", timeout: 10 }).then(
      () => new Error("exec unexpectedly succeeded"),
      (rejection: unknown) => rejection
    );
    expect(String(error)).not.toContain(theirs);
    expect(String(error)).toContain(DAYTONA_TOKEN_PLACEHOLDER);

    // Held as the sandbox's token: a release revokes it with the block.
    rig.writer.tokens.set("sb-both", theirs);
    await rig.service.ensureSshAccess("sb-both");
    await rig.service.releaseSshAccess("sb-both");
    expect(rig.plane.revokedTokens).toContain(theirs);
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

  it("reports a sandbox deleted outside Xum instead of the refused token", async () => {
    rig.plane.addSandbox({ id: "sb-gone" });
    await rig.service.ensureSshAccess("sb-gone");
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
    await rig.service.ensureSshAccess("sb-race");
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
    await rig.service.ensureSshAccess("sb-rev");
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
