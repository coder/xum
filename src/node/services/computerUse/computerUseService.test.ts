import { describe, expect, spyOn, test } from "bun:test";

import type { ComputerUseStatus } from "@/common/orpc/schemas/computerUse";

import type { ComputerUseGrant, ComputerUseService } from "./computerUseService";
import {
  createFakeBridge,
  createTestComputerUseService,
  type FakeBridge,
} from "./computerUseTestFixtures";

const REVOKED = /turned off by the user/;
const MOVED = /moved computer use to another workspace/;
const ARCHIVED = { archivedAt: "2026-10-05T01:00:00.000Z" };

/** The grant a response's tool would hold if it started now. */
async function enable(service: ComputerUseService, workspaceId = "a"): Promise<ComputerUseGrant> {
  await service.setEnabled(workspaceId, true);
  return service.grantFor(workspaceId)!;
}

async function ownedWithScreenshot(options?: Parameters<typeof createTestComputerUseService>[0]) {
  const context = createTestComputerUseService(options);
  const a = await enable(context.service);
  await a.execute({ action: "screenshot" });
  return { ...context, a };
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
    [
      "several instances allowed",
      { env: { XUM_ALLOW_MULTIPLE_INSTANCES: "1" } },
      "multiple_instances",
    ],
  ] as const)("%s is unsupported and cannot be enabled", async (_name, options, reason) => {
    const { service } = createTestComputerUseService(options);
    expect(service.getStatus()).toMatchObject({ supported: false, unsupportedReason: reason });
    expect(await rejectionOf(service.setEnabled("a", true))).not.toBe("resolved");
    expect(service.getStatus().ownerWorkspaceId).toBeNull();
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
    expect(service.getStatus().ownerWorkspaceId).toBeNull();
  });
});

