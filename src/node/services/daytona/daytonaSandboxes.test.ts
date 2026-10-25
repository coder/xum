import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DaytonaCredentialsStore } from "@/node/config/daytonaCredentialsStore";
import { DaytonaApiError } from "./daytonaClient";
import { createDaytonaTestRig, type DaytonaTestRig } from "./daytona.testHarness";
import {
  DAYTONA_LABEL_INSTANCE,
  DAYTONA_LABEL_PROJECT,
  mapDaytonaSandboxState,
} from "./daytonaSandboxes";
import { DaytonaService } from "./daytonaService";

describe("DaytonaSandboxes", () => {
  let rig: DaytonaTestRig;

  beforeEach(async () => {
    rig = await createDaytonaTestRig();
  });

  afterEach(async () => {
    await rig.cleanup();
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
    rig.plane.addSandbox({
      id: "sb-1",
      stateScript: ["stopped", "stopped", "starting", "started"],
    });
    let startingEvents = 0;
    const sandbox = await rig.service.sandboxes.startAndWait("sb-1", rig.clock.now + 60_000, {
      onStarting: () => startingEvents++,
    });
    expect(sandbox.state).toBe("started");
    expect(startingEvents).toBe(1);
    expect(rig.plane.countCalls("POST /sandbox/sb-1/start")).toBe(1);
  });

  it("gives up at the deadline with a timeout error", async () => {
    rig.plane.addSandbox({ id: "sb-1", stateScript: ["starting"] });
    const deadline = rig.clock.now + 7_000;
    const error = await rig.service.sandboxes
      .startAndWait("sb-1", deadline)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaytonaApiError);
    expect((error as DaytonaApiError).kind).toBe("timeout");
    expect(rig.clock.now).toBe(deadline);
  });

  it("fails fast on a missing sandbox or an error state instead of polling", async () => {
    const start = rig.clock.now;
    const missing = await rig.service.sandboxes
      .startAndWait("sb-1", start + 60_000)
      .catch((e: unknown) => e);
    expect((missing as DaytonaApiError).kind).toBe("not_found");
    expect(await rig.service.sandboxes.getSandboxState("sb-1")).toEqual({ state: "missing" });

    rig.plane.addSandbox({
      id: "sb-1",
      state: "build_failed",
      errorReason: "Dockerfile step 3 failed",
    });
    const failed = await rig.service.sandboxes
      .startAndWait("sb-1", start + 60_000)
      .catch((e: unknown) => e);
    expect((failed as Error).message).toContain("Dockerfile step 3 failed");
    // Neither polled: the test clock only moves when a poll sleeps.
    expect(rig.clock.now).toBe(start);
  });

  it("labels sandboxes with an instance id that is stable across service instances", async () => {
    const labels = await rig.service.sandboxes.buildLabels({
      workspaceId: "ws-1",
      projectPath: "/home/me/secret-dir/my-project",
    });
    const again = await new DaytonaService({
      credentialsStore: new DaytonaCredentialsStore(rig.rootDir, {}),
      rootDir: rig.rootDir,
    }).sandboxes.buildLabels({
      workspaceId: "ws-2",
      projectPath: "/x/other",
    });
    expect(labels[DAYTONA_LABEL_INSTANCE]).toBe(again[DAYTONA_LABEL_INSTANCE]);
    expect(labels[DAYTONA_LABEL_PROJECT]).toBe("my-project");
  });

  it("refuses to start or open a sandbox without this install's label", async () => {
    rig.plane.addSandbox({ id: "sb-stopped-foreign", state: "stopped", labels: {} });
    rig.plane.addSandbox({
      id: "sb-started-foreign",
      labels: { [DAYTONA_LABEL_INSTANCE]: "another-install" },
    });

    for (const id of ["sb-stopped-foreign", "sb-started-foreign"]) {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(rig.service.sandboxes.ensureSandboxReady(id)).rejects.toThrow("label");
      expect(rig.plane.countCalls(`POST /sandbox/${id}/start`)).toBe(0);
      expect(rig.plane.countCalls(`POST /sandbox/${id}/ssh-access`)).toBe(0);
    }
  });

  it("deletes only a sandbox with this install's label, and drops Xum's access to any", async () => {
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
  });

  it("never deletes a sandbox that took the name after the ownership check", async () => {
    rig.plane.addSandbox({ id: "id-old", name: "ws-1" });
    await rig.service.ssh.ensureSshAccess("ws-1");
    // The revoke runs between the check and the delete: the sandbox goes, another takes its name.
    rig.plane.onRequest.set("DELETE /sandbox/ws-1/ssh-access", () => {
      rig.plane.sandboxes.delete("id-old");
      rig.plane.addSandbox({ id: "id-new", name: "ws-1", labels: {} });
      return Promise.resolve();
    });

    await rig.service.sandboxes.deleteSandbox("ws-1");
    expect(rig.plane.find("id-new")).toBeDefined();
    expect(rig.plane.countCalls("DELETE /sandbox/ws-1")).toBe(0);
  });

  it("sends no delete for a sandbox that is already gone", async () => {
    await rig.service.sandboxes.deleteSandbox("ws-gone");
    expect(rig.plane.countCalls("DELETE /sandbox/ws-gone")).toBe(0);
  });
});
