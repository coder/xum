import { setTimeout as sleep } from "node:timers/promises";

import {
  type ComputerUseAction,
  COMPUTER_USE_MAX_SCROLL_AMOUNT,
  COMPUTER_USE_MAX_TYPE_CHARS,
  COMPUTER_USE_MAX_WAIT_SECONDS,
  COMPUTER_USE_SETTLE_MS,
  type ComputerUseScrollDirection,
} from "@/common/constants/computerUse";
import type {
  ComputerUsePermissionKind,
  ComputerUseStatus,
  ComputerUseUnsupportedReason,
} from "@/common/orpc/schemas/computerUse";
import {
  isLocalProjectRuntime,
  isWorktreeRuntime,
  type RuntimeConfig,
} from "@/common/types/runtime";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { log } from "@/node/services/log";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";

import {
  computeDeclaredSize,
  imagePointToInput,
  inputPointToImage,
  isSameDisplay,
  screenshotFitsDisplay,
  type CaptureGeometry,
  type ComputerUsePlatform,
  type Point,
} from "./geometry";
import type { ComputerUseHostBridge } from "./hostBridge";
import { parseKeyCombo } from "./keys";
import {
  dragMouse,
  loadRobotInputDriver,
  toX11KeyCombo,
  typeText,
  type ComputerUseInputDriver,
  type InputDriverLoadResult,
  type MouseButton,
} from "./robotInput";
import { scrollDeltaFor } from "./scroll";

export interface ComputerUseInput {
  action: ComputerUseAction;
  x?: number | null;
  y?: number | null;
  startX?: number | null;
  startY?: number | null;
  text?: string | null;
  scrollDirection?: ComputerUseScrollDirection | null;
  scrollAmount?: number | null;
  durationSeconds?: number | null;
}

export interface ComputerUseResult {
  text: string;
  /** Absent only for cursor_position. */
  screenshot?: { jpegBase64: string; width: number; height: number };
}

function revokedMessage(ownerWorkspaceId: string | null, workspaceId: string): string {
  return (
    (ownerWorkspaceId == null || ownerWorkspaceId === workspaceId
      ? "Computer use was turned off by the user."
      : "The user moved computer use to another workspace.") +
    " Do not retry computer actions; continue without them or ask the user to turn computer use " +
    "back on here."
  );
}

function isSet(value: string | undefined): boolean {
  return (value ?? "").trim().length > 0;
}

const UNSUPPORTED_MESSAGES: Record<ComputerUseUnsupportedReason, string> = {
  requires_desktop_app: "Computer use requires the Xum desktop app.",
  unsupported_platform: "Computer use is only supported on macOS and Linux (X11).",
  no_display: "Computer use on Linux requires an X11 display (DISPLAY is not set).",
  wayland_session: "Computer use on Linux requires an X11 session; Wayland is not supported.",
  input_driver_unavailable:
    "Computer use could not load its native input driver on this machine (see the Xum logs).",
};

type Support =
  | {
      supported: true;
      platform: ComputerUsePlatform;
      bridge: ComputerUseHostBridge;
      driver: ComputerUseInputDriver;
    }
  | { supported: false; reason: ComputerUseUnsupportedReason };

type StatusListener = (status: ComputerUseStatus) => void;

interface ArchiveState {
  archivedAt?: string;
  unarchivedAt?: string;
}

function isArchived(metadata: ArchiveState): boolean {
  return isWorkspaceArchived(metadata.archivedAt, metadata.unarchivedAt);
}

/** Lets one response's `computer` tool act until ownership next changes. */
export interface ComputerUseGrant {
  execute(input: ComputerUseInput, abortSignal?: AbortSignal): Promise<ComputerUseResult>;
}

export interface ComputerUseServiceOptions {
  getWorkspaceMetadata: (
    workspaceId: string
  ) => Promise<(ArchiveState & { runtimeConfig?: RuntimeConfig }) | null | undefined>;
  loadInputDriver?: () => InputDriverLoadResult;
  env?: NodeJS.ProcessEnv;
}

/**
 * Native host computer use: one workspace at a time may let its agents see the main display and
 * drive the real mouse and keyboard. The grant lives only in memory, so an app restart never
 * resumes host control unattended.
 */
