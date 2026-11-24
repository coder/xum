import { describe, expect, test } from "bun:test";
import type { Session } from "electron";
import { isSessionTapeReplayEgressBlocked } from "@/common/utils/sessionTapes/sessionTapeReplay";
import {
  installSessionTapeReplayEgressBlock,
  isSessionTapeReplayAllowedUrl,
} from "./sessionTapeReplayEgress";

describe("isSessionTapeReplayAllowedUrl", () => {
  const devOrigin = "http://127.0.0.1:5173";

  test.each<[string, string, readonly string[], boolean]>([
    ["the dist app page", "file:///opt/xum/dist/index.html", [], true],
    ["a remote file share (UNC authority)", "file://192.168.1.1/share/probe.png", [], false],
    ["a remote file share (UNC path)", "file:////192.168.1.1/share/probe.png", [], false],
    ["inline data", "data:image/png;base64,AAAA", [], true],
    ["blob URLs", "blob:file:///0b6c1f2e-1234", [], true],
    ["devtools", "devtools://devtools/bundled/inspector.html", [], true],
    ["a recorded remote image", "https://replay-egress-probe.invalid/a.png", [], false],
    ["a recorded loopback image", "http://127.0.0.1:47999/a.png", [], false],
    ["localhost", "http://localhost:5173/", [], false],
    ["a websocket", "wss://example.com/socket", [], false],
    ["an unparseable URL", "not a url", [], false],
    ["the dev server page", "http://127.0.0.1:5173/src/main.tsx", [devOrigin], true],
    ["the dev server's HMR socket", "ws://127.0.0.1:5173/?token=x", [devOrigin], true],
    ["the dev server origin over https", "https://127.0.0.1:5173/", [devOrigin], false],
    ["the dev server host on another port", "http://127.0.0.1:47999/a.png", [devOrigin], false],
    ["another loopback name for the dev server", "http://localhost:5173/", [devOrigin], false],
    [
      "the terminal page origin",
      "http://localhost:5173/terminal.html?workspaceId=w",
      [devOrigin, "http://localhost:5173"],
      true,
    ],
    ["a remote host in dev mode", "https://replay-egress-probe.invalid/a.png", [devOrigin], false],
  ])("%s: %s", (_name, url, devServerOrigins, allowed) => {
    expect(isSessionTapeReplayAllowedUrl(url, devServerOrigins)).toBe(allowed);
  });
});

describe("installSessionTapeReplayEgressBlock", () => {
  test("cancels refused requests, and only then lets the backend serve tapes", () => {
    let listener:
      | ((details: { url: string }, callback: (response: { cancel: boolean }) => void) => void)
      | undefined;
    const session = {
      webRequest: {
        onBeforeRequest: (_filter: unknown, handler: NonNullable<typeof listener>) => {
          // The latch must not be set before the block exists.
          expect(isSessionTapeReplayEgressBlocked()).toBe(false);
          listener = handler;
        },
      },
    } as unknown as Session;
    installSessionTapeReplayEgressBlock(session, []);
    expect(isSessionTapeReplayEgressBlocked()).toBe(true);
    const decide = (url: string) => {
      let cancel: boolean | undefined;
      listener?.({ url }, (response) => (cancel = response.cancel));
      return cancel;
    };
    expect(decide("https://replay-egress-probe.invalid/a.png")).toBe(true);
    expect(decide("file:///opt/xum/dist/index.html")).toBe(false);
  });
});
