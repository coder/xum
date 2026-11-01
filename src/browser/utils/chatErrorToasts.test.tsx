import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";
import { act, cleanup, renderHook } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { StrictMode } from "react";
import {
  dismissChatError,
  peekChatError,
  publishChatError,
  publishChatInfo,
  useChatErrorToasts,
} from "./chatErrorToasts";

describe("useChatErrorToasts", () => {
  beforeEach(() => {
    saveDomGlobals();
    const domWindow = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;
  });

  afterEach(() => {
    cleanup();
    restoreDomGlobals();
  });

  interface Props {
    workspaceId: string | null;
    visible: string | null;
  }

  /** A chat input whose single toast slot the test drives: `show` renders a toast, `dismiss` clears it. */
  function mountInput(workspaceId: string | null, options?: { strict?: boolean }) {
    const shown: string[] = [];
    const pushed: Array<{ type: string; message: string }> = [];
    const pushToast = (toast: { type: "error" | "info"; message: string }) => {
      shown.push(toast.message);
      pushed.push({ type: toast.type, message: toast.message });
    };
    const initialProps: Props = { workspaceId, visible: null };
    const rendered = renderHook(
      (props: Props) => useChatErrorToasts(props.workspaceId, props.visible, pushToast),
      { initialProps, wrapper: options?.strict ? StrictMode : undefined }
    );
    return {
      shown,
      pushed,
      ...rendered,
      show: (message: string) => rendered.rerender({ workspaceId, visible: message }),
      dismiss: () => rendered.rerender({ workspaceId, visible: null }),
    };
  }

  function drain(workspaceId: string) {
    for (let next = peekChatError(workspaceId); next != null; next = peekChatError(workspaceId)) {
      dismissChatError(workspaceId, next);
    }
  }

  test("an error published while no input for the workspace is mounted is shown once it mounts", () => {
    publishChatError("ws-a", "Stop could not be recorded");

    const input = mountInput("ws-a");

    expect(input.shown).toEqual(["Stop could not be recorded"]);
    // Queued until the toast has been rendered and dismissed, not merely pushed.
    expect(peekChatError("ws-a")).toBe("Stop could not be recorded");
    input.show("Stop could not be recorded");
    input.dismiss();
    expect(peekChatError("ws-a")).toBeUndefined();
  });

  test("an error published while the input is mounted is shown immediately", () => {
    const input = mountInput("ws-b");

    act(() => {
      publishChatError("ws-b", "Child exceeded the goal budget");
    });

    expect(input.shown).toEqual(["Child exceeded the goal budget"]);
    drain("ws-b");
  });

  test("errors for another workspace stay retained for that workspace's input", () => {
    const input = mountInput("ws-c");

    act(() => {
      publishChatError("ws-d", "for d");
    });

    expect(input.shown).toEqual([]);
    const other = mountInput("ws-d");
    expect(other.shown).toEqual(["for d"]);
    drain("ws-d");
  });

  test("an error published after the input unmounts waits for the next mount", () => {
    const first = mountInput("ws-e");
    first.unmount();

    publishChatError("ws-e", "late Stop failure");
    expect(first.shown).toEqual([]);

    const second = mountInput("ws-e");
    expect(second.shown).toEqual(["late Stop failure"]);
    drain("ws-e");
  });

  test("errors retained together are shown one toast at a time, the next after a dismissal", () => {
    publishChatError("ws-f", "first");
    publishChatError("ws-f", "second");

    const input = mountInput("ws-f");
    expect(input.shown).toEqual(["first"]);

    input.show("first");
    expect(input.shown).toEqual(["first"]);
    input.dismiss();
    expect(input.shown).toEqual(["first", "second"]);

    input.show("second");
    input.dismiss();
    expect(input.shown).toEqual(["first", "second"]);
    expect(peekChatError("ws-f")).toBeUndefined();
  });

  test("an error published while another toast is visible waits for that toast to be dismissed", () => {
    const input = mountInput("ws-g");
    input.show("Not connected to server");

    act(() => {
      publishChatError("ws-g", "Stop could not be recorded");
    });
    expect(input.shown).toEqual([]);

    input.dismiss();
    expect(input.shown).toEqual(["Stop could not be recorded"]);
    input.show("Stop could not be recorded");
    input.dismiss();
    expect(peekChatError("ws-g")).toBeUndefined();
  });

  test("a pushed error another toast rendered over is pushed again once that toast is dismissed", () => {
    const input = mountInput("ws-h");
    act(() => {
      publishChatError("ws-h", "lost in a batch");
    });
    expect(input.shown).toEqual(["lost in a batch"]);

    // The input rendered a different toast (a same-tick setToast won the batch), never ours.
    input.show("something else");
    input.dismiss();

    expect(input.shown).toEqual(["lost in a batch", "lost in a batch"]);
    input.show("lost in a batch");
    input.dismiss();
    expect(peekChatError("ws-h")).toBeUndefined();
  });

  test("a displayed error that another toast replaced is pushed again once that toast is dismissed", () => {
    const input = mountInput("ws-j");
    act(() => {
      publishChatError("ws-j", "Stop could not be recorded");
    });
    input.show("Stop could not be recorded");
    // A later toast took the slot before the user dismissed ours.
    input.show("Thinking level: high");
    input.dismiss();

    expect(input.shown).toEqual(["Stop could not be recorded", "Stop could not be recorded"]);
    input.show("Stop could not be recorded");
    input.dismiss();
    expect(peekChatError("ws-j")).toBeUndefined();
  });

  test("an info notice shows as an info toast, and a newer one replaces one still waiting", () => {
    publishChatError("ws-k", "Stop could not be recorded");
    publishChatInfo("ws-k", "Plugin ralph: plugin continued turn 1 of 50");
    publishChatInfo("ws-k", "Plugin ralph: plugin continued turn 2 of 50");

    const input = mountInput("ws-k");
    input.show("Stop could not be recorded");
    input.dismiss();
    input.show("Plugin ralph: plugin continued turn 2 of 50");
    input.dismiss();

    expect(input.pushed).toEqual([
      { type: "error", message: "Stop could not be recorded" },
      { type: "info", message: "Plugin ralph: plugin continued turn 2 of 50" },
    ]);
    expect(peekChatError("ws-k")).toBeUndefined();
  });

  test("info notices published while one shows leave only the newest to show next", () => {
    const input = mountInput("ws-l");
    act(() => {
      publishChatInfo("ws-l", "turn 1");
    });
    input.show("turn 1");
    act(() => {
      publishChatInfo("ws-l", "turn 2");
      publishChatInfo("ws-l", "turn 3");
    });
    input.dismiss();
    input.show("turn 3");
    input.dismiss();

    expect(input.shown).toEqual(["turn 1", "turn 3"]);
    expect(peekChatError("ws-l")).toBeUndefined();
  });

  test("StrictMode's replayed effect re-pushes the same error instead of consuming the next one", () => {
    publishChatError("ws-i", "first");
    publishChatError("ws-i", "second");

    const input = mountInput("ws-i", { strict: true });

    expect(input.shown.length).toBeGreaterThan(0);
    expect(new Set(input.shown)).toEqual(new Set(["first"]));
    expect(peekChatError("ws-i")).toBe("first");
    drain("ws-i");
  });
});
