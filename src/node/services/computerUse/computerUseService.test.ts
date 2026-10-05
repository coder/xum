import { describe, expect, test } from "bun:test";

import type { ComputerUseStatus } from "@/common/orpc/schemas/computerUse";

import type { ComputerUseService } from "./computerUseService";
import {
  createFakeBridge,
  createTestComputerUseService,
  type FakeBridge,
} from "./computerUseTestFixtures";

const REVOKED = /turned off by the user/;
const MOVED = /moved computer use to another workspace/;
const ARCHIVED = { archivedAt: "2026-10-05T01:00:00.000Z" };

async function ownedWithScreenshot(options?: Parameters<typeof createTestComputerUseService>[0]) {
  const context = createTestComputerUseService(options);
  await context.service.setEnabled("a", true);
  await context.service.execute("a", { action: "screenshot" });
  return context;
}

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
      "a Wayland session with XWayland",
      { bridge: createFakeBridge("linux"), env: { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" } },
      "wayland_session",
    ],
    [
      "a Wayland session type",
      { bridge: createFakeBridge("linux"), env: { DISPLAY: ":0", XDG_SESSION_TYPE: "wayland" } },
      "wayland_session",
    ],
    ["input driver load failure", { driver: { ok: false as const } }, "input_driver_unavailable"],
  ] as const)("%s is unsupported and cannot be enabled", async (_name, options, reason) => {
    const { service } = createTestComputerUseService(options);
    expect(service.getStatus()).toMatchObject({ supported: false, unsupportedReason: reason });
    expect(await rejectionOf(service.setEnabled("a", true))).not.toBe("resolved");
    expect(service.isEnabledFor("a")).toBe(false);
  });

  test("linux with an X11 display is supported without permission gates", () => {
    const { service } = createTestComputerUseService({
      bridge: createFakeBridge("linux"),
      env: { DISPLAY: ":0", XDG_SESSION_TYPE: "x11" },
    });
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

  test("an archived workspace cannot enable computer use", async () => {
    const { service } = createTestComputerUseService({
      getWorkspaceMetadata: () =>
        Promise.resolve({ runtimeConfig: { type: "local" }, ...ARCHIVED }),
    });
    expect(await rejectionOf(service.setEnabled("a", true))).not.toBe("resolved");
    expect(service.isEnabledFor("a")).toBe(false);
  });
});

