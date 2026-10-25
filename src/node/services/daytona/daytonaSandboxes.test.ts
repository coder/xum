import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { DaytonaCredentialsStore } from "@/node/config/daytonaCredentialsStore";
import { DaytonaApiError } from "./daytonaClient";
import { createDaytonaTestRig, ScriptedSandboxControlPlane } from "./daytona.testHarness";
import {
  DAYTONA_LABEL_INSTANCE,
  DAYTONA_LABEL_PROJECT,
  mapDaytonaSandboxState,
} from "./daytonaSandboxes";
import { DaytonaService } from "./daytonaService";

describe("DaytonaSandboxes", () => {
  let rootDir: string;
  let clock: number;
  let plane: ScriptedSandboxControlPlane;
  let service: DaytonaService;
  const sleeps: number[] = [];

  function makeService(env: NodeJS.ProcessEnv = { DAYTONA_API_KEY: "k" }): DaytonaService {
    return new DaytonaService({
      credentialsStore: new DaytonaCredentialsStore(rootDir, env),
      rootDir,
      fetch: plane.fetch,
      now: () => clock,
      sleep: (ms) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    });
  }

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-daytona-service-"));
    clock = Date.parse("2026-01-01T00:00:00Z");
    plane = new ScriptedSandboxControlPlane(() => clock);
    sleeps.length = 0;
    service = makeService();
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("collapses Daytona states to the ones Xum acts on", () => {
    const expected: Record<string, string> = {
      creating: "starting",
      resuming: "starting",
      stopping: "starting",
      archiving: "starting",
      started: "started",
      stopped: "stopped",
      paused: "stopped",
      archived: "archived",
      build_failed: "error",
      destroyed: "error",
      some_future_state: "error",
    };
    for (const [raw, state] of Object.entries(expected)) {
      expect(`${raw} -> ${mapDaytonaSandboxState(raw)}`).toBe(`${raw} -> ${state}`);
    }
  });

  it("starts a stopped sandbox once and waits until it reports started", async () => {
    plane.states = ["stopped", "stopped", "starting", "started"];
    let startingEvents = 0;
    const sandbox = await service.sandboxes.startAndWait("sb-1", clock + 60_000, {
      onStarting: () => startingEvents++,
    });
    expect(sandbox.state).toBe("started");
    expect(startingEvents).toBe(1);
    expect(plane.calls.filter((call) => call === "POST /sandbox/sb-1/start")).toHaveLength(1);
  });

  it("gives up at the deadline with a timeout error", async () => {
    plane.states = ["starting"];
    const deadline = clock + 7_000;
    const error = await service.sandboxes.startAndWait("sb-1", deadline).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaytonaApiError);
    expect((error as DaytonaApiError).kind).toBe("timeout");
    expect(clock).toBe(deadline);
  });

  it("fails fast on a missing sandbox or an error state instead of polling", async () => {
    plane.exists = false;
    const missing = await service.sandboxes
      .startAndWait("sb-1", clock + 60_000)
      .catch((e: unknown) => e);
    expect((missing as DaytonaApiError).kind).toBe("not_found");
    expect(await service.sandboxes.getSandboxState("sb-1")).toEqual({ state: "missing" });

    plane.exists = true;
    plane.states = ["build_failed"];
    plane.errorReason = "Dockerfile step 3 failed";
    const failed = await service.sandboxes
      .startAndWait("sb-1", clock + 60_000)
      .catch((e: unknown) => e);
    expect((failed as Error).message).toContain("Dockerfile step 3 failed");
    expect(sleeps).toEqual([]);
  });

  it("labels sandboxes with an instance id that is stable across service instances", async () => {
    const labels = await service.sandboxes.buildLabels({
      workspaceId: "ws-1",
      projectPath: "/home/me/secret-dir/my-project",
    });
    const again = await makeService().sandboxes.buildLabels({
      workspaceId: "ws-2",
      projectPath: "/x/other",
    });
    expect(labels[DAYTONA_LABEL_INSTANCE]).toBe(again[DAYTONA_LABEL_INSTANCE]);
    expect(labels[DAYTONA_LABEL_PROJECT]).toBe("my-project");
  });
});

describe("DaytonaSandboxes.deleteSandbox", () => {
  it("deletes only a sandbox with this install's label, and drops Xum's access to any", async () => {
    const rig = await createDaytonaTestRig();
    try {
      rig.plane.addSandbox({
        id: "sb-foreign",
        labels: { [DAYTONA_LABEL_INSTANCE]: "another-install" },
      });
      rig.plane.addSandbox({ id: "sb-unlabeled", labels: {} });
      rig.plane.addSandbox({ id: "sb-own" });
      await rig.service.ssh.ensureSshAccess("sb-foreign");

      await rig.service.sandboxes.deleteSandbox("sb-foreign");
      await rig.service.sandboxes.deleteSandbox("sb-unlabeled");
      expect(rig.plane.find("sb-foreign")).toBeDefined();
      expect(rig.plane.find("sb-unlabeled")).toBeDefined();
      expect(rig.plane.countCalls("DELETE /sandbox/sb-foreign")).toBe(0);
      expect(rig.plane.countCalls("DELETE /sandbox/sb-unlabeled")).toBe(0);
      expect(rig.writer.tokens.has("sb-foreign")).toBe(false);

      await rig.service.sandboxes.deleteSandbox("sb-own");
      expect(rig.plane.find("sb-own")).toBeUndefined();
    } finally {
      await rig.cleanup();
    }
  });
});