describe("ComputerUseService ownership", () => {
  test("enabling another workspace revokes the previous owner's actions and screenshot", async () => {
    const { service, driver } = createTestComputerUseService();
    const a = await enable(service);
    await a.execute({ action: "screenshot" });

    const inFlight = rejectionOf(a.execute({ action: "wait", durationSeconds: 5 }));
    const queued = rejectionOf(a.execute({ action: "screenshot" }));
    const b = await enable(service, "b");

    expect(await inFlight).toMatch(MOVED);
    expect(await queued).toMatch(MOVED);
    expect(service.getStatus().ownerWorkspaceId).toBe("b");
    // The new owner's model never saw A's screenshot, so its coordinates must not drive clicks.
    expect(await rejectionOf(b.execute({ action: "left_click", x: 1, y: 1 }))).toMatch(
      /Take a screenshot first/
    );
    expect(driver.calls).toEqual([]);
    expect((await b.execute({ action: "screenshot" })).screenshot).toBeDefined();
  });

  test("the stop shortcut is registered only while an owner exists and turns computer use off", async () => {
    const { service, bridge } = createTestComputerUseService();
    const statuses: ComputerUseStatus[] = [];
    service.subscribe((status) => statuses.push(status));
    expect(bridge?.stopHandler).toBeNull();

    await service.setEnabled("a", true);
    const b = await enable(service, "b");
    expect(bridge?.stopShortcutCalls).toBe(1);
    expect(service.getStatus().stopShortcutRegistered).toBe(true);

    bridge?.stopHandler?.();
    expect(service.getStatus().ownerWorkspaceId).toBeNull();
    expect(bridge?.stopHandler).toBeNull();
    expect(statuses.at(-1)).toMatchObject({
      ownerWorkspaceId: null,
      stopShortcutRegistered: false,
    });
    expect(await rejectionOf(b.execute({ action: "screenshot" }))).toMatch(REVOKED);
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
      expect(service.getStatus().ownerWorkspaceId).toBe("a");

      service.handleWorkspaceMetadata({ workspaceId: "a", metadata });
      expect(service.getStatus()).toMatchObject({
        ownerWorkspaceId: null,
        stopShortcutRegistered: false,
      });
      expect(bridge?.stopHandler).toBeNull();
    }
  );

  test.each<
    [string, string | null, (context: ReturnType<typeof createTestComputerUseService>) => unknown]
  >([
    ["C is enabled and finishes first", "c", ({ service }) => service.setEnabled("c", true)],
    ["A is turned off", "b", ({ service }) => service.setEnabled("a", false)],
    ["the stop shortcut is pressed", null, ({ bridge }) => bridge!.stopHandler!()],
    [
      "A is removed",
      "b",
      ({ service }) => service.handleWorkspaceMetadata({ workspaceId: "a", metadata: null }),
    ],
    [
      "A is archived",
      "b",
      ({ service }) => service.handleWorkspaceMetadata({ workspaceId: "a", metadata: ARCHIVED }),
    ],
    ["owner B is turned off", "a", ({ service }) => service.setEnabled("b", false)],
    [
      "owner B is removed",
      "a",
      ({ service }) => service.handleWorkspaceMetadata({ workspaceId: "b", metadata: null }),
    ],
  ])("%s while A's enable lookup runs: owner %p", async (_when, owner, act) => {
    // Lookups resolve with the metadata read when they started.
    const finishLookup = new Map<string, () => void>();
    const context = createTestComputerUseService({
      getWorkspaceMetadata: (workspaceId) =>
        new Promise((resolve) => {
          const finish = () => resolve({ runtimeConfig: { type: "local" } });
          if (workspaceId === "a") finishLookup.set(workspaceId, finish);
          else finish();
        }),
    });
    await context.service.setEnabled("b", true);

    const enablingA = rejectionOf(context.service.setEnabled("a", true));
    await act(context);
    finishLookup.get("a")!();
    // Overtaken or cancelled enables report status instead of failing.
    expect(await enablingA).toBe("resolved");
    expect(context.service.getStatus().ownerWorkspaceId).toBe(owner);
  });

  test("a second toggle before the first enable finishes turns computer use off", async () => {
    const finishLookups: Array<() => void> = [];
    const { service } = createTestComputerUseService({
      getWorkspaceMetadata: () =>
        new Promise((resolve) => {
          finishLookups.push(() => resolve({ runtimeConfig: { type: "local" } }));
        }),
    });

    const presses = [rejectionOf(service.toggle("a")), rejectionOf(service.toggle("a"))];
    for (const finish of finishLookups.splice(0)) finish();
    expect(await Promise.all(presses)).toEqual(["resolved", "resolved"]);
    expect(service.getStatus().ownerWorkspaceId).toBeNull();

    const enabling = service.toggle("a");
    finishLookups.shift()!();
    expect((await enabling).ownerWorkspaceId).toBe("a");
    expect((await service.toggle("a")).ownerWorkspaceId).toBeNull();
  });

  test.each<[string, Array<[string, boolean]>]>([
    [
      "turned off and on again",
      [
        ["a", false],
        ["a", true],
      ],
    ],
    [
      "moved to B and back",
      [
        ["b", true],
        ["a", true],
      ],
    ],
  ])("a grant from before computer use was %s stays revoked", async (_how, toggles) => {
    const { service, bridge } = createTestComputerUseService();
    const before = await enable(service);
    for (const [workspaceId, enabled] of toggles) {
      await service.setEnabled(workspaceId, enabled);
    }
    const capture = spyOn(bridge!, "capturePrimaryDisplay");

    expect(await rejectionOf(before.execute({ action: "screenshot" }))).toMatch(REVOKED);
    expect(capture).not.toHaveBeenCalled();
    expect(
      (await service.grantFor("a")!.execute({ action: "screenshot" })).screenshot
    ).toBeDefined();
  });

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
    const a = await enable(service);

    bridge!.permissions = { screenRecording: "denied", accessibility: "granted" };
    expect(await rejectionOf(a.execute({ action: "screenshot" }))).toMatch(/Screen Recording/);

    bridge!.permissions = { screenRecording: "granted", accessibility: "denied" };
    await a.execute({ action: "screenshot" });
    expect(await rejectionOf(a.execute({ action: "left_click", x: 1, y: 1 }))).toMatch(
      /Accessibility/
    );
    expect(driver.calls).toEqual([]);
  });

  test("clicks map screenshot pixels to display points and return a new screenshot", async () => {
    const { service, driver } = createTestComputerUseService();
    const a = await enable(service);

    expect(await rejectionOf(a.execute({ action: "left_click", x: 1, y: 1 }))).toMatch(
      /Take a screenshot first/
    );
    const shot = await a.execute({ action: "screenshot" });
    expect(shot.screenshot).toMatchObject({ width: 1356, height: 848 });

    const result = await a.execute({ action: "left_click", x: 678, y: 424 });
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
    const { a, bridge, driver } = await ownedWithScreenshot();
    bridge!.capturePrimaryDisplay = capture(bridge!);

    expect(await rejectionOf(a.execute({ action: "screenshot" }))).not.toBe("resolved");
    expect(await rejectionOf(a.execute({ action: "left_click", x: 1, y: 1 }))).toMatch(
      /Take a screenshot first/
    );
    expect(driver.calls).toEqual([]);
  });

  test.each([[{ scaleFactor: 1 }], [{ nativeOrigin: { x: 2880, y: 0 } }]])(
    "a display change (%o) since the last screenshot rejects coordinates",
    async (change) => {
      const { service, bridge, driver } = createTestComputerUseService();
      const a = await enable(service);
      await a.execute({ action: "screenshot" });

      bridge!.display = { ...bridge!.display, ...change };
      expect(await rejectionOf(a.execute({ action: "mouse_move", x: 5, y: 5 }))).toMatch(
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
    const a = await enable(service);

    expect(await rejectionOf(a.execute(input))).toMatch(/Take a screenshot first/);
    expect(driver.calls).toEqual([]);
  });

  test.each([
    { action: "left_click", x: 1, y: 1 },
    { action: "type", text: "hello" },
    { action: "key", text: "Return" },
    { action: "cursor_position" },
  ] as const)("$action in a new stream needs a screenshot from that stream", async (input) => {
    const { service, driver } = await ownedWithScreenshot();
    // The screen may have changed between turns, and the new stream never saw the old screenshot.
    const next = service.grantFor("a")!;

    expect(await rejectionOf(next.execute(input))).toMatch(/Take a screenshot first/);
    expect(driver.calls).toEqual([]);
    await next.execute({ action: "screenshot" });
    expect(await rejectionOf(next.execute(input))).toBe("resolved");
  });

  test("typing presses enter between lines and types in small chunks", async () => {
    const { a, driver } = await ownedWithScreenshot();

    await a.execute({ action: "type", text: `${"x".repeat(20)}\nok` });
    expect(driver.calls).toEqual([`type ${"x".repeat(16)}`, "type xxxx", "key enter", "type ok"]);
  });

  test("keys on Linux press shift for shifted symbols", async () => {
    const { a, driver } = await ownedWithScreenshot({ bridge: createFakeBridge("linux") });

    await a.execute({ action: "key", text: ":" });
    await a.execute({ action: "key", text: "ctrl+@" });
    expect(driver.calls).toEqual(["key shift+;", "key control+shift+2"]);
  });

  test.each([
    ["linux", "é", /printable ASCII/],
    ["darwin", "😀", /beyond U\+FFFF/],
  ] as const)(
    "text %s cannot type is rejected before any keystroke and keeps the screenshot",
    async (platform, char, message) => {
      const { a, driver } = await ownedWithScreenshot({ bridge: createFakeBridge(platform) });

      const text = `${"x".repeat(40)}\n${char}`;
      expect(await rejectionOf(a.execute({ action: "type", text }))).toMatch(message);
      expect(driver.calls).toEqual([]);
      expect(await rejectionOf(a.execute({ action: "cursor_position" }))).toBe("resolved");
    }
  );

  test.each([
    ["turning computer use off", REVOKED],
    ["interrupting the turn", /interrupted/],
  ] as const)("%s stops typing between chunks", async (how, message) => {
    const { a, service, driver } = await ownedWithScreenshot();
    const turn = new AbortController();
    driver.typeString = (text) => {
      driver.calls.push(`type ${text}`);
      if (how === "interrupting the turn") turn.abort();
      else service.disable();
    };

    const typing = a.execute({ action: "type", text: "x".repeat(40) }, turn.signal);
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
    const { a, driver } = await ownedWithScreenshot();
    const fail = () => {
      throw new Error("injection failed");
    };
    Object.assign(driver, { moveMouse: fail, keyTap: fail, typeString: fail });

    expect(await rejectionOf(a.execute(input))).toMatch(/injection failed/);
    expect(await rejectionOf(a.execute({ action: "cursor_position" }))).toMatch(
      /Take a screenshot first/
    );
  });

  test("a click voids the last screenshot when the turn stops before the next one", async () => {
    const { a, driver } = await ownedWithScreenshot();
    const turn = new AbortController();
    driver.click = () => turn.abort();

    const click = a.execute({ action: "left_click", x: 1, y: 1 }, turn.signal);
    expect(await rejectionOf(click)).toMatch(/interrupted/);
    expect(await rejectionOf(a.execute({ action: "cursor_position" }))).toMatch(
      /Take a screenshot first/
    );
  });

  test.each([{ action: "screenshot" }, { action: "cursor_position" }] as const)(
    "$action from a turn that stopped while it waited does nothing",
    async (input) => {
      const { a, bridge } = await ownedWithScreenshot();
      const capture = spyOn(bridge!, "capturePrimaryDisplay");

      const stopped = AbortSignal.abort();
      expect(await rejectionOf(a.execute(input, stopped))).toMatch(/interrupted/);
      expect(capture).not.toHaveBeenCalled();
      expect(await rejectionOf(a.execute({ action: "cursor_position" }))).toBe("resolved");
    }
  );

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
    const a = await enable(service);
    await a.execute({ action: "screenshot" });

    expect(
      await rejectionOf(
        a.execute({ action: "left_click_drag", startX: 0, startY: 0, x: 10, y: 10 })
      )
    ).toMatch(message);
    expect(driver.calls).toEqual(["move 0,0", "toggle down left", "drag", "toggle up left"]);
  });
});
