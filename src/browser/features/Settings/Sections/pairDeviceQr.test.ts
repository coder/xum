import { describe, expect, test } from "bun:test";
import {
  buildConnectionLink,
  defaultPairingBaseUrl,
  isLoopbackBaseUrl,
  maskConnectionLink,
  pairingBaseUrls,
} from "./pairDeviceQr";

describe("buildConnectionLink", () => {
  test("URL-encodes the token", () => {
    expect(buildConnectionLink("http://10.0.0.2:8462", "a/b+c d")).toBe(
      "http://10.0.0.2:8462/?token=a%2Fb%2Bc%20d"
    );
  });

  test("keeps a reverse-proxy path prefix on the base URL", () => {
    expect(buildConnectionLink("https://devbox.tail4e2c.ts.net/xum", "tok")).toBe(
      "https://devbox.tail4e2c.ts.net/xum/?token=tok"
    );
  });
});

describe("maskConnectionLink", () => {
  test("hides the token but keeps the address readable", () => {
    expect(maskConnectionLink("http://192.168.1.10:8462/?token=secretvalue")).toBe(
      "http://192.168.1.10:8462/?token=\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"
    );
  });
});

describe("isLoopbackBaseUrl", () => {
  test.each([
    ["http://127.0.0.1:8462", true],
    ["http://127.9.9.9:8462", true],
    ["http://localhost:3000", true],
    ["http://[::1]:9000", true],
    ["http://192.168.1.10:8462", false],
    ["http://100.64.0.2:8462", false],
    ["http://devbox.tail4e2c.ts.net:8462", false],
    ["https://example.com/xum", false],
  ])("%s", (url, loopback) => {
    expect(isLoopbackBaseUrl(url)).toBe(loopback);
  });
});

describe("pairingBaseUrls", () => {
  test("lists network addresses first, then the base URL, deduplicated", () => {
    expect(
      pairingBaseUrls({
        baseUrl: "http://127.0.0.1:8462",
        networkBaseUrls: ["http://192.168.1.10:8462", "http://127.0.0.1:8462"],
      })
    ).toEqual(["http://192.168.1.10:8462", "http://127.0.0.1:8462"]);
  });

  test("falls back to the base URL when no network address exists", () => {
    expect(pairingBaseUrls({ baseUrl: "http://127.0.0.1:8462", networkBaseUrls: [] })).toEqual([
      "http://127.0.0.1:8462",
    ]);
  });

  test("returns nothing when the server is not running", () => {
    expect(pairingBaseUrls({ baseUrl: null, networkBaseUrls: [] })).toEqual([]);
  });
});

describe("defaultPairingBaseUrl", () => {
  test("prefers an address a phone can reach over loopback", () => {
    expect(defaultPairingBaseUrl(["http://127.0.0.1:8462", "http://192.168.1.10:8462"])).toBe(
      "http://192.168.1.10:8462"
    );
  });

  test("falls back to loopback when it is the only address", () => {
    expect(defaultPairingBaseUrl(["http://127.0.0.1:8462"])).toBe("http://127.0.0.1:8462");
  });

  test("is null without any address", () => {
    expect(defaultPairingBaseUrl([])).toBeNull();
  });
});
