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

  it("shows a Daytona sandbox by id, or by host before it has one", () => {
    const created = getSshRuntimeInfo({
      type: "ssh",
      host: "sb-1.xum--daytona",
      srcBaseDir: "~/src",
      daytona: { sandboxName: "sb-1" },
    });
    expect(created.type).toBe("daytona");
    expect(created.label).toContain("sb-1");
    const pending = getSshRuntimeInfo({
      type: "ssh",
      host: "daytona-placeholder",
      srcBaseDir: "~/src",
      daytona: {},
    });
    expect(pending.type).toBe("daytona");
    expect(pending.label).toContain("daytona-placeholder");
  });

  it("shows a plain SSH host without its user", () => {
    const info = getSshRuntimeInfo({ type: "ssh", host: "me@box.example", srcBaseDir: "~/src" });
    expect(info.type).toBe("ssh");
    expect(info.label).toContain("box.example");
    expect(info.label).not.toContain("me@");
  });
});
