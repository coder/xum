import { describe, expect, test } from "bun:test";

import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { TestRemoteRuntime } from "@/node/runtime/testRemoteRuntime";

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
});
