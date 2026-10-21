import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { RuntimeConfig } from "@/common/types/runtime";
import { createDaytonaTestRig, type DaytonaTestRig } from "./daytona.testHarness";
import { Ok } from "@/common/types/result";
import {
  DaytonaReconciler,
  listDaytonaWorkspaceRefs,
  type DaytonaReconcilerOptions,
} from "./daytonaReconciler";
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

/** Workspace ids the reconciler asked about, in order. */
let activityChecks: string[];

function makeReconciler(
  workspaces: Array<{ id: string; runtimeConfig: RuntimeConfig; archivedAt?: string }>,
  activeIds: string[],
  callTimeoutMs?: number,
  hasUnsettledRemoteJobs?: DaytonaReconcilerOptions["hasUnsettledRemoteJobs"]
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
    hasUnsettledRemoteJobs,
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

  it("keeps the sandbox of a workspace created while the sandboxes were listed", async () => {
    const workspaces: Array<{ id: string; runtimeConfig: RuntimeConfig }> = [];
    // A creation persists its workspace, then creates and starts its sandbox, during the list.
    rig.plane.onRequest.set("GET /sandbox", () => {
      workspaces.push({ id: "ws-new", runtimeConfig: daytonaConfig("xum-new") });
      rig.plane.addSandbox({ id: "sb-new", name: "xum-new", labels: instanceLabels });
      return Promise.resolve();
    });

    await makeReconciler(workspaces, []).sweep();

    expect(rig.plane.find("xum-new")?.state).toBe("started");
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

  it("keeps only started sandboxes alive and skips them all when the list fails", async () => {
    rig.plane.addSandbox({ id: "sb-stopped", state: "stopped", labels: instanceLabels });
    // Attached by the user: no label of this install, so only a lookup finds it.
    rig.plane.addSandbox({ id: "sb-attached" });
    const workspaces = [
      { id: "ws-stopped", runtimeConfig: daytonaConfig("sb-stopped") },
      { id: "ws-attached", runtimeConfig: daytonaConfig("sb-attached") },
    ];
    const active = ["ws-stopped", "ws-attached"];

    await makeReconciler(workspaces, active).sweep();
    expect(rig.plane.countCalls("POST /sandbox/sb-stopped/last-activity")).toBe(0);
    // Checking a stopped sandbox's jobs over ssh would start it.
    expect(activityChecks).toEqual(["ws-attached"]);
    expect(rig.plane.countCalls("POST /sandbox/sb-attached/last-activity")).toBe(1);

    rig.plane.failingRoutes.add("GET /sandbox");
    rig.plane.calls.length = 0;
    await makeReconciler(workspaces, active).sweep();
    expect(rig.plane.calls.filter((call) => call.endsWith("/last-activity"))).toEqual([]);
    expect(activityChecks).toEqual([]);
  });

  it("asks about an attached sandbox's jobs only once its state shows it started", async () => {
    // Attached by the user (no label of this install) and stopped: an ssh job probe would
    // start it.
    rig.plane.addSandbox({ id: "sb-attached-off", state: "stopped" });

    await makeReconciler(
      [{ id: "ws-attached-off", runtimeConfig: daytonaConfig("sb-attached-off") }],
      ["ws-attached-off"]
    ).sweep();

    expect(activityChecks).toEqual([]);
    expect(rig.plane.countCalls("POST /sandbox/sb-attached-off/last-activity")).toBe(0);
  });

  it("keeps a sandbox alive under jobs that survived a Xum crash, probing a clear one once", async () => {
    rig.plane.addSandbox({ id: "sb-1", name: "xum-survivor", labels: instanceLabels });
    rig.plane.addSandbox({ id: "sb-2", name: "xum-quiet", labels: instanceLabels });
    const probed: string[] = [];
    const reconciler = makeReconciler(
      [
        { id: "ws-survivor", runtimeConfig: daytonaConfig("xum-survivor") },
        { id: "ws-quiet", runtimeConfig: daytonaConfig("xum-quiet") },
      ],
      // Neither streams nor holds a job in this process's memory.
      [],
      undefined,
      (ref) => {
        probed.push(ref.workspaceId);
        return Promise.resolve(Ok(ref.workspaceId === "ws-survivor"));
      }
    );

    await reconciler.sweep();
    await reconciler.sweep();

    expect(rig.plane.countCalls("POST /sandbox/sb-1/last-activity")).toBe(2);
    expect(rig.plane.countCalls("POST /sandbox/sb-2/last-activity")).toBe(0);
    // A probe is itself ssh traffic that Daytona counts: a clear workspace is not probed again.
    expect(probed).toEqual(["ws-survivor", "ws-quiet", "ws-survivor"]);
  });
});
