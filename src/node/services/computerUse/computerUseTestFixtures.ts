import type { ComputerUsePermissions } from "@/common/orpc/schemas/computerUse";
import type { RuntimeConfig } from "@/common/types/runtime";

import { ComputerUseService, type ComputerUseServiceOptions } from "./computerUseService";
import type { DisplayInfo } from "./geometry";
import type { ComputerUseHostBridge } from "./hostBridge";
import type { ComputerUseInputDriver, InputDriverLoadResult } from "./robotInput";

export type FakeBridge = ComputerUseHostBridge & {
  permissions: ComputerUsePermissions | null;
  display: DisplayInfo;
  stopHandler: (() => void) | null;
  stopShortcutCalls: number;
  /** False simulates another app holding the stop shortcut. */
  stopShortcutAvailable: boolean;
};

export function createFakeBridge(platform: NodeJS.Platform = "darwin"): FakeBridge {
  const bridge: FakeBridge = {
    platform,
    permissions:
      platform === "darwin" ? { screenRecording: "granted", accessibility: "granted" } : null,
    display: { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 },
    stopHandler: null,
    stopShortcutCalls: 0,
    stopShortcutAvailable: true,
    getPermissions: () => bridge.permissions,
    requestPermission: () => Promise.resolve(),
    getPrimaryDisplay: () => bridge.display,
    capturePrimaryDisplay: (target) =>
      Promise.resolve({
        jpegBase64: "anBlZw==",
        width: target.width,
        height: target.height,
        display: bridge.display,
      }),
    setStopShortcut: (handler) => {
      bridge.stopShortcutCalls++;
      bridge.stopHandler = bridge.stopShortcutAvailable ? handler : null;
      return handler == null || bridge.stopShortcutAvailable;
    },
  };
  return bridge;
}

export type FakeDriver = ComputerUseInputDriver & { calls: string[] };

export function createFakeDriver(): FakeDriver {
  const calls: string[] = [];
  return {
    calls,
    moveMouse: (x, y) => calls.push(`move ${x},${y}`),
    dragMouse: (x, y) => calls.push(`drag ${x},${y}`),
    click: (button, double) => calls.push(`click ${button}${double ? " double" : ""}`),
    mouseToggle: (state, button) => calls.push(`toggle ${state} ${button}`),
    scroll: (dx, dy) => calls.push(`scroll ${dx},${dy}`),
    keyTap: (key, modifiers) => calls.push(`key ${[...modifiers, key].join("+")}`),
    typeString: (text) => calls.push(`type ${text}`),
    getMousePos: () => ({ x: 720, y: 450 }),
  };
}

const LOCAL_RUNTIME: RuntimeConfig = { type: "local" };

export function createTestComputerUseService(options?: {
  bridge?: FakeBridge | null;
  driver?: InputDriverLoadResult;
  env?: NodeJS.ProcessEnv;
  runtimes?: Record<string, RuntimeConfig>;
  getWorkspaceMetadata?: ComputerUseServiceOptions["getWorkspaceMetadata"];
}) {
  const driver = createFakeDriver();
  const service = new ComputerUseService({
    getWorkspaceMetadata:
      options?.getWorkspaceMetadata ??
      ((workspaceId) => {
        const runtimes = options?.runtimes ?? { a: LOCAL_RUNTIME, b: LOCAL_RUNTIME };
        const runtimeConfig = runtimes[workspaceId];
        return Promise.resolve(runtimeConfig == null ? null : { runtimeConfig });
      }),
    loadInputDriver: () => options?.driver ?? { ok: true, driver },
    env: options?.env ?? { DISPLAY: ":0" },
  });
  const bridge = options?.bridge === undefined ? createFakeBridge() : options.bridge;
  if (bridge != null) {
    service.setHostBridge(bridge);
  }
  return { service, bridge, driver };
}
