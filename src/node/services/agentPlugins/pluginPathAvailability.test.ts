import { describe, expect, test } from "bun:test";

import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { Runtime } from "@/node/runtime/Runtime";
import { multiProjectOf } from "@/node/runtime/testMultiProjectRuntime";
import { TestRemoteRuntime } from "@/node/runtime/testRemoteRuntime";
import { WorktreeRuntime } from "@/node/runtime/WorktreeRuntime";

import {
  describeWorkspaceRuntime,
  isPluginPathUsableFrom,
  toAgentBodyPath,
} from "./pluginPathAvailability";

const host = new LocalRuntime("/host/project");
const otherHost = new LocalRuntime("/host/other");
const remote = new TestRemoteRuntime();
const devcontainer = new DevcontainerRuntime({
  srcBaseDir: "/host/src",
  configPath: ".devcontainer/devcontainer.json",
});

const worktree = new WorktreeRuntime("/host/src", {
  projectPath: "/host/project",
  workspaceName: "ws",
});
const ssh = Object.create(remote, { mode: { value: "ssh" } }) as Runtime;

describe("isPluginPathUsableFrom", () => {
  test("a host plugin is usable on any runtime that runs on the host", () => {
    expect(isPluginPathUsableFrom(host, host)).toBe(true);
    expect(isPluginPathUsableFrom(host, otherHost)).toBe(true);
  });

  test("a plugin read through a remote runtime is usable only on that same runtime", () => {
    expect(isPluginPathUsableFrom(remote, remote)).toBe(true);
    expect(isPluginPathUsableFrom(remote, new TestRemoteRuntime())).toBe(false);
  });

  test("a host plugin is not usable where bash runs on another machine or in a container", () => {
    expect(isPluginPathUsableFrom(host, remote)).toBe(false);
    expect(isPluginPathUsableFrom(host, devcontainer)).toBe(false);
  });

  test("a devcontainer reads the host but runs in the container, so even it cannot use its own read", () => {
    expect(isPluginPathUsableFrom(devcontainer, devcontainer)).toBe(false);
  });

  test("a runtime double without a location is never proven to share the host filesystem", () => {
    const unknown = Object.create(host) as typeof host;
    Object.defineProperty(unknown, "location", { value: undefined });
    expect(isPluginPathUsableFrom(host, unknown)).toBe(false);
    expect(isPluginPathUsableFrom(unknown, unknown)).toBe(false);
  });
});

describe("isPluginPathUsableFrom in a multi-project workspace", () => {
  test("a host plugin is usable when every project runs on the host", () => {
    expect(isPluginPathUsableFrom(host, multiProjectOf(host))).toBe(true);
    expect(isPluginPathUsableFrom(host, multiProjectOf(host, worktree, otherHost))).toBe(true);
  });

  test("a host plugin is not usable when any project runs elsewhere, whichever project is first", () => {
    for (const elsewhere of [remote, ssh, devcontainer]) {
      expect(isPluginPathUsableFrom(host, multiProjectOf(elsewhere))).toBe(false);
      expect(isPluginPathUsableFrom(host, multiProjectOf(host, elsewhere))).toBe(false);
      expect(isPluginPathUsableFrom(host, multiProjectOf(elsewhere, host))).toBe(false);
    }
  });

  test("a wrapper inside a wrapper is on the host only when every leaf runtime is", () => {
    const allOnHost = multiProjectOf(multiProjectOf(host, worktree), host);
    const innerSsh = multiProjectOf(multiProjectOf(host, ssh), host);
    expect(isPluginPathUsableFrom(host, allOnHost)).toBe(true);
    expect(isPluginPathUsableFrom(host, innerSsh)).toBe(false);
  });

  test("a wrapper that wraps nothing is not proven to run on the host", () => {
    const empty = Object.create(host, { wrappedRuntimes: { value: [] } }) as Runtime;
    expect(isPluginPathUsableFrom(host, empty)).toBe(false);
  });
});

describe("toAgentBodyPath", () => {
  test("keeps a POSIX host path", () => {
    expect(toAgentBodyPath("/home/u/.xum/plugins/egm", host)).toBe("/home/u/.xum/plugins/egm");
  });

  test("writes a Windows host path with forward slashes, not the MSYS /c/ form", () => {
    expect(toAgentBodyPath("C:\\Users\\u\\.xum\\plugins\\egm", host)).toBe(
      "C:/Users/u/.xum/plugins/egm"
    );
    expect(toAgentBodyPath("d:\\p", host)).toBe("d:/p");
    expect(toAgentBodyPath("C:/Users/u/plugins/egm", host)).toBe("C:/Users/u/plugins/egm");
    expect(toAgentBodyPath("\\\\server\\share\\plugins\\egm", host)).toBe(
      "//server/share/plugins/egm"
    );
  });

  test("leaves a remote path as the remote reports it", () => {
    expect(toAgentBodyPath("/workspace/.xum/plugins/kit", remote)).toBe(
      "/workspace/.xum/plugins/kit"
    );
    expect(toAgentBodyPath("C:\\remote\\kit", remote)).toBe("C:\\remote\\kit");
  });

  test("keeps a backslash inside a POSIX path", () => {
    expect(toAgentBodyPath("/home/u/odd\\name/egm", host)).toBe("/home/u/odd\\name/egm");
  });
});

describe("describeWorkspaceRuntime", () => {
  test("names the runtime type when the runtime gives one, else its location family", () => {
    expect(describeWorkspaceRuntime({ mode: "ssh", location: "remote" })).toBe("ssh");
    expect(describeWorkspaceRuntime({ mode: "docker", location: "remote" })).toBe("docker");
    expect(describeWorkspaceRuntime(devcontainer)).toBe("devcontainer");
    expect(describeWorkspaceRuntime(remote)).toBe("remote");
    expect(describeWorkspaceRuntime({})).toBe("unknown");
  });

  test("names a multi-project workspace by the first project runtime that is not on the host", () => {
    expect(describeWorkspaceRuntime(multiProjectOf(host, ssh))).toBe("multi-project ssh");
    expect(describeWorkspaceRuntime(multiProjectOf(ssh, host))).toBe("multi-project ssh");
    expect(describeWorkspaceRuntime(multiProjectOf(host, devcontainer, ssh))).toBe(
      "multi-project devcontainer"
    );
    expect(describeWorkspaceRuntime(multiProjectOf(remote))).toBe("multi-project remote");
    expect(describeWorkspaceRuntime(multiProjectOf(host, worktree))).toBe("multi-project");
    expect(describeWorkspaceRuntime(multiProjectOf(multiProjectOf(host, ssh), host))).toBe(
      "multi-project multi-project ssh"
    );
  });
});
