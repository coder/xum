import { describe, expect, it } from "bun:test";
import { LEGACY_REMOTE_MUX_HOME } from "@/common/compat/legacyMux";
import { LocalRuntime } from "./LocalRuntime";
import type { Runtime } from "./Runtime";
import { TestRemoteRuntime } from "./testRemoteRuntime";
import { resolveGlobalRuntime } from "./hostGlobalXumHome";

class StubRemoteRuntime extends TestRemoteRuntime {
  constructor(private readonly xumHome: string) {
    super();
  }

  override getXumHome(): string {
    return this.xumHome;
  }
}

describe("hostGlobalXumHome", () => {
  const workspacePath = "/tmp/xum-host-global-home";

  it("falls back to the host local runtime only for SSH legacy ~/.mux", () => {
    const sshRuntime = new StubRemoteRuntime(LEGACY_REMOTE_MUX_HOME);
    expect(resolveGlobalRuntime(sshRuntime, workspacePath)).toBeInstanceOf(LocalRuntime);
  });

  it("keeps Docker /var/mux on the container runtime", () => {
    const dockerRuntime = new StubRemoteRuntime("/var/mux");
    expect(resolveGlobalRuntime(dockerRuntime, workspacePath)).toBe(dockerRuntime);
  });

  it("reads the runtime family from Runtime.location, not from the runtime class", () => {
    // A double with no RemoteRuntime prototype: the agent loop's runtimes need not be runtime classes.
    const remoteDouble: Partial<Runtime> = {
      location: "remote",
      getXumHome: () => LEGACY_REMOTE_MUX_HOME,
    };
    expect(resolveGlobalRuntime(remoteDouble as Runtime, workspacePath)).toBeInstanceOf(
      LocalRuntime
    );
  });

  it("keeps local canonical ~/.xum on the workspace runtime", () => {
    const localRuntime = new LocalRuntime(workspacePath);
    expect(localRuntime.getXumHome()).toBe("~/.xum");
    expect(resolveGlobalRuntime(localRuntime, workspacePath)).toBe(localRuntime);
  });
});
