// Test harness: run a sandboxed frame's document (an HTML artifact or an MCP App view) from the
// srcdoc the host built, so tests drive the real bridge script instead of forging its messages.
import { act } from "@testing-library/react";
import { Window as HappyWindow } from "happy-dom";
import assert from "@/common/utils/assert";

/** What the document's script sees as `window.parent`. */
export interface FrameParent {
  postMessage: (data: unknown, targetOrigin: string, transfer?: MessagePort[]) => void;
}

/** One document run from a frame's srcdoc, in its own happy-dom window. */
export interface FrameDocument {
  /** The document's window: the bridge put `window.xum` on it, the MCP preamble its parent. */
  win: HappyWindow & { xum?: ArtifactBridgeApi };
  /** Fire a window event (pagehide) in the document. */
  dispatch: (type: string) => void;
}

/** `window.xum`, as the artifact's own code calls it. */
interface ArtifactBridgeApi {
  send: (text: string, data?: unknown) => void;
  setState: (state: unknown) => void;
  openWorkspace: (workspaceId: string) => void;
}

/** The srcdoc's first script: the artifact bridge, or the MCP App view preamble. */
function firstScriptOf(srcdoc: string): string {
  const parsed = new window.DOMParser().parseFromString(srcdoc, "text/html");
  const script = parsed.querySelector("script")?.textContent;
  assert(script != null && script.length > 0, "the srcdoc has no script");
  return script;
}

/**
 * Run `script` as the first script of a fresh document whose parent window is `parent`. Its
 * window is a happy-dom window of its own, so the script's listeners and globals stay off the
 * app window. The globals the frame scripts use are that window's, as in a real frame.
 */
export function runFrameDocument(script: string, parent: FrameParent): FrameDocument {
  const win = new HappyWindow({ url: "about:srcdoc" }) as FrameDocument["win"];
  Object.defineProperty(win, "parent", { value: parent, configurable: true, writable: true });
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the host's own frame script
  const run = new Function(
    "window",
    "document",
    "CustomEvent",
    "MessageChannel",
    "EventTarget",
    "Document",
    script
  ) as (...globals: unknown[]) => void;
  run(win, win.document, win.CustomEvent, MessageChannel, win.EventTarget, win.Document);
  return {
    win,
    dispatch: (type) => {
      act(() => {
        win.dispatchEvent(new win.Event(type));
      });
    },
  };
}

/**
 * Post from the frame's window to the app window: what the frame's current document can do,
 * whichever document that is (one the frame navigated to included).
 */
export function postFromFrameWindow(
  frame: HTMLIFrameElement,
  data: unknown,
  ports: readonly MessagePort[] = []
): void {
  const event = new window.Event("message");
  Object.defineProperty(event, "data", { value: data });
  Object.defineProperty(event, "source", { value: frame.contentWindow });
  Object.defineProperty(event, "ports", { value: ports });
  act(() => {
    window.dispatchEvent(event);
  });
}

/** Run the document the frame's srcdoc holds, as the frame would load it. */
export function bootFrameDocument(frame: HTMLIFrameElement): FrameDocument {
  const srcdoc = frame.getAttribute("srcdoc");
  assert(srcdoc != null, "the frame has no srcdoc");
  return runFrameDocument(firstScriptOf(srcdoc), {
    postMessage: (data, _targetOrigin, transfer = []) => postFromFrameWindow(frame, data, transfer),
  });
}