export class ComputerUseService {
  private bridge: ComputerUseHostBridge | null = null;
  private ownerWorkspaceId: string | null = null;
  /**
   * Replaced and aborted whenever ownership changes, which revokes the grants built from it and
   * cancels their in-flight action.
   */
  private ownerAbort: AbortController | null = null;
  private lastCapture: CaptureGeometry | null = null;
  private stopShortcutRegistered = false;
  /** One mouse and keyboard: actions from any workspace run strictly one at a time. */
  private readonly actionMutex = new AsyncMutex();
  private readonly listeners = new Set<StatusListener>();
  /**
   * The newest enable still waiting on its workspace lookup. Lookups can finish out of order, so
   * only this one may take control, and turning computer use off cancels it.
   */
  private pendingEnable: { workspaceId: string } | null = null;
  private readonly loadInputDriver: () => InputDriverLoadResult;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: ComputerUseServiceOptions) {
    this.loadInputDriver = options.loadInputDriver ?? loadRobotInputDriver;
    this.env = options.env ?? process.env;
  }

  setHostBridge(bridge: ComputerUseHostBridge): void {
    this.bridge = bridge;
    this.emitStatus();
  }

  getStatus(): ComputerUseStatus {
    const support = this.resolveSupport();
    return {
      supported: support.supported,
      ...(support.supported ? {} : { unsupportedReason: support.reason }),
      platform: this.bridge?.platform ?? process.platform,
      ownerWorkspaceId: this.ownerWorkspaceId,
      stopShortcutRegistered: this.stopShortcutRegistered,
      permissions: support.supported ? support.bridge.getPermissions() : null,
    };
  }

  /**
   * Null unless the workspace owns computer use. The grant stops working once ownership changes,
   * even if the same workspace turns computer use back on.
   */
  grantFor(workspaceId: string): ComputerUseGrant | null {
    const grantSignal = this.ownerAbort?.signal;
    if (this.ownerWorkspaceId !== workspaceId || grantSignal == null) {
      return null;
    }
    return {
      execute: (input, abortSignal) => this.execute(workspaceId, grantSignal, input, abortSignal),
    };
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async setEnabled(workspaceId: string, enabled: boolean): Promise<ComputerUseStatus> {
    if (!enabled) {
      this.release(workspaceId);
      return this.getStatus();
    }

    const support = this.resolveSupport();
    if (!support.supported) {
      throw new Error(UNSUPPORTED_MESSAGES[support.reason]);
    }
    const request = { workspaceId };
    this.pendingEnable = request;
    const metadata = await this.options.getWorkspaceMetadata(workspaceId);
    if (this.pendingEnable !== request) {
      return this.getStatus();
    }
    this.pendingEnable = null;
    if (metadata == null) {
      throw new Error(`Workspace ${workspaceId} not found.`);
    }
    if (isArchived(metadata)) {
      throw new Error(`Workspace ${workspaceId} is archived.`);
    }
    const runtimeConfig = metadata.runtimeConfig;
    if (!isWorktreeRuntime(runtimeConfig) && !isLocalProjectRuntime(runtimeConfig)) {
      throw new Error(
        "Computer use is only available in local workspaces, which run on this machine."
      );
    }
    if (this.ownerWorkspaceId !== workspaceId) {
      this.setOwner(workspaceId);
    }
    return this.getStatus();
  }

  /** Turns computer use off for whichever workspace owns it (the global stop shortcut). */
  disable(): void {
    this.pendingEnable = null;
    if (this.ownerWorkspaceId != null) {
      this.setOwner(null);
    }
  }

  /** A removed or archived workspace has no agent picker left to turn computer use off from. */
  handleWorkspaceMetadata(event: { workspaceId: string; metadata: ArchiveState | null }): void {
    if (event.metadata != null && !isArchived(event.metadata)) {
      return;
    }
    this.release(event.workspaceId);
  }

  async requestPermission(kind: ComputerUsePermissionKind): Promise<ComputerUseStatus> {
    const support = this.resolveSupport();
    if (!support.supported) {
      throw new Error(UNSUPPORTED_MESSAGES[support.reason]);
    }
    await support.bridge.requestPermission(kind);
    this.emitStatus();
    return this.getStatus();
  }

  private async execute(
    workspaceId: string,
    grantSignal: AbortSignal,
    input: ComputerUseInput,
    abortSignal?: AbortSignal
  ): Promise<ComputerUseResult> {
    // Validate before queueing so malformed calls fail fast without waiting for the mouse.
    const plan = planAction(input);

    await using _lock = await this.actionMutex.acquire();

    const checkpoint = () => {
      if (this.ownerAbort?.signal !== grantSignal) {
        throw new Error(revokedMessage(this.ownerWorkspaceId, workspaceId));
      }
      if (abortSignal?.aborted) {
        throw new Error("The computer action was interrupted.");
      }
    };
    // The grant may have been revoked, or the turn stopped, while this call waited for the lock.
    checkpoint();
    const support = this.resolveSupport();
    if (!support.supported) {
      throw new Error(UNSUPPORTED_MESSAGES[support.reason]);
    }
    const signal = abortSignal == null ? grantSignal : AbortSignal.any([grantSignal, abortSignal]);

    this.assertPermissions(support, plan.needsInput);

    try {
      return await this.run(plan, support, checkpoint, signal);
    } catch (error) {
      // Abort-driven sleeps reject with AbortError; report why the action stopped instead.
      checkpoint();
      throw error;
    }
  }

  private async run(
    plan: ActionPlan,
    support: Extract<Support, { supported: true }>,
    checkpoint: () => void,
    signal: AbortSignal
  ): Promise<ComputerUseResult> {
    const { driver, platform } = support;
    const toInput = (point: Point) => imagePointToInput(point, this.requireCapture(support));
    // Input can change the screen, so once it starts the old screenshot no longer counts, even if
    // the action stops before taking a new one.
    const beforeInput = () => {
      checkpoint();
      this.lastCapture = null;
    };

    let summary: string;
    switch (plan.action) {
      case "screenshot":
        return await this.capture(support, checkpoint, "Captured the main display.");
      case "cursor_position": {
        const capture = this.requireCapture(support);
        const position = inputPointToImage(driver.getMousePos(), capture);
        return {
          text:
            position == null
              ? "The cursor is outside the main display."
              : `The cursor is at (${position.x}, ${position.y}).`,
        };
      }
      case "wait":
        await sleep(plan.durationSeconds * 1000, undefined, { signal });
        return await this.capture(support, checkpoint, `Waited ${plan.durationSeconds}s.`);
      case "click": {
        const target = toInput(plan.point);
        beforeInput();
        driver.moveMouse(target.x, target.y);
        driver.click(plan.button, plan.double);
        summary = `${plan.double ? "Double-clicked" : `Clicked (${plan.button})`} at (${plan.point.x}, ${plan.point.y}).`;
        break;
      }
      case "mouse_move": {
        const target = toInput(plan.point);
        beforeInput();
        driver.moveMouse(target.x, target.y);
        summary = `Moved the mouse to (${plan.point.x}, ${plan.point.y}).`;
        break;
      }
      case "drag": {
        const from = toInput(plan.from);
        const to = toInput(plan.to);
        await dragMouse(driver, from, to, beforeInput);
        summary = `Dragged from (${plan.from.x}, ${plan.from.y}) to (${plan.to.x}, ${plan.to.y}).`;
        break;
      }
      case "scroll": {
        const target = toInput(plan.point);
        const delta = scrollDeltaFor(plan.direction, plan.amount, platform);
        beforeInput();
        driver.moveMouse(target.x, target.y);
        driver.scroll(delta.x, delta.y);
        summary = `Scrolled ${plan.direction} ${plan.amount}x at (${plan.point.x}, ${plan.point.y}).`;
        break;
      }
      case "type":
        // Keystrokes go to whatever has focus, so the model must have looked at the screen first.
        this.requireCapture(support);
        await typeText(driver, platform, plan.text, beforeInput);
        summary = `Typed ${Array.from(plan.text).length} characters.`;
        break;
      case "key": {
        this.requireCapture(support);
        const combo = platform === "linux" ? toX11KeyCombo(plan.combo) : plan.combo;
        beforeInput();
        driver.keyTap(combo.key, combo.modifiers);
        summary = `Pressed ${plan.rawKey}.`;
        break;
      }
    }

    await sleep(COMPUTER_USE_SETTLE_MS, undefined, { signal });
    return await this.capture(support, checkpoint, summary);
  }

  private async capture(
    support: Extract<Support, { supported: true }>,
    checkpoint: () => void,
    summary: string
  ): Promise<ComputerUseResult> {
    // A failed capture must not leave an older screenshot in charge of later clicks.
    this.lastCapture = null;
    const display = support.bridge.getPrimaryDisplay();
    const target = computeDeclaredSize(display.bounds.width, display.bounds.height);
    const shot = await support.bridge.capturePrimaryDisplay(target);
    checkpoint();
    if (!screenshotFitsDisplay(shot.width, shot.height, shot.display)) {
      const { width, height } = shot.display.bounds;
      throw new Error(
        `The ${shot.width}x${shot.height} screen capture does not show the whole ${width}x${height} ` +
          "main display, so clicks would land in the wrong place. Computer use does not support a " +
          "screen split into several monitors."
      );
    }
    this.lastCapture = {
      platform: support.platform,
      imageWidth: shot.width,
      imageHeight: shot.height,
      display: shot.display,
    };
    return {
      text:
        `${summary} Screenshot of the main display is ${shot.width}x${shot.height}; ` +
        "coordinates are pixels in this image.",
      screenshot: { jpegBase64: shot.jpegBase64, width: shot.width, height: shot.height },
    };
  }

  private requireCapture(support: Extract<Support, { supported: true }>): CaptureGeometry {
    const capture = this.lastCapture;
    if (capture == null) {
      throw new Error("Take a screenshot first: actions must be based on the latest screenshot.");
    }
    if (!isSameDisplay(support.bridge.getPrimaryDisplay(), capture.display)) {
      throw new Error("The display changed since the last screenshot; take a new screenshot.");
    }
    return capture;
  }

  private assertPermissions(
    support: Extract<Support, { supported: true }>,
    needsInput: boolean
  ): void {
    const permissions = support.bridge.getPermissions();
    if (permissions == null) {
      return;
    }
    if (permissions.screenRecording !== "granted") {
      throw new Error(
        "Xum does not have the macOS Screen Recording permission. Ask the user to allow Xum in " +
          "System Settings > Privacy & Security > Screen Recording (the Computer use switch in the " +
          "agent picker can open it). macOS may require restarting Xum afterwards."
      );
    }
    if (needsInput && permissions.accessibility !== "granted") {
      throw new Error(
        "Xum does not have the macOS Accessibility permission needed to control the mouse and " +
          "keyboard. Ask the user to allow Xum in System Settings > Privacy & Security > Accessibility."
      );
    }
  }

  private resolveSupport(): Support {
    const bridge = this.bridge;
    if (bridge == null) {
      return { supported: false, reason: "requires_desktop_app" };
    }
    const platform = bridge.platform;
    if (platform !== "darwin" && platform !== "linux") {
      return { supported: false, reason: "unsupported_platform" };
    }
    if (platform === "linux") {
      // XWayland sets DISPLAY too, but XTest input only reaches X11 clients.
      if (isSet(this.env.WAYLAND_DISPLAY) || this.env.XDG_SESSION_TYPE === "wayland") {
        return { supported: false, reason: "wayland_session" };
      }
      if (!isSet(this.env.DISPLAY)) {
        return { supported: false, reason: "no_display" };
      }
    }
    const load = this.loadInputDriver();
    if (!load.ok) {
      return { supported: false, reason: "input_driver_unavailable" };
    }
    return { supported: true, platform, bridge, driver: load.driver };
  }

  private release(workspaceId: string): void {
    if (this.pendingEnable?.workspaceId === workspaceId) {
      this.pendingEnable = null;
    }
    if (this.ownerWorkspaceId === workspaceId) {
      this.setOwner(null);
    }
  }

  private setOwner(workspaceId: string | null): void {
    const hadOwner = this.ownerWorkspaceId != null;
    this.ownerAbort?.abort();
    this.ownerAbort = workspaceId == null ? null : new AbortController();
    this.ownerWorkspaceId = workspaceId;
    // Coordinates from another owner's screenshot must never drive this owner's clicks.
    this.lastCapture = null;

    const bridge = this.bridge;
    if (bridge != null && hadOwner !== (workspaceId != null)) {
      const registered = bridge.setStopShortcut(workspaceId == null ? null : () => this.disable());
      this.stopShortcutRegistered = workspaceId != null && registered;
      if (workspaceId != null && !registered) {
        log.warn("[computerUse] failed to register the stop shortcut");
      }
    }
    this.emitStatus();
  }

  private emitStatus(): void {
    if (this.listeners.size === 0) {
      return;
    }
    const status = this.getStatus();
    for (const listener of this.listeners) {
      listener(status);
    }
  }
}

