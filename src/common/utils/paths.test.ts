import { describe, expect, test } from "bun:test";
import { serverPathLabel } from "./paths";

// #6714: the renderer names a project or checkout from a path the SERVER sent. The server can run
// on Windows while the browser runs elsewhere, so the label must split on "\\" as well as "/",
// whatever the client platform is.
describe("serverPathLabel", () => {
  test.each([
    ["a Windows path", "C:\\Users\\u\\repo", "repo"],
    ["a POSIX path", "/home/u/repo", "repo"],
    ["a mixed path", "C:/Users/u\\repo", "repo"],
    ["a bare name", "repo", "repo"],
  ])("labels %s by its last segment", (_label, input, expected) => {
    expect(serverPathLabel(input, "fallback")).toBe(expected);
  });

  test.each([
    ["a trailing POSIX separator", "/home/u/repo/"],
    ["a trailing Windows separator", "C:\\Users\\u\\repo\\"],
    ["an empty path", ""],
  ])("uses the fallback for %s", (_label, input) => {
    expect(serverPathLabel(input, "fallback")).toBe("fallback");
  });
});
