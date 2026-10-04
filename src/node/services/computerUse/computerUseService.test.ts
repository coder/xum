import { describe, expect, test } from "bun:test";

import type { ComputerUseStatus } from "@/common/orpc/schemas/computerUse";

import { createFakeBridge, createTestComputerUseService } from "./computerUseTestFixtures";

const REVOKED = /turned off by the user/;

/** Settles immediately so a rejection that happens before the assertion is never unhandled. */
function rejectionOf(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "resolved",
    (error: Error) => error.message
  );
}

describe("ComputerUseService support", () => {
  test.each([
    ["no host bridge", { bridge: null }, "requires_desktop_app"],
    ["windows", { bridge: createFakeBridge("win32") }, "unsupported_platform"],
    ["linux without DISPLAY", { bridge: createFakeBridge("linux"), env: {} }, "no_display"],
    [
      "input driver load failure",
      { driver: { ok: false as const, error: "libXtst.so.6: cannot open" } },
      "input_driver_unavailable",
    ],
  ] as const)("%s is unsupported and cannot be enabled", async (_name, options, reason) => {
    const { service } = createTestComputerUseService(options);
    expect(service.getStatus()).toMatchObject({ supported: false, unsupportedReason: reason });
    expect(await rejectionOf(service.setEnabled("a", true))).not.toBe("resolved");
    expect(service.isEnabledFor("a")).toBe(false);
  });

  test("linux with a display is supported without permission gates", () => {
    const { service } = createTestComputerUseService({ bridge: createFakeBridge("linux") });
    expect(service.getStatus()).toMatchObject({ supported: true, permissions: null });
  });

  test("only local and worktree runtimes can enable computer use", async () => {
    const { service } = createTestComputerUseService({
      runtimes: {
        local: { type: "local" },
        worktree: { type: "worktree", srcBaseDir: "/tmp/src" },
        ssh: { type: "ssh", host: "example", srcBaseDir: "/home/me/src" },
      },
    });
    expect(await rejectionOf(service.setEnabled("ssh", true))).toMatch(
      /only available in local workspaces/
    );
    expect(await rejectionOf(service.setEnabled("missing", true))).toMatch(/not found/);
    expect((await service.setEnabled("worktree", true)).ownerWorkspaceId).toBe("worktree");
    expect((await service.setEnabled("local", true)).ownerWorkspaceId).toBe("local");
  });
});

describe("ComputerUseService ownership", () => {
  test("enabling another workspace revokes the previous owner's in-flight and queued actions", async () => {
    const { service } = createTestComputerUseService();
    await service.setEnabled("a", true);

    const inFlight = rejectionOf(service.execute("a", { action: "wait", durationSeconds: 5 }));
    const queued = rejectionOf(service.execute("a", { action: "screenshot" }));
    await service.setEnabled("b", true);

    expect(await inFlight).toMatch(REVOKED);
    expect(await queued).toMatch(REVOKED);
    expect(service.isEnabledFor("a")).toBe(false);
    expect((await service.execute("b", { action: "screenshot" })).screenshot).toBeDefined();
  });

  test("the stop shortcut is registered only while an owner exists and turns computer use off", async () => {
    const { service, bridge } = createTestComputerUseService();
    const statuses: ComputerUseStatus[] = [];
    service.subscribe((status) => statuses.push(status));
    expect(bridge?.stopHandler).toBeNull();

    await service.setEnabled("a", true);
    await service.setEnabled("b", true);
    expect(bridge?.stopShortcutCalls).toBe(1);

    bridge?.stopHandler?.();
    expect(service.getStatus().ownerWorkspaceId).toBeNull();
    expect(bridge?.stopHandler).toBeNull();
    expect(statuses.at(-1)?.ownerWorkspaceId).toBeNull();
    expect(await rejectionOf(service.execute("b", { action: "screenshot" }))).toMatch(REVOKED);
  });
});

describe("ComputerUseService execution", () => {
  test("macOS Screen Recording gates every action and Accessibility gates input", async () => {
    const { service, bridge, driver } = createTestComputerUseService();
    await service.setEnabled("a", true);

    bridge!.permissions = { screenRecording: "denied", accessibility: "granted" };
    expect(await rejectionOf(service.execute("a", { action: "screenshot" }))).toMatch(
      /Screen Recording/
    );

    bridge!.permissions = { screenRecording: "granted", accessibility: "denied" };
    await service.execute("a", { action: "screenshot" });
    expect(await rejectionOf(service.execute("a", { action: "left_click", x: 1, y: 1 }))).toMatch(
      /Accessibility/
    );
    expect(driver.calls).toEqual([]);
  });

  test("clicks map screenshot pixels to display points and return a new screenshot", async () => {
    const { service, driver } = createTestComputerUseService();
    await service.setEnabled("a", true);

    expect(await rejectionOf(service.execute("a", { action: "left_click", x: 1, y: 1 }))).toMatch(
      /Take a screenshot first/
    );
    const shot = await service.execute("a", { action: "screenshot" });
    expect(shot.screenshot).toMatchObject({ width: 1356, height: 848 });

    const result = await service.execute("a", { action: "left_click", x: 678, y: 424 });
    expect(driver.calls).toEqual(["move 720,450", "click left"]);
    expect(result.screenshot).toBeDefined();
  });

  test("a display change since the last screenshot rejects coordinates", async () => {
    const { service, bridge, driver } = createTestComputerUseService();
    await service.setEnabled("a", true);
    await service.execute("a", { action: "screenshot" });

    bridge!.display = { ...bridge!.display, scaleFactor: 1 };
    expect(await rejectionOf(service.execute("a", { action: "mouse_move", x: 5, y: 5 }))).toMatch(
      /display changed/
    );
    expect(driver.calls).toEqual([]);
  });

  test("typing presses enter between lines and types in small chunks", async () => {
    const { service, driver } = createTestComputerUseService();
    await service.setEnabled("a", true);

    await service.execute("a", { action: "type", text: `${"x".repeat(20)}\nok` });
    expect(driver.calls).toEqual([`type ${"x".repeat(16)}`, "type xxxx", "key enter", "type ok"]);
  });

  test("a failing drag still releases the mouse button", async () => {
    const { service, driver } = createTestComputerUseService();
    driver.dragMouse = () => {
      throw new Error("injection failed");
    };
    await service.setEnabled("a", true);
    await service.execute("a", { action: "screenshot" });

    expect(
      await rejectionOf(
        service.execute("a", { action: "left_click_drag", startX: 0, startY: 0, x: 10, y: 10 })
      )
    ).toMatch("injection failed");
    expect(driver.calls).toEqual(["move 0,0", "toggle down left", "toggle up left"]);
  });
});
