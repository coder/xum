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

function daytonaConfig(sandboxId: string): RuntimeConfig {
  return {
    type: "ssh",
    host: `${sandboxId}.xum--daytona`,
    srcBaseDir: "~/src",
    daytona: { sandboxId },
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
    // Xum stores the name of a sandbox it created; last-activity needs the real id.
    rig.plane.addSandbox({ id: "sb-1", name: "xum-busy-aaaaaa", labels: instanceLabels });
    rig.plane.addSandbox({ id: "sb-2", name: "xum-idle-bbbbbb", labels: instanceLabels });

    await makeReconciler(
      [
        { id: "ws-busy", runtimeConfig: daytonaConfig("xum-busy-aaaaaa") },
        { id: "ws-idle", runtimeConfig: daytonaConfig("xum-idle-bbbbbb") },
      ],
      ["ws-busy"]
    ).sweep();

    expect(rig.plane.countCalls("POST /sandbox/sb-1/last-activity")).toBe(1);
    expect(rig.plane.countCalls("POST /sandbox/sb-2/last-activity")).toBe(0);
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
      20
    ).sweep();

    expect(rig.plane.countCalls("POST /sandbox/sb-next/last-activity")).toBe(1);
  });

  it("refreshes an active workspace's ssh token before it expires", async () => {
    rig.plane.addSandbox({ id: "sb-1", labels: instanceLabels });
    await rig.service.ssh.ensureSshAccess("sb-1");
    const firstToken = rig.writer.tokens.get("sb-1");
    rig.clock.now += 50 * 60_000;

    await makeReconciler([{ id: "ws", runtimeConfig: daytonaConfig("sb-1") }], ["ws"]).sweep();

    expect(rig.writer.tokens.get("sb-1")).not.toBe(firstToken);
    expect(rig.plane.revokedTokens).toEqual([firstToken ?? ""]);
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
