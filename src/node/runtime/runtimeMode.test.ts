import { describe, expect, test } from "bun:test";

import { DevcontainerRuntime } from "./DevcontainerRuntime";
import { DockerRuntime } from "./DockerRuntime";
import { LocalRuntime } from "./LocalRuntime";
import type { Runtime } from "./Runtime";
import { SSHRuntime } from "./SSHRuntime";
import type { SSHRuntimeConfig } from "./sshConnectionPool";
import { createSSHTransport } from "./transports";

describe("Runtime.mode", () => {
  test("the runtimes that run off the Xum host report their config type", () => {
    const sshConfig: SSHRuntimeConfig = { host: "example.test", srcBaseDir: "/remote/src" };
    expect(new SSHRuntime(sshConfig, createSSHTransport(sshConfig, true)).mode).toBe("ssh");
    expect(new DockerRuntime({ image: "ubuntu:22.04" }).mode).toBe("docker");
    expect(
      new DevcontainerRuntime({
        srcBaseDir: "/host/src",
        configPath: ".devcontainer/devcontainer.json",
      }).mode
    ).toBe("devcontainer");
  });

  test("a host runtime leaves it unset, so a message falls back to its location", () => {
    const local: Runtime = new LocalRuntime("/host/project");
    expect(local.mode).toBeUndefined();
  });
});
