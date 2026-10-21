import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import {
  agentCgroupEnrollmentLineForProject,
  setAgentCgroupEnrollmentTargets,
} from "@/node/runtime/agentCgroupEnrollment";
import { waitForCondition } from "@/node/services/testDispatchHelpers";
import { projectCgroupName, type AgentCgroupHost } from "./agentCgroup";
import { AgentResourceLimitsService } from "./agentResourceLimitsService";
import { createFakeCgroupTree, type FakeCgroupTree } from "./testHelpers";

const READY = { state: "ready", cgroup: "/xum" } as const;

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
    setAgentCgroupEnrollmentTargets(null);
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
      projects: {},
      status: { state: "active", cgroup: "/xum/xum-agents" },
      support: READY,
    });
    expect(await cpuMax()).toBe("200000 100000");
    expect(agentCgroupEnrollmentLineForProject(undefined)).toContain(procsFile());

    // A change from another window or process arrives only through the config listener.
    await config.updateAgentResourceLimits({ cpuCores: 4 });
    await waitForCondition(async () => (await cpuMax()) === "400000 100000");

    await config.updateAgentResourceLimits({});
    expect((await service.get()).status).toEqual({ state: "off" });
    expect(await cpuMax()).toBe("max 100000");
    expect(agentCgroupEnrollmentLineForProject(undefined)).toBe("");
  });

  it("removes the limits while they are off and applies the saved ones when turned on", async () => {
    await config.updateAgentResourceLimits({ cpuCores: 2 });
    service = new AgentResourceLimitsService(config, tree.host);
    await service.start();

    expect(await service.setEnabled(false)).toEqual({
      enabled: false,
      limits: { cpuCores: 2 },
      projects: {},
      status: { state: "off" },
      support: READY,
    });
    expect(await cpuMax()).toBe("max 100000");
    expect(agentCgroupEnrollmentLineForProject(undefined)).toBe("");

    // Turned on in another window or process, so only the config listener sees it.
    await config.updateAgentResourceLimitsEnabled(true);
    await waitForCondition(async () => (await cpuMax()) === "200000 100000");
    expect((await service.get()).status).toEqual({ state: "active", cgroup: "/xum/xum-agents" });
    expect(agentCgroupEnrollmentLineForProject(undefined)).toContain(procsFile());
  });

  it("reports the status of limits that a config change is still applying", async () => {
    service = new AgentResourceLimitsService(config, tree.host);
    await service.start();

    // Settings reloads the limits after each config change, while the apply may still run.
    await config.updateAgentResourceLimits({ cpuCores: 4 });

    expect(await service.get()).toEqual({
      enabled: true,
      limits: { cpuCores: 4 },
      projects: {},
      status: { state: "active", cgroup: "/xum/xum-agents" },
      support: READY,
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

    // Settings can tell before the limits are on that applying them takes sudo.
    expect(await service.get()).toMatchObject({
      status: { state: "off" },
      support: { state: "sudo", cgroup: "/init.scope" },
    });
    expect(tree.sudoCalls).toEqual([]);

    // xum restarts with the limits turned on.
    service.dispose();
    await config.updateAgentResourceLimitsEnabled(true);
    service = new AgentResourceLimitsService(config, tree.host);
    await service.start();

    expect(await service.get()).toMatchObject({
      status: { state: "active", cgroup: "/init.scope/xum-agents" },
      support: { state: "ready", cgroup: "/init.scope" },
    });
    expect(tree.sudoCalls).toEqual(["init.scope"]);
  });

  it("runs sudo once per user action, and not for config writes that keep the limits", async () => {
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

    const sudoFailed = "with sudo failed: sudo: a password is required";
    expect(state.status).toHaveProperty("reason", expect.stringContaining(sudoFailed));
    expect(afterUnrelatedWrite.status).toHaveProperty(
      "reason",
      expect.stringContaining(sudoFailed)
    );
    expect(tree.sudoCalls).toEqual(["init.scope"]);

    // Try again saves the unchanged limits.
    await service.set({ cpuCores: 1, memoryGiB: 2 });
    expect(tree.sudoCalls).toEqual(["init.scope", "init.scope"]);
    await service.setEnabled(false);
    await service.setEnabled(true);
    expect(tree.sudoCalls).toEqual(["init.scope", "init.scope", "init.scope"]);
  });

  it("delegates with sudo when another backend changes the limits", async () => {
    // Root ignores file modes, so xum's cgroup cannot be root's there.
    if (process.getuid?.() === 0) return;
    await tree.dispose();
    tree = await createFakeCgroupTree({
      own: "/init.scope",
      cgroups: { "init.scope": { controllers: "cpu memory", procs: [String(process.pid)] } },
      sudoWorks: true,
    });
    await fs.chmod(path.join(tree.root, "init.scope", "cgroup.subtree_control"), 0o444);
    service = new AgentResourceLimitsService(config, tree.host);
    await service.start();

    // Another backend's save reaches this backend only as a config change.
    await config.updateAgentResourceLimits({ cpuCores: 1 });

    expect((await service.get()).status).toEqual({
      state: "active",
      cgroup: "/init.scope/xum-agents",
    });
    expect(tree.sudoCalls).toEqual(["init.scope"]);
  });

  it("checks support for the saved limits, also while they are off", async () => {
    await tree.dispose();
    tree = await createFakeCgroupTree({ own: "/xum", cgroups: { xum: { controllers: "memory" } } });
    await config.updateAgentResourceLimits({ memoryGiB: 2 });
    await config.updateAgentResourceLimitsEnabled(false);
    service = new AgentResourceLimitsService(config, tree.host);
    await service.start();

    // A memory limit needs no cpu controller, so Settings must not report one missing.
    expect((await service.get()).support).toEqual({ state: "ready", cgroup: "/xum" });
  });

  it("saves and applies the limits it is given", async () => {
    service = new AgentResourceLimitsService(config, tree.host);
    await service.start();
    expect((await service.get()).status).toEqual({ state: "off" });

    const state = await service.set({ cpuCores: 1.5, memoryGiB: 2 });

    expect(state).toEqual({
      enabled: true,
      limits: { cpuCores: 1.5, memoryGiB: 2 },
      projects: {},
      status: { state: "active", cgroup: "/xum/xum-agents" },
      support: READY,
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
    expect(agentCgroupEnrollmentLineForProject(undefined)).toContain(procsFile());

    failing = true;
    const state = await service.set({ cpuCores: 3 });

    expect(state.status).toEqual({ state: "unavailable", reason: "cannot read /proc/self/cgroup" });
    expect(agentCgroupEnrollmentLineForProject(undefined)).toBe("");

    // Try again in Settings saves the same limits.
    failing = false;
    const retried = await service.set({ cpuCores: 3 });

    expect(retried.status).toEqual({ state: "active", cgroup: "/xum/xum-agents" });
    expect(agentCgroupEnrollmentLineForProject(undefined)).toContain(procsFile());
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
    expect(agentCgroupEnrollmentLineForProject(undefined)).toContain(procsFile());
  });

  describe("project limits", () => {
    const PHAROS = "/home/user/src/pharos";
    const pharosCgroup = `/xum/xum-agents/${projectCgroupName(PHAROS)}`;
    const projectCpuMax = () => tree.read(pharosCgroup.slice(1), "cpu.max");
    const addProject = (projectPath: string) =>
      config.editConfig((current) => {
        current.projects.set(projectPath, { workspaces: [] });
        return current;
      });

    it("applies a save that changes only a project limit, and moves its commands", async () => {
      await config.updateAgentResourceLimits({ cpuCores: 28, memoryGiB: 64 });
      await addProject(PHAROS);
      service = new AgentResourceLimitsService(config, tree.host);
      await service.start();

      const state = await service.setProject(PHAROS, { cpuCores: 14, memoryGiB: 32 });

      expect(state.projects).toEqual({
        [PHAROS]: { limits: { cpuCores: 14, memoryGiB: 32 }, cgroup: pharosCgroup },
      });
      expect(await projectCpuMax()).toBe("1400000 100000");
      expect(agentCgroupEnrollmentLineForProject(PHAROS)).toContain(
        path.join(tree.root, pharosCgroup, "cgroup.procs")
      );
      expect(agentCgroupEnrollmentLineForProject("/home/user/src/other")).toContain(
        path.join(tree.root, "xum", "xum-agents", "default", "cgroup.procs")
      );
      // A save in another window or backend arrives only through the config listener.
      await config.updateProjectAgentResourceLimits(PHAROS, { cpuCores: 7 });
      await waitForCondition(async () => (await projectCpuMax()) === "700000 100000");
    });

    it("applies no project limit while the switch is off, and keeps it saved", async () => {
      await addProject(PHAROS);
      service = new AgentResourceLimitsService(config, tree.host);
      await service.start();
      await service.setProject(PHAROS, { cpuCores: 14 });

      const state = await service.setEnabled(false);

      expect(state.projects).toEqual({ [PHAROS]: { limits: { cpuCores: 14 } } });
      // The project's cgroup held no command, so it is gone.
      expect(await projectCpuMax().catch((error: unknown) => String(error))).toContain("ENOENT");
      expect(agentCgroupEnrollmentLineForProject(PHAROS)).toBe("");
    });

    it("refuses a limit for a project that is not in the config", async () => {
      service = new AgentResourceLimitsService(config, tree.host);
      await service.start();

      let error: unknown;
      try {
        await service.setProject("/not/a/project", { cpuCores: 1 });
      } catch (caught) {
        error = caught;
      }

      expect(String(error)).toContain("Project not found: /not/a/project");
      expect((await service.get()).projects).toEqual({});
    });
  });
});
