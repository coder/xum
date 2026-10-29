import { describe, expect, it } from "bun:test";
import { getSshRuntimeInfo } from "./RuntimeBadge";

describe("getSshRuntimeInfo", () => {
  it("shows a Coder workspace by name, or by host before it has one", () => {
    const named = getSshRuntimeInfo({
      type: "ssh",
      host: "coder-host",
      srcBaseDir: "~/src",
      coder: { workspaceName: "my-ws" },
    });
    expect(named.type).toBe("coder");
    expect(named.label).toContain("my-ws");
    const unnamed = getSshRuntimeInfo({
      type: "ssh",
      host: "coder-host",
      srcBaseDir: "~/src",
      coder: {},
    });
    expect(unnamed.label).toContain("coder-host");
  });

  it("shows a plain SSH host without its user", () => {
    const info = getSshRuntimeInfo({ type: "ssh", host: "me@box.example", srcBaseDir: "~/src" });
    expect(info.type).toBe("ssh");
    expect(info.label).toContain("box.example");
    expect(info.label).not.toContain("me@");
  });
});
