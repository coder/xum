import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { RuntimeConfig } from "@/common/types/runtime";
import { createDaytonaTestRig, type DaytonaTestRig } from "./daytona.testHarness";
import { DaytonaReconciler, listDaytonaWorkspaceRefs } from "./daytonaReconciler";
import { DAYTONA_LABEL_INSTANCE } from "./daytonaService";

let rig: DaytonaTestRig;
let instanceLabels: Record<string, string>;

beforeEach(async () => {
  rig = await createDaytonaTestRig();
  instanceLabels = { [DAYTONA_LABEL_INSTANCE]: await rig.service.getInstanceId() };
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

function makeReconciler(
  workspaces: Array<{ id: string; runtimeConfig: RuntimeConfig; archivedAt?: string }>,
  activeIds: string[],
  callTimeoutMs?: number
): DaytonaReconciler {
  const config = { projects: new Map([["/home/me/project", { workspaces }]]) };
  return new DaytonaReconciler({
    daytonaService: rig.service,
    listWorkspaces: () => listDaytonaWorkspaceRefs(config),
    isWorkspaceActive: (workspaceId) => activeIds.includes(workspaceId),
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

  it("stops only unreferenced running sandboxes of this install, archived workspaces included", async () => {
    rig.plane.addSandbox({ id: "sb-orphan", labels: instanceLabels });
    rig.plane.addSandbox({ id: "sb-archived-ws", labels: instanceLabels });
    rig.plane.addSandbox({ id: "sb-creating", state: "creating", labels: instanceLabels });
    rig.plane.addSandbox({ id: "sb-other-install", labels: { [DAYTONA_LABEL_INSTANCE]: "x" } });

    await makeReconciler(
      [
        {
          id: "ws-archived",
          runtimeConfig: daytonaConfig("sb-archived-ws"),
          archivedAt: "2026-01-01T00:00:00Z",
        },
      ],
      []
    ).sweep();

    expect(rig.plane.find("sb-orphan")?.state).toBe("stopped");
    expect(rig.plane.find("sb-archived-ws")?.state).toBe("started");
    expect(rig.plane.find("sb-creating")?.state).toBe("creating");
    expect(rig.plane.find("sb-other-install")?.state).toBe("started");
    // Never deletes: an orphan may still hold unpushed work.
    expect(rig.plane.calls.some((call) => call.startsWith("DELETE /sandbox/"))).toBe(false);
  });

  it("moves on past a hung control-plane call", async () => {
    rig.plane.addSandbox({ id: "sb-hung", labels: instanceLabels });
    rig.plane.addSandbox({ id: "sb-orphan", labels: instanceLabels });
    rig.plane.hangingRoutes.add("POST /sandbox/sb-hung/last-activity");

    await makeReconciler(
      [{ id: "ws", runtimeConfig: daytonaConfig("sb-hung") }],
      ["ws"],
      20
    ).sweep();

    expect(rig.plane.find("sb-orphan")?.state).toBe("stopped");
  });

  it("refreshes an active workspace's ssh token before it expires", async () => {
    rig.plane.addSandbox({ id: "sb-1", labels: instanceLabels });
    await rig.service.ensureSshAccess("sb-1");
    const firstToken = rig.writer.tokens.get("sb-1");
    rig.clock.now += 50 * 60_000;

    await makeReconciler([{ id: "ws", runtimeConfig: daytonaConfig("sb-1") }], ["ws"]).sweep();

    expect(rig.writer.tokens.get("sb-1")).not.toBe(firstToken);
    expect(rig.plane.revokedTokens).toEqual([firstToken ?? ""]);
  });
});
