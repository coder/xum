import { describe, expect, test } from "bun:test";
import { isSessionTapeReplayAllowedUrl } from "./sessionTapeReplayEgress";

describe("isSessionTapeReplayAllowedUrl", () => {
  const devOrigin = "http://127.0.0.1:5173";

  test.each<[string, string, string | undefined, boolean]>([
    ["the dist app page", "file:///opt/xum/dist/index.html", undefined, true],
    ["inline data", "data:image/png;base64,AAAA", undefined, true],
    ["blob URLs", "blob:file:///0b6c1f2e-1234", undefined, true],
    ["devtools", "devtools://devtools/bundled/inspector.html", undefined, true],
    ["a recorded remote image", "https://replay-egress-probe.invalid/a.png", undefined, false],
    ["a recorded loopback image", "http://127.0.0.1:47999/a.png", undefined, false],
    ["localhost", "http://localhost:5173/", undefined, false],
    ["a websocket", "wss://example.com/socket", undefined, false],
    ["an unparseable URL", "not a url", undefined, false],
    ["the dev server page", "http://127.0.0.1:5173/src/main.tsx", devOrigin, true],
    ["the dev server's HMR socket", "ws://127.0.0.1:5173/?token=x", devOrigin, true],
    ["the dev server origin over https", "https://127.0.0.1:5173/", devOrigin, false],
    ["the dev server host on another port", "http://127.0.0.1:47999/a.png", devOrigin, false],
    ["another loopback name for the dev server", "http://localhost:5173/", devOrigin, false],
    ["a remote host in dev mode", "https://replay-egress-probe.invalid/a.png", devOrigin, false],
  ])("%s: %s", (_name, url, devServerOrigin, allowed) => {
    expect(isSessionTapeReplayAllowedUrl(url, devServerOrigin)).toBe(allowed);
  });
});
