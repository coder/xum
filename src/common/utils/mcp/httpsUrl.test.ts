import { describe, expect, test } from "bun:test";
import { httpsOriginOf, isHttpsOrigin, isHttpsUrlWithoutUserinfo } from "./httpsUrl";

describe("isHttpsUrlWithoutUserinfo", () => {
  test("accepts https URLs with paths, queries, ports and IDNs", () => {
    expect(isHttpsUrlWithoutUserinfo("https://example.com")).toBe(true);
    expect(isHttpsUrlWithoutUserinfo("https://example.com:8443/docs?x=1#top")).toBe(true);
    expect(isHttpsUrlWithoutUserinfo("https://bücher.example/pfad")).toBe(true);
  });

  test("rejects other schemes, credentials, whitespace and controls", () => {
    expect(isHttpsUrlWithoutUserinfo("http://example.com")).toBe(false);
    expect(isHttpsUrlWithoutUserinfo("javascript:alert(1)")).toBe(false);
    expect(isHttpsUrlWithoutUserinfo("data:text/html,hi")).toBe(false);
    expect(isHttpsUrlWithoutUserinfo("https://user:pw@example.com")).toBe(false);
    expect(isHttpsUrlWithoutUserinfo("https://user@example.com")).toBe(false);
    // Empty userinfo still marks credential syntax.
    expect(isHttpsUrlWithoutUserinfo("https://@example.com")).toBe(false);
    // WHATWG URL parsing strips tabs/newlines and trims C0 space; the stored
    // string must already be clean.
    expect(isHttpsUrlWithoutUserinfo("https://exa\nmple.com")).toBe(false);
    expect(isHttpsUrlWithoutUserinfo(" https://example.com")).toBe(false);
    expect(isHttpsUrlWithoutUserinfo("https://example.com/a b")).toBe(false);
    expect(isHttpsUrlWithoutUserinfo("")).toBe(false);
    expect(isHttpsUrlWithoutUserinfo("https://")).toBe(false);
    expect(isHttpsUrlWithoutUserinfo("HTTPS://example.com")).toBe(false);
  });
});

describe("isHttpsOrigin / httpsOriginOf", () => {
  test("accepts only exact serialized https origins", () => {
    expect(isHttpsOrigin("https://example.com")).toBe(true);
    expect(isHttpsOrigin("https://example.com:8443")).toBe(true);
    // Default port, trailing slash, path, credentials, case and whitespace are not origins.
    expect(isHttpsOrigin("https://example.com:443")).toBe(false);
    expect(isHttpsOrigin("https://example.com/")).toBe(false);
    expect(isHttpsOrigin("https://example.com/mcp")).toBe(false);
    expect(isHttpsOrigin("https://u:p@example.com")).toBe(false);
    expect(isHttpsOrigin("https://Example.com")).toBe(false);
    expect(isHttpsOrigin("http://example.com")).toBe(false);
    expect(isHttpsOrigin("https://bücher.example")).toBe(false);
    expect(isHttpsOrigin("https://example.com ")).toBe(false);
    expect(isHttpsOrigin("")).toBe(false);
  });

  test("httpsOriginOf strips path, query, userinfo and default port; non-https yields undefined", () => {
    expect(httpsOriginOf("https://u:p@Example.com:443/mcp/v1?token=secret#frag")).toBe(
      "https://example.com"
    );
    expect(httpsOriginOf("https://bücher.example:8443/x")).toBe(
      "https://xn--bcher-kva.example:8443"
    );
    expect(httpsOriginOf("http://localhost:3000/mcp")).toBeUndefined();
    expect(httpsOriginOf("not a url")).toBeUndefined();
    expect(httpsOriginOf("")).toBeUndefined();
    const origin = httpsOriginOf("https://example.com/mcp");
    expect(origin).toBeDefined();
    expect(isHttpsOrigin(origin!)).toBe(true);
  });
});
