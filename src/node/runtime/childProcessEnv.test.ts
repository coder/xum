import { describe, expect, it } from "bun:test";
import { mergeChildEnv, pickMinimalChildEnv } from "./childProcessEnv";

describe("pickMinimalChildEnv", () => {
  it("keeps allowlisted and CA variables and drops everything else", () => {
    const picked = pickMinimalChildEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/u",
        LANG: "C.UTF-8",
        NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
        GITHUB_TOKEN: "secret",
        OPENAI_API_KEY: "secret",
        HTTPS_PROXY: "http://user:pass@proxy:3128",
      },
      "linux"
    );
    expect(picked).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/u",
      LANG: "C.UTF-8",
      NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
    });
  });

  it("matches Windows names case-insensitively and keeps their casing", () => {
    const picked = pickMinimalChildEnv(
      { Path: "C:\\bin", SystemRoot: "C:\\Windows", ApiToken: "secret" },
      "win32"
    );
    expect(picked).toEqual({ Path: "C:\\bin", SystemRoot: "C:\\Windows" });
  });

  it("matches POSIX names case-sensitively", () => {
    expect(pickMinimalChildEnv({ path: "/x", Home: "/y" }, "darwin")).toEqual({});
  });

  it("drops exported bash functions and unset values", () => {
    const picked = pickMinimalChildEnv(
      { SHELL: "() { :; }; echo pwned", TERM: undefined, USER: "u" },
      "linux"
    );
    expect(picked).toEqual({ USER: "u" });
  });
});

// #6821: on Windows "Path" and "PATH" name one variable, so a caller's env key replaces every
// case variant of the host base instead of sitting next to it.
describe("mergeChildEnv", () => {
  it("drops host names that match a caller key without case on Windows", () => {
    const merged = mergeChildEnv(
      { Path: "C:\\host", Temp: "C:\\t", SystemRoot: "C:\\Windows" },
      { PATH: "C:\\mine", TEMP: "C:\\other" },
      "win32"
    );
    expect(merged).toEqual({ SystemRoot: "C:\\Windows", PATH: "C:\\mine", TEMP: "C:\\other" });
  });

  it("keeps case variants on POSIX, where they are distinct variables", () => {
    expect(mergeChildEnv({ path: "/a", HOME: "/h" }, { PATH: "/b" }, "linux")).toEqual({
      path: "/a",
      HOME: "/h",
      PATH: "/b",
    });
  });
});
