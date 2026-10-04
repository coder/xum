import { describe, expect, test } from "bun:test";
import { isSessionTapeReplayAllowedUrl } from "./sessionTapeReplayEgress";

describe("isSessionTapeReplayAllowedUrl", () => {
  const devOrigin = "http://127.0.0.1:5173";

  test.each<[string, string, readonly string[], boolean]>([
    ["the dist app page", "file:///opt/xum/dist/index.html", [], true],
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