describe("ComputerUseService ownership", () => {
  test("enabling another workspace revokes the previous owner's actions and screenshot", async () => {
    const { service, driver } = createTestComputerUseService();
    await service.setEnabled("a", true);
    await service.execute("a", { action: "screenshot" });

    const inFlight = rejectionOf(service.execute("a", { action: "wait", durationSeconds: 5 }));
    const queued = rejectionOf(service.execute("a", { action: "screenshot" }));
    await service.setEnabled("b", true);

    expect(await inFlight).toMatch(MOVED);
    expect(await queued).toMatch(MOVED);
    expect(service.isEnabledFor("a")).toBe(false);
    // The new owner's model never saw A's screenshot, so its coordinates must not drive clicks.
    expect(await rejectionOf(service.execute("b", { action: "left_click", x: 1, y: 1 }))).toMatch(
      /Take a screenshot first/
    );
    expect(driver.calls).toEqual([]);
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
    expect(service.getStatus().stopShortcutRegistered).toBe(true);

    bridge?.stopHandler?.();
    expect(service.getStatus().ownerWorkspaceId).toBeNull();
    expect(bridge?.stopHandler).toBeNull();
    expect(statuses.at(-1)).toMatchObject({
      ownerWorkspaceId: null,
      stopShortcutRegistered: false,
    });
    expect(await rejectionOf(service.execute("b", { action: "screenshot" }))).toMatch(REVOKED);
  });

  test.each([
    ["removing", null],
    ["archiving", ARCHIVED],
  ] as const)(
    "%s the owner workspace releases computer use and the stop shortcut",
    async (_how, metadata) => {
      const { service, bridge } = createTestComputerUseService();
      await service.setEnabled("a", true);

      service.handleWorkspaceMetadata({ workspaceId: "b", metadata });
      service.handleWorkspaceMetadata({
        workspaceId: "a",
        metadata: { ...ARCHIVED, unarchivedAt: "2026-10-05T02:00:00.000Z" },
      });
      expect(service.isEnabledFor("a")).toBe(true);

      service.handleWorkspaceMetadata({ workspaceId: "a", metadata });
      expect(service.getStatus()).toMatchObject({
        ownerWorkspaceId: null,
        stopShortcutRegistered: false,
      });
      expect(bridge?.stopHandler).toBeNull();
    }
  );

  test.each([
    ["removal", null],
    ["archive", ARCHIVED],
  ] as const)(
    "an enable whose workspace lookup outlasts the workspace's %s is refused",
    async (_how, metadata) => {
      // Lookups resolve with the metadata read before the workspace went away.
      const finishLookup = new Map<string, () => void>();
      const { service } = createTestComputerUseService({
        getWorkspaceMetadata: (workspaceId) =>
          new Promise((resolve) => {
            finishLookup.set(workspaceId, () => resolve({ runtimeConfig: { type: "local" } }));
          }),
      });

      const enablingA = rejectionOf(service.setEnabled("a", true));
      const enablingB = rejectionOf(service.setEnabled("b", true));
      service.handleWorkspaceMetadata({ workspaceId: "a", metadata });
      finishLookup.get("a")!();
      expect(await enablingA).not.toBe("resolved");
      expect(service.getStatus().ownerWorkspaceId).toBeNull();

      finishLookup.get("b")!();
      expect(await enablingB).toBe("resolved");
      expect(service.getStatus().ownerWorkspaceId).toBe("b");
    }
  );

  test("a stop shortcut held by another app is reported without blocking computer use", async () => {
    const { service, bridge } = createTestComputerUseService();
    bridge!.stopShortcutAvailable = false;

    expect(await service.setEnabled("a", true)).toMatchObject({
      ownerWorkspaceId: "a",
      stopShortcutRegistered: false,
    });
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

  test.each<[string, (bridge: FakeBridge) => FakeBridge["capturePrimaryDisplay"]]>([
    [
      "cannot show the whole display",
      (bridge) => (target) =>
        Promise.resolve({
          jpegBase64: "anBlZw==",
          width: Math.round(target.width / 2),
          height: target.height,
          display: bridge.display,
        }),
    ],
    ["fails", () => () => Promise.reject(new Error("Could not identify the main display."))],
  ])("a capture that %s is refused and voids the last screenshot", async (_why, capture) => {
    const { service, bridge, driver } = await ownedWithScreenshot();
    bridge!.capturePrimaryDisplay = capture(bridge!);

    expect(await rejectionOf(service.execute("a", { action: "screenshot" }))).not.toBe("resolved");
    expect(await rejectionOf(service.execute("a", { action: "left_click", x: 1, y: 1 }))).toMatch(
      /Take a screenshot first/
    );
    expect(driver.calls).toEqual([]);
  });

  test.each([[{ scaleFactor: 1 }], [{ nativeOrigin: { x: 2880, y: 0 } }]])(
    "a display change (%o) since the last screenshot rejects coordinates",
    async (change) => {
      const { service, bridge, driver } = createTestComputerUseService();
      await service.setEnabled("a", true);
      await service.execute("a", { action: "screenshot" });

      bridge!.display = { ...bridge!.display, ...change };
      expect(await rejectionOf(service.execute("a", { action: "mouse_move", x: 5, y: 5 }))).toMatch(
        /display changed/
      );
      expect(driver.calls).toEqual([]);
    }
  );

  test.each([
    { action: "type", text: "hello" },
    { action: "key", text: "Return" },
  ] as const)("$action needs a screenshot first", async (input) => {
    const { service, driver } = createTestComputerUseService();
    await service.setEnabled("a", true);

    expect(await rejectionOf(service.execute("a", input))).toMatch(/Take a screenshot first/);
    expect(driver.calls).toEqual([]);
  });

  test("typing presses enter between lines and types in small chunks", async () => {
    const { service, driver } = await ownedWithScreenshot();

    await service.execute("a", { action: "type", text: `${"x".repeat(20)}\nok` });
    expect(driver.calls).toEqual([`type ${"x".repeat(16)}`, "type xxxx", "key enter", "type ok"]);
  });

  test("typing and keys on Linux press shift for shifted symbols", async () => {
    const { service, driver } = await ownedWithScreenshot({ bridge: createFakeBridge("linux") });

    await service.execute("a", { action: "type", text: 'a:B"_~' });
    await service.execute("a", { action: "key", text: "ctrl+@" });
    expect(driver.calls).toEqual([
      "type a",
      "key shift+;",
      "type B",
      "key shift+'",
      "key shift+-",
      "key shift+`",
      "key control+shift+2",
    ]);
  });

  test.each([
    ["linux", "é", /printable ASCII/],
    ["darwin", "😀", /beyond U\+FFFF/],
  ] as const)(
    "text %s cannot type is rejected before any keystroke and keeps the screenshot",
    async (platform, char, message) => {
      const { service, driver } = await ownedWithScreenshot({ bridge: createFakeBridge(platform) });

      const text = `${"x".repeat(40)}\n${char}`;
      expect(await rejectionOf(service.execute("a", { action: "type", text }))).toMatch(message);
      expect(driver.calls).toEqual([]);
      expect(await rejectionOf(service.execute("a", { action: "cursor_position" }))).toBe(
        "resolved"
      );
    }
  );

  test.each([
    ["turning computer use off", REVOKED],
    ["interrupting the turn", /interrupted/],
  ] as const)("%s stops typing between chunks", async (how, message) => {
    const { service, driver } = await ownedWithScreenshot();
    const turn = new AbortController();
    driver.typeString = (text) => {
      driver.calls.push(`type ${text}`);
      if (how === "interrupting the turn") turn.abort();
      else service.disable();
    };

    const typing = service.execute("a", { action: "type", text: "x".repeat(40) }, turn.signal);
    expect(await rejectionOf(typing)).toMatch(message);
    expect(driver.calls).toEqual([`type ${"x".repeat(16)}`]);
  });

  test.each([
    { action: "left_click", x: 1, y: 1 },
    { action: "mouse_move", x: 1, y: 1 },
    { action: "scroll", x: 1, y: 1, scrollDirection: "down" },
    { action: "left_click_drag", startX: 0, startY: 0, x: 10, y: 10 },
    { action: "type", text: "hi" },
    { action: "key", text: "Return" },
  ] as const)("$action voids the last screenshot when its input fails", async (input) => {
    const { service, driver } = await ownedWithScreenshot();
    const fail = () => {
      throw new Error("injection failed");
    };
    Object.assign(driver, { moveMouse: fail, keyTap: fail, typeString: fail });

    expect(await rejectionOf(service.execute("a", input))).toMatch(/injection failed/);
    expect(await rejectionOf(service.execute("a", { action: "cursor_position" }))).toMatch(
      /Take a screenshot first/
    );
  });

  test("a click voids the last screenshot when the turn stops before the next one", async () => {
    const { service, driver } = await ownedWithScreenshot();
    const turn = new AbortController();
    driver.click = () => turn.abort();

    const click = service.execute("a", { action: "left_click", x: 1, y: 1 }, turn.signal);
    expect(await rejectionOf(click)).toMatch(/interrupted/);
    expect(await rejectionOf(service.execute("a", { action: "cursor_position" }))).toMatch(
      /Take a screenshot first/
    );
  });

  test.each<[string, (service: ComputerUseService) => void, RegExp]>([
    [
      "the input driver fails",
      () => {
        throw new Error("injection failed");
      },
      /injection failed/,
    ],
    ["computer use is turned off", (service) => service.disable(), REVOKED],
  ])("a drag stops and releases the mouse button when %s", async (_why, interrupt, message) => {
    const { service, driver } = createTestComputerUseService();
    driver.dragMouse = () => {
      driver.calls.push("drag");
      interrupt(service);
    };
    await service.setEnabled("a", true);
    await service.execute("a", { action: "screenshot" });

    expect(
      await rejectionOf(
        service.execute("a", { action: "left_click_drag", startX: 0, startY: 0, x: 10, y: 10 })
      )
    ).toMatch(message);
    expect(driver.calls).toEqual(["move 0,0", "toggle down left", "drag", "toggle up left"]);
  });
});
