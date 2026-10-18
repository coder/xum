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
    await config.updateAgentResourceLimitsEnabled(true);
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
  /** The fake host, but reading /proc/self/cgroup fails while `failing()` is true. */
  const hostFailingWhile = (failing: () => boolean): AgentCgroupHost => ({
    ...tree.host,
    readSelfCgroup: () =>
      failing()
        ? Promise.reject(new Error("cannot read /proc/self/cgroup"))
        : tree.host.readSelfCgroup(),
  });

  it("applies the saved limits at start and again when the setting changes", async () => {
    await config.updateAgentResourceLimits({ cpuCores: 2 });
    service = new AgentResourceLimitsService(config, tree.host);

    await service.start();

    expect(await service.get()).toEqual({
      enabled: true,
      limits: { cpuCores: 2 },
      status: { state: "active", cgroup: "/xum/xum-agents" },
    });
    expect(await cpuMax()).toBe("200000 100000");
    expect(agentCgroupEnrollmentLine()).toContain(procsFile());

    // A change from another window or process arrives only through the config listener.
    await config.updateAgentResourceLimits({ cpuCores: 4 });
    await waitForCondition(async () => (await cpuMax()) === "400000 100000");

    await config.updateAgentResourceLimits({});
    expect((await service.get()).status).toEqual({ state: "off" });
    expect(await cpuMax()).toBe("max 100000");
    expect(agentCgroupEnrollmentLine()).toBe("");
  });

  it("removes the limits while they are off and applies the saved ones when turned on", async () => {
    await config.updateAgentResourceLimits({ cpuCores: 2 });
    service = new AgentResourceLimitsService(config, tree.host);
    await service.start();

    expect(await service.setEnabled(false)).toEqual({
      enabled: false,
      limits: { cpuCores: 2 },
      status: { state: "off" },
    });
    expect(await cpuMax()).toBe("max 100000");
    expect(agentCgroupEnrollmentLine()).toBe("");

    // Turned on in another window or process, so only the config listener sees it.
    await config.updateAgentResourceLimitsEnabled(true);
    await waitForCondition(async () => (await cpuMax()) === "200000 100000");
    expect((await service.get()).status).toEqual({ state: "active", cgroup: "/xum/xum-agents" });
    expect(agentCgroupEnrollmentLine()).toContain(procsFile());
  });

  it("reports the status of limits that a config change is still applying", async () => {
    service = new AgentResourceLimitsService(config, tree.host);
    await service.start();

    // Settings reloads the limits after each config change, while the apply may still run.
    await config.updateAgentResourceLimits({ cpuCores: 4 });

    expect(await service.get()).toEqual({
      enabled: true,
      limits: { cpuCores: 4 },
      status: { state: "active", cgroup: "/xum/xum-agents" },
    });
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

  it("delegates with sudo at start, but not while the limits are off", async () => {
    // Root ignores file modes, so xum's cgroup cannot be root's there.
    if (process.getuid?.() === 0) return;
    await tree.dispose();
    tree = await createFakeCgroupTree({
      own: "/init.scope",
      cgroups: { "init.scope": { controllers: "cpu memory", procs: [String(process.pid)] } },
      sudoWorks: true,
    });
    await fs.chmod(path.join(tree.root, "init.scope", "cgroup.subtree_control"), 0o444);
    await config.updateAgentResourceLimits({ cpuCores: 2 });
    await config.updateAgentResourceLimitsEnabled(false);
    service = new AgentResourceLimitsService(config, tree.host);

    await service.start();

    expect((await service.get()).status).toEqual({ state: "off" });
    expect(tree.sudoCalls).toEqual([]);

    // xum restarts with the limits turned on.
    service.dispose();
    await config.updateAgentResourceLimitsEnabled(true);
    service = new AgentResourceLimitsService(config, tree.host);
    await service.start();

    expect((await service.get()).status).toEqual({
      state: "active",
      cgroup: "/xum-1000/xum-agents",
    });
    expect(tree.sudoCalls).toEqual(["xum-1000"]);
  });

  it("runs sudo only for applies a user asked for, not on every config write", async () => {
    // Root ignores file modes, so xum's cgroup cannot be root's there.
    if (process.getuid?.() === 0) return;
    await tree.dispose();
    tree = await createFakeCgroupTree({
      own: "/init.scope",
      cgroups: { "init.scope": { controllers: "cpu memory", procs: [String(process.pid)] } },
    });
    await fs.chmod(path.join(tree.root, "init.scope", "cgroup.subtree_control"), 0o444);
    service = new AgentResourceLimitsService(config, tree.host);
    await service.start();

    const state = await service.set({ cpuCores: 1, memoryGiB: 2 });
    await config.updateBashAiProxyEnabled(true);
    const afterUnrelatedWrite = await service.get();

    const sudoFailed = expect.stringContaining("with sudo failed: sudo: a password is required");
    expect(state.status).toHaveProperty("reason", sudoFailed);
    expect(afterUnrelatedWrite.status).toHaveProperty("reason", sudoFailed);
    expect(tree.sudoCalls).toEqual(["xum-1000"]);

    // Try again saves the unchanged limits.
    await service.set({ cpuCores: 1, memoryGiB: 2 });
    expect(tree.sudoCalls).toEqual(["xum-1000", "xum-1000"]);
    await service.setEnabled(false);
    await service.setEnabled(true);
    expect(tree.sudoCalls).toEqual(["xum-1000", "xum-1000", "xum-1000"]);
  });

  it("saves and applies the limits it is given", async () => {
    service = new AgentResourceLimitsService(config, tree.host);
    await service.start();
    expect((await service.get()).status).toEqual({ state: "off" });

    const state = await service.set({ cpuCores: 1.5, memoryGiB: 2 });

    expect(state).toEqual({
      enabled: true,
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
    service = new AgentResourceLimitsService(
      config,
      hostFailingWhile(() => failing)
    );
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

  it("retries limits it could not apply when another backend saves them again", async () => {
    let failing = true;
    service = new AgentResourceLimitsService(
      config,
      hostFailingWhile(() => failing)
    );
    await service.start();
    expect((await service.set({ cpuCores: 3 })).status.state).toBe("unavailable");

    // Try again in another backend's Settings saves the same limits, which this backend sees
    // only as a config change.
    failing = false;
    await config.updateAgentResourceLimits({ cpuCores: 3 });

    expect((await service.get()).status.state).toBe("active");
    expect(agentCgroupEnrollmentLine()).toContain(procsFile());
  });
});
