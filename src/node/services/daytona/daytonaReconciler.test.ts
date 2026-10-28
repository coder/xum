import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { RuntimeConfig } from "@/common/types/runtime";
import { createDaytonaTestRig, type DaytonaTestRig } from "./daytona.testHarness";
import { DaytonaReconciler, listDaytonaWorkspaceRefs } from "./daytonaReconciler";
import { DAYTONA_LABEL_INSTANCE } from "./daytonaSandboxes";

let rig: DaytonaTestRig;
let instanceLabels: Record<string, string>;

beforeEach(async () => {
  rig = await createDaytonaTestRig();
  instanceLabels = { [DAYTONA_LABEL_INSTANCE]: await rig.service.sandboxes.getInstanceId() };
});

afterEach(async () => {
  await rig.cleanup();
});

/** A workspace on a sandbox Xum created: its config records the sandbox's id. */
function daytonaConfig(
  sandboxName: string,
  sandboxId: string | undefined = sandboxName
): RuntimeConfig {
  return {
    type: "ssh",
    host: `${sandboxName}.xum--daytona`,
    srcBaseDir: "~/src",
    daytona: { sandboxName, sandboxId },
  };
}

/** Workspace ids the reconciler asked about, in order. */
let activityChecks: string[];

function makeReconciler(
  workspaces: Array<{ id: string; runtimeConfig: RuntimeConfig }>,
  activeIds: string[],
  callTimeoutMs?: number
): DaytonaReconciler {
  const config = { projects: new Map([["/home/me/project", { workspaces }]]) };
  activityChecks = [];
  return new DaytonaReconciler({
    daytonaService: rig.service,
    listWorkspaces: () => listDaytonaWorkspaceRefs(config),
    isWorkspaceActive: (workspaceId) => {
      activityChecks.push(workspaceId);
      return Promise.resolve(activeIds.includes(workspaceId));
    },
    callTimeoutMs,
  });
}

describe("DaytonaReconciler.sweep", () => {
  it("refreshes activity only for sandboxes of active workspaces", async () => {
    rig.plane.addSandbox({ id: "sb-1", name: "xum-busy-aaaaaa", labels: instanceLabels });
    rig.plane.addSandbox({ id: "sb-2", name: "xum-idle-bbbbbb", labels: instanceLabels });

    await makeReconciler(
      [
        { id: "ws-busy", runtimeConfig: daytonaConfig("xum-busy-aaaaaa", "sb-1") },
        { id: "ws-idle", runtimeConfig: daytonaConfig("xum-idle-bbbbbb", "sb-2") },
      ],
      ["ws-busy"]
    ).sweep();

    expect(rig.plane.countCalls("POST /sandbox/sb-1/last-activity")).toBe(1);
    expect(rig.plane.countCalls("POST /sandbox/sb-2/last-activity")).toBe(0);
  });

  it("keeps alive the recorded sandbox, not a later one that took its name", async () => {
    // The workspace's own sandbox is gone; another of this install's took the name.
    rig.plane.addSandbox({ id: "sb-new", name: "xum-busy-aaaaaa", labels: instanceLabels });

    await makeReconciler(
      [{ id: "ws-busy", runtimeConfig: daytonaConfig("xum-busy-aaaaaa", "sb-old") }],
      ["ws-busy"]
    ).sweep();

    expect(rig.plane.countCalls("POST /sandbox/sb-new/last-activity")).toBe(0);
  });

  it("leaves an active workspace's sandbox alone once it lost this install's label", async () => {
    rig.plane.addSandbox({ id: "sb-1", name: "xum-foreign-aaaaaa", labels: {} });

    await makeReconciler(
      [{ id: "ws-busy", runtimeConfig: daytonaConfig("xum-foreign-aaaaaa", "sb-1") }],
      ["ws-busy"]
    ).sweep();

    expect(rig.plane.countCalls("POST /sandbox/sb-1/last-activity")).toBe(0);
  });

  it("moves on past a hung control-plane call", async () => {
    rig.plane.addSandbox({ id: "sb-hung", labels: instanceLabels });
    rig.plane.addSandbox({ id: "sb-next", labels: instanceLabels });
    rig.plane.hangingRoutes.add("POST /sandbox/sb-hung/last-activity");

    await makeReconciler(
      [
        { id: "ws-hung", runtimeConfig: daytonaConfig("sb-hung") },
        { id: "ws-next", runtimeConfig: daytonaConfig("sb-next") },
      ],
      ["ws-hung", "ws-next"],
      // Long enough that the calls that answer never time out on a loaded machine.
      250
    ).sweep();

    expect(rig.plane.countCalls("POST /sandbox/sb-next/last-activity")).toBe(1);
  });

  it("keeps only started sandboxes alive and skips them all when the list fails", async () => {
    rig.plane.addSandbox({ id: "sb-stopped", state: "stopped", labels: instanceLabels });
    rig.plane.addSandbox({ id: "sb-started", labels: instanceLabels });
    const workspaces = [
      { id: "ws-stopped", runtimeConfig: daytonaConfig("sb-stopped") },
      { id: "ws-started", runtimeConfig: daytonaConfig("sb-started") },
    ];
    const active = ["ws-stopped", "ws-started"];

    await makeReconciler(workspaces, active).sweep();
    expect(rig.plane.countCalls("POST /sandbox/sb-stopped/last-activity")).toBe(0);
    // Checking a stopped sandbox's jobs over ssh would start it.
    expect(activityChecks).toEqual(["ws-started"]);
    expect(rig.plane.countCalls("POST /sandbox/sb-started/last-activity")).toBe(1);

    rig.plane.failingRoutes.add("GET /sandbox");
    rig.plane.calls.length = 0;
    await makeReconciler(workspaces, active).sweep();
    expect(rig.plane.calls.filter((call) => call.endsWith("/last-activity"))).toEqual([]);
    expect(activityChecks).toEqual([]);
  });
});