type ActionPlan = { needsInput: boolean } & (
  | { action: "screenshot" | "cursor_position" }
  | { action: "wait"; durationSeconds: number }
  | { action: "click"; point: Point; button: MouseButton; double: boolean }
  | { action: "mouse_move"; point: Point }
  | { action: "drag"; from: Point; to: Point }
  | { action: "scroll"; point: Point; direction: ComputerUseScrollDirection; amount: number }
  | { action: "type"; text: string }
  | { action: "key"; combo: ReturnType<typeof parseKeyCombo>; rawKey: string }
);

function requirePoint(input: ComputerUseInput, xField: "x" | "startX", yField: "y" | "startY") {
  const x = input[xField];
  const y = input[yField];
  if (x == null || y == null) {
    throw new Error(`${input.action} requires ${xField} and ${yField}.`);
  }
  return { x, y };
}

function planAction(input: ComputerUseInput): ActionPlan {
  switch (input.action) {
    case "screenshot":
    case "cursor_position":
      return { action: input.action, needsInput: false };
    case "wait": {
      const seconds = input.durationSeconds;
      if (seconds == null || !(seconds > 0) || seconds > COMPUTER_USE_MAX_WAIT_SECONDS) {
        throw new Error(
          `wait requires durationSeconds between 0 and ${COMPUTER_USE_MAX_WAIT_SECONDS}.`
        );
      }
      return { action: "wait", durationSeconds: seconds, needsInput: false };
    }
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click": {
      const buttons: Record<typeof input.action, MouseButton> = {
        left_click: "left",
        right_click: "right",
        middle_click: "middle",
        double_click: "left",
      };
      return {
        action: "click",
        point: requirePoint(input, "x", "y"),
        button: buttons[input.action],
        double: input.action === "double_click",
        needsInput: true,
      };
    }
    case "mouse_move":
      return { action: "mouse_move", point: requirePoint(input, "x", "y"), needsInput: true };
    case "left_click_drag":
      return {
        action: "drag",
        from: requirePoint(input, "startX", "startY"),
        to: requirePoint(input, "x", "y"),
        needsInput: true,
      };
    case "scroll": {
      const amount = input.scrollAmount ?? 3;
      if (input.scrollDirection == null) {
        throw new Error("scroll requires scrollDirection (up, down, left, or right).");
      }
      if (!Number.isInteger(amount) || amount < 1 || amount > COMPUTER_USE_MAX_SCROLL_AMOUNT) {
        throw new Error(
          `scrollAmount must be an integer from 1 to ${COMPUTER_USE_MAX_SCROLL_AMOUNT}.`
        );
      }
      return {
        action: "scroll",
        point: requirePoint(input, "x", "y"),
        direction: input.scrollDirection,
        amount,
        needsInput: true,
      };
    }
    case "type": {
      const text = input.text;
      if (text == null || text.length === 0) {
        throw new Error("type requires non-empty text.");
      }
      if (Array.from(text).length > COMPUTER_USE_MAX_TYPE_CHARS) {
        throw new Error(
          `type accepts at most ${COMPUTER_USE_MAX_TYPE_CHARS} characters per call; split longer text.`
        );
      }
      return { action: "type", text, needsInput: true };
    }
    case "key": {
      const text = input.text;
      if (text == null || text.trim().length === 0) {
        throw new Error('key requires text with a key or combination, for example "cmd+s".');
      }
      return { action: "key", combo: parseKeyCombo(text), rawKey: text.trim(), needsInput: true };
    }
  }
}
