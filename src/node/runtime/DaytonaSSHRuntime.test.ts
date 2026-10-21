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
import { DAYTONA_READY_CACHE_MS } from "@/node/services/daytona/daytonaService";
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
    // The second check joins the first one's start, so it reports that start too.
    expect(phases.map((seen) => seen.includes("starting"))).toEqual([true, true]);
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

  it("deletes the sandbox it created when setup fails afterwards", async () => {
    rig.writer.verifyError = new Error("Your ssh config sets User");
    const params = initParams();

    const failure = await makeRuntime({ sandboxId: "xum-doomed", shared: false, ...SMALL })
      .postCreateSetup(params)
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("Your ssh config sets User");

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
      expect(ready.error).toContain("Your ssh config sets User");
    }
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
    expect(rig.plane.calls.filter((call) => call.startsWith("DELETE /sandbox/"))).toEqual([]);
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
        { workspaceId: "ws-1", runtimeConfig: sshDaytonaConfig(source) },
        { workspaceId: "ws-fork", runtimeConfig: sshDaytonaConfig(fork) }
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

  it("waits for a sandbox Daytona is already destroying instead of refusing the delete", async () => {
    // A failed setup deletes the sandbox it created while the workspace's removal runs.
    rig.plane.addSandbox({ id: "sb-going", state: "destroying", pendingPolls: 2 });

    const result = await makeRuntime({ sandboxId: "sb-going", shared: false }).deleteWorkspace(
      "/home/me/project",
      "feature",
      false
    );

    expect(result.success).toBe(true);
    expect(rig.plane.find("sb-going")).toBeUndefined();
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
