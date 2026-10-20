import { afterEach, beforeEach, describe, expect, it, spyOn, type Mock } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import type { DaytonaSandboxConfig } from "@/common/orpc/schemas/daytona";
import type { RuntimeConfig } from "@/common/types/runtime";
import {
  createDaytonaTestRig,
  type DaytonaTestRig,
} from "@/node/services/daytona/daytona.testHarness";
import { DAYTONA_READY_CACHE_MS } from "@/node/services/daytona/daytonaService";
import * as runtimeHelpers from "@/node/utils/runtime/helpers";
import { DaytonaSSHRuntime } from "./DaytonaSSHRuntime";
import type { InitLogger, RuntimeStatusEvent, WorkspaceInitParams } from "./Runtime";
import { SSHRuntime } from "./SSHRuntime";
import { createSSHTransport } from "./transports";

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

function makeRuntime(daytona: DaytonaSandboxConfig, testRig = rig): DaytonaSSHRuntime {
  const config = { host: "placeholder.xum--daytona", srcBaseDir: "~/src", daytona };
  return new DaytonaSSHRuntime(config, createSSHTransport(config, false), testRig.service, {
    workspaceId: "ws-1",
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
    const results = await Promise.all([
      makeRuntime({ sandboxId: "sb-archived" }).ensureReady(),
      makeRuntime({ sandboxId: "sb-archived" }).ensureReady(),
    ]);
    expect(results).toEqual([{ ready: true }, { ready: true }]);
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
    expect(rig.plane.find("sb-clean")).toBeUndefined();
    expect(rig.writer.removed).toContain("sb-clean");
    expect(rig.plane.revokedTokens).toHaveLength(1);
  });

  it("never deletes a sandbox shared with a fork", async () => {
    rig.plane.addSandbox({ id: "sb-parent" });
    const forkSpy = spyOn(SSHRuntime.prototype, "forkWorkspace").mockResolvedValue({
      success: true,
      workspacePath: "/fork",
    });
    try {
      const runtime = makeRuntime({ sandboxId: "sb-parent", shared: false });
      const fork = await runtime.forkWorkspace({
        projectPath: "/home/me/project",
        sourceWorkspaceName: "feature",
        newWorkspaceName: "feature-fork",
        initLogger: initParams().initLogger,
      });
      for (const config of [fork.forkedRuntimeConfig, fork.sourceRuntimeConfig]) {
        expect(config?.type === "ssh" ? config.daytona?.shared : undefined).toBe(true);
      }

      expect((await runtime.deleteWorkspace("/home/me/project", "feature", false)).success).toBe(
        true
      );
      expect(rig.plane.find("sb-parent")).toBeDefined();
    } finally {
      forkSpy.mockRestore();
    }
  });
});
