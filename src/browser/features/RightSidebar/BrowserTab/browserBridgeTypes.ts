export type BrowserSessionStatus = "starting" | "live" | "error" | "ended";
export type BrowserStreamState = "disconnected" | "connecting" | "live" | "error";

export interface BrowserViewportMetadata {
  deviceWidth: number;
  deviceHeight: number;
  pageScaleFactor: number;
  offsetTop: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
}

export interface BrowserFrameImageSize {
  width: number;
  height: number;
}

export type BrowserDiscoveredSessionStatus = "attachable" | "missing_stream";

export interface BrowserDiscoveredSession {
  sessionName: string;
  status: BrowserDiscoveredSessionStatus;
}

export interface BrowserDiscoveredOtherSession extends BrowserDiscoveredSession {
  cwd: string;
}

export type { BrowserPageTab } from "@/common/orpc/schemas/api";

export interface BrowserSessionAttachOptions {
  allowOtherWorkspaceSession?: boolean;
}

export interface BrowserSession {
  id: string;
  workspaceId: string;
  sessionName: string;
  status: BrowserSessionStatus;
  frameBase64: string | null;
  lastError: string | null;
  streamState: BrowserStreamState | null;
  frameMetadata: BrowserViewportMetadata | null;
  currentUrl: string | null;
  isPageLoading: boolean;
  pendingUrl: string | null;
  streamErrorMessage: string | null;
}

export type BrowserInputEvent = BrowserMouseInput | BrowserKeyboardInput | BrowserTouchInput;

export interface BrowserMouseInput {
  type: "input_mouse";
  eventType: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
  x: number;
  y: number;
  button?: "left" | "right" | "middle" | "none";
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  modifiers?: number;
}

export interface BrowserKeyboardInput {
  type: "input_keyboard";
  eventType: "keyDown" | "keyUp" | "rawKeyDown";
  key?: string;
  code?: string;
  text?: string;
  modifiers?: number;
}

export interface BrowserTouchInput {
  type: "input_touch";
  eventType: "touchStart" | "touchEnd" | "touchMove" | "touchCancel";
  touchPoints: Array<{ x: number; y: number; id?: number }>;
  modifiers?: number;
}
