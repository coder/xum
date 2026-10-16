import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import {
  agentCgroupEnrollmentLine,
  setAgentCgroupEnrollmentTarget,
} from "@/node/runtime/agentCgroupEnrollment";
import { waitForCondition } from "@/node/services/testDispatchHelpers";
import type { AgentCgroupHost } from "./agentCgroup";
import { AgentResourceLimitsService } from "./agentResourceLimitsService";
import { createFakeCgroupTree, type FakeCgroupTree } from "./testHelpers";

describe("AgentResourceLimitsService", () => {
  let rootDir: string;
  let config: Config;
  let tree: FakeCgroupTree;
  let service: AgentResourceLimitsService | undefined;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-limits-"));
    config = new Config(rootDir);
    tree = await createFakeCgroupTree({
      own: "/xum",
      cgroups: { xum: { controllers: "cpu memory" } },
    });
  });

  afterEach(async () => {
    service?.dispose();
    service = undefined;
    setAgentCgroupEnrollmentTarget(null);
    await tree.dispose();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const cpuMax = () => tree.read("xum/xum-agents", "cpu.max");
  const procsFile = () => path.join(tree.root, "xum", "xum-agents", "cgroup.procs");

  it("applies the saved limits at start and again when the setting changes", async () => {
    await config.updateAgentResourceLimits({ cpuCores: 2 });
    service = new AgentResourceLimitsService(config, tree.host);

    await service.start();

    expect(service.get()).toEqual({
      limits: { cpuCores: 2 },
      status: { state: "active", cgroup: "/xum/xum-agents" },
    });
    expect(await cpuMax()).toBe("200000 100000");
    expect(agentCgroupEnrollmentLine()).toContain(procsFile());

    // A change from another window or process arrives only through the config listener.
    await config.updateAgentResourceLimits({ cpuCores: 4 });
    await waitForCondition(async () => (await cpuMax()) === "400000 100000");

    await config.updateAgentResourceLimits({});
    await waitForCondition(() => service?.get().status.state === "off");
    expect(await cpuMax()).toBe("max 100000");
    expect(agentCgroupEnrollmentLine()).toBe("");
  });

  it("does not touch the cgroup when an unrelated setting changes", async () => {
    await config.updateAgentResourceLimits({ cpuCores: 2 });
    service = new AgentResourceLimitsService(config, tree.host);
    await service.start();
    const writesAfterStart = tree.writes.length;

    await config.updateBashAiProxyEnabled(true);
    // set() runs after any apply that the change queued, and applies the unchanged limits once.
    await service.set({ cpuCores: 2 });

    expect(tree.writes.length - writesAfterStart).toBe(1);
  });

  it("saves and applies the limits it is given", async () => {
    service = new AgentResourceLimitsService(config, tree.host);
    await service.start();
    expect(service.get().status).toEqual({ state: "off" });

    const state = await service.set({ cpuCores: 1.5, memoryGiB: 2 });

    expect(state).toEqual({
      limits: { cpuCores: 1.5, memoryGiB: 2 },
      status: { state: "active", cgroup: "/xum/xum-agents" },
    });
    expect(new Config(rootDir).loadConfigOrDefault().agentResourceLimits).toEqual({
      cpuCores: 1.5,
      memoryGiB: 2,
    });
    expect(await cpuMax()).toBe("150000 100000");
  });

  it("applies saved limits once, though the save also notifies the config listener", async () => {
    service = new AgentResourceLimitsService(config, tree.host);
    await service.start();

    await service.set({ cpuCores: 2 });

    expect(tree.writes.filter((write) => write.file.endsWith("cpu.max"))).toHaveLength(1);
  });

  it("reports a failed apply and stops moving new commands into the old cgroup", async () => {
    let failing = false;
    const host: AgentCgroupHost = {
      ...tree.host,
      readSelfCgroup: () =>
        failing
          ? Promise.reject(new Error("cannot read /proc/self/cgroup"))
          : tree.host.readSelfCgroup(),
    };
    service = new AgentResourceLimitsService(config, host);
    await service.set({ cpuCores: 2 });
    expect(agentCgroupEnrollmentLine()).toContain(procsFile());

    failing = true;
    const state = await service.set({ cpuCores: 3 });

    expect(state.status).toEqual({ state: "unavailable", reason: "cannot read /proc/self/cgroup" });
    expect(agentCgroupEnrollmentLine()).toBe("");

    // Try again in Settings saves the same limits.
    failing = false;
    const retried = await service.set({ cpuCores: 3 });

    expect(retried.status).toEqual({ state: "active", cgroup: "/xum/xum-agents" });
    expect(agentCgroupEnrollmentLine()).toContain(procsFile());
  });
});
