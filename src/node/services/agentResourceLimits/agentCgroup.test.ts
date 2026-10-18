import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import type { AgentResourceLimits } from "@/common/config/schemas/agentResourceLimits";
import type { AgentResourceLimitsSupport } from "@/common/orpc/schemas/agentResourceLimits";
import { applyAgentCgroupLimits, checkAgentCgroupSupport } from "./agentCgroup";
import { createFakeCgroupTree, type FakeCgroupTree } from "./testHelpers";

const MEMORY_1_1_GIB = String(Math.round(1.1 * 2 ** 30));

describe("applyAgentCgroupLimits", () => {
  let tree: FakeCgroupTree | undefined;
  afterEach(async () => {
    await tree?.dispose();
    tree = undefined;
  });

  it("limits xum-agents in whole kernel units and reports the cgroup agents join", async () => {
    tree = await createFakeCgroupTree({
      own: "/xum",
      cgroups: { xum: { controllers: "cpu io memory pids" } },
    });

    const result = await applyAgentCgroupLimits({ cpuCores: 0.29, memoryGiB: 1.1 }, tree.host);

    expect(result).toEqual({
      status: { state: "active", cgroup: "/xum/xum-agents" },
      enrollmentTarget: path.join(tree.root, "xum", "xum-agents", "cgroup.procs"),
    });
    expect(await tree.read("xum", "cgroup.subtree_control")).toBe("cpu memory\n");
    // 0.29 * 100000 and 1.1 GiB are not whole numbers in floating point.
    expect(await tree.read("xum/xum-agents", "cpu.max")).toBe("29000 100000");
    expect(await tree.read("xum/xum-agents", "memory.max")).toBe(MEMORY_1_1_GIB);
  });

  it("moves the processes of xum's cgroup into xum-app until the controllers can be enabled", async () => {
    tree = await createFakeCgroupTree({
      own: "/xum",
      cgroups: { xum: { controllers: "cpu memory", procs: ["101", "102"] } },
    });
    // A process forks in the cgroup after the first move, so the second attempt fails again.
    let forked = false;
    const fakeTree = tree;
    const host = {
      ...tree.host,
      writeFile: async (file: string, value: string) => {
        await fakeTree.host.writeFile(file, value);
        if (!forked && file.endsWith(path.join("xum-app", "cgroup.procs"))) {
          forked = true;
          await fakeTree.addProcess("xum", "103");
        }
      },
    };

    const result = await applyAgentCgroupLimits({ cpuCores: 2 }, host);

    expect(result.status).toEqual({ state: "active", cgroup: "/xum/xum-agents" });
    expect(await tree.read("xum", "cgroup.procs")).toBe("");
    expect(
      (await tree.read("xum/xum-app", "cgroup.procs")).split("\n").filter(Boolean).sort()
    ).toEqual(["101", "102", "103"]);
    expect(await tree.read("xum/xum-agents", "cpu.max")).toBe("200000 100000");
  });

  it("uses the parent cgroup once xum runs in xum-app", async () => {
    tree = await createFakeCgroupTree({
      own: "/xum/xum-app",
      cgroups: {
        xum: { controllers: "cpu memory", subtreeControl: "cpu memory" },
        "xum/xum-app": { procs: ["101"] },
        "xum/xum-agents": {},
      },
    });

    const result = await applyAgentCgroupLimits({ memoryGiB: 1.1 }, tree.host);

    expect(result.status).toEqual({ state: "active", cgroup: "/xum/xum-agents" });
    expect(tree.writes.map((write) => write.file)).toEqual([
      path.join("xum", "xum-agents", "cpu.max"),
      path.join("xum", "xum-agents", "memory.max"),
    ]);
    expect(await tree.read("xum/xum-agents", "cpu.max")).toBe("max 100000");
    expect(await tree.read("xum/xum-agents", "memory.max")).toBe(MEMORY_1_1_GIB);
  });

  it("enables only the controllers of the limits that are set", async () => {
    tree = await createFakeCgroupTree({
      own: "/xum",
      cgroups: { xum: { controllers: "cpu" } },
    });

    const result = await applyAgentCgroupLimits({ cpuCores: 1 }, tree.host);

    expect(result.status).toEqual({ state: "active", cgroup: "/xum/xum-agents" });
    expect(await tree.read("xum", "cgroup.subtree_control")).toBe("cpu\n");
  });

  it("removes both limits and stops enrolling when no limit is set", async () => {
    tree = await createFakeCgroupTree({
      own: "/xum/xum-app",
      cgroups: {
        xum: { controllers: "cpu memory", subtreeControl: "cpu memory" },
        "xum/xum-app": { procs: ["101"] },
        "xum/xum-agents": {},
      },
    });
    await applyAgentCgroupLimits({ cpuCores: 2, memoryGiB: 1.1 }, tree.host);

    const result = await applyAgentCgroupLimits({}, tree.host);

    expect(result).toEqual({ status: { state: "off" }, enrollmentTarget: null });
    expect(await tree.read("xum/xum-agents", "cpu.max")).toBe("max 100000");
    expect(await tree.read("xum/xum-agents", "memory.max")).toBe("max");
  });

  it("reports limits it could not remove, since they still bind the agents in xum-agents", async () => {
    let denied = false;
    tree = await createFakeCgroupTree({
      own: "/xum",
      cgroups: { xum: { controllers: "cpu" } },
      beforeWrite: (file) => {
        if (!denied || !file.endsWith("cpu.max")) return undefined;
        const error: NodeJS.ErrnoException = new Error("EACCES: permission denied");
        error.code = "EACCES";
        return error;
      },
    });
    await applyAgentCgroupLimits({ cpuCores: 2 }, tree.host);
    denied = true;

    const result = await applyAgentCgroupLimits({}, tree.host);

    expect(result).toEqual({
      status: {
        state: "unavailable",
        reason: "Could not remove the limits from the agent cgroup: EACCES: permission denied",
      },
      enrollmentTarget: null,
    });
    expect(await tree.read("xum/xum-agents", "cpu.max")).toBe("200000 100000");
  });

  it("touches nothing when no limit is set and xum never created xum-agents", async () => {
    tree = await createFakeCgroupTree({
      own: "/xum",
      cgroups: { xum: { controllers: "cpu memory", procs: ["101"] } },
    });

    expect(await applyAgentCgroupLimits({}, tree.host)).toEqual({
      status: { state: "off" },
      enrollmentTarget: null,
    });
    expect(tree.writes).toEqual([]);
  });

  describe("gives xum's top-level cgroup to its user with sudo when root owns it", () => {
    // Root ignores file modes, so xum's cgroup cannot be root's there.
    const isRoot = process.getuid?.() === 0;
    const pid = String(process.pid);
    const createUnmanageableTree = async (
      options: Partial<Parameters<typeof createFakeCgroupTree>[0]>
    ) => {
      const created = await createFakeCgroupTree({
        own: "/init.scope",
        // PID 1 and 2 stand for processes of other users, such as the workspace agent and dockerd.
        cgroups: { "init.scope": { controllers: "cpu memory", procs: ["1", "2", pid] } },
        ...options,
      });
      const base = Object.keys(options.cgroups ?? { "init.scope": {} })[0];
      await fs.chmod(path.join(created.root, base, "cgroup.subtree_control"), 0o444);
      return created;
    };

    it("on a host without systemd, and keeps xum and its agents inside that cgroup", async () => {
      if (isRoot) return;
      tree = await createUnmanageableTree({ sudoWorks: true });

      const result = await applyAgentCgroupLimits({ cpuCores: 1, memoryGiB: 1.1 }, tree.host, {
        trySudo: true,
      });

      expect(result).toEqual({
        status: { state: "active", cgroup: "/init.scope/xum-agents" },
        enrollmentTarget: path.join(tree.root, "init.scope", "xum-agents", "cgroup.procs"),
      });
      expect(tree.sudoCalls).toEqual(["init.scope"]);
      expect(
        (await tree.read("init.scope/xum-app", "cgroup.procs")).split("\n").filter(Boolean).sort()
      ).toEqual(["1", "2", pid].sort());
      expect(await tree.read("init.scope", "cgroup.procs")).toBe("");
      expect(await tree.read("init.scope/xum-agents", "cpu.max")).toBe("100000 100000");
      expect(await tree.read("init.scope/xum-agents", "memory.max")).toBe(MEMORY_1_1_GIB);

      // xum now runs in xum-app of a cgroup its user owns, so a later apply needs no sudo.
      const again = await applyAgentCgroupLimits({ cpuCores: 2 }, tree.host, { trySudo: true });
      expect(again.status).toEqual({ state: "active", cgroup: "/init.scope/xum-agents" });
      expect(tree.sudoCalls).toEqual(["init.scope"]);
    });

    it.each([
      ["not on a systemd host", { systemdBooted: true }],
      [
        "not for a nested cgroup, which the container manager outside owns",
        {
          own: "/docker/abc",
          cgroups: { "docker/abc": { controllers: "cpu memory", procs: [pid] } },
        },
      ],
      [
        "not for a cgroup whose xum-app another user set up",
        {
          own: "/init.scope/xum-app",
          cgroups: {
            "init.scope": { controllers: "cpu memory", subtreeControl: "cpu memory" },
            "init.scope/xum-app": { procs: [pid] },
          },
        },
      ],
    ])("%s", async (_name, options) => {
      if (isRoot) return;
      tree = await createUnmanageableTree({ sudoWorks: true, ...options });

      const result = await applyAgentCgroupLimits({ cpuCores: 1 }, tree.host, { trySudo: true });

      expect(result.status.state).toBe("unavailable");
      expect(result.status).toHaveProperty(
        "reason",
        expect.stringMatching(
          /cannot manage \(.*\)\. Start xum in a cgroup delegated to that user\.$/
        )
      );
      expect(tree.sudoCalls).toEqual([]);
    });

    it("not when the cgroup lacks a controller, which sudo would not add", async () => {
      if (isRoot) return;
      tree = await createUnmanageableTree({
        sudoWorks: true,
        cgroups: { "init.scope": { controllers: "memory", procs: [pid] } },
      });

      const result = await applyAgentCgroupLimits({ cpuCores: 1 }, tree.host, { trySudo: true });

      expect(result.status).toEqual({
        state: "unavailable",
        reason:
          "The cpu controller is not available in cgroup /init.scope. Enable it in the parent cgroup's cgroup.subtree_control.",
      });
      expect(tree.sudoCalls).toEqual([]);
    });
  });

  describe("checks what applying the limits takes, without changing anything", () => {
    const pid = String(process.pid);
    const initScope = { "init.scope": { controllers: "cpu memory", procs: [pid] } };
    type Setup = Parameters<typeof createFakeCgroupTree>[0] & { rootOwned?: boolean };

    it.each<[string, Setup, AgentResourceLimits, AgentResourceLimitsSupport]>([
      [
        "a cgroup the user can manage",
        { own: "/xum", cgroups: { xum: { controllers: "cpu memory" } } },
        {},
        { state: "ready", cgroup: "/xum" },
      ],
      [
        "a root-owned top-level cgroup on a host without systemd",
        { own: "/init.scope", cgroups: initScope, rootOwned: true },
        { cpuCores: 1 },
        { state: "sudo", cgroup: "/init.scope" },
      ],
      [
        "a root-owned cgroup on a systemd host",
        { own: "/init.scope", cgroups: initScope, rootOwned: true, systemdBooted: true },
        {},
        {
          state: "unavailable",
          reason: expect.stringMatching(
            /^xum runs in cgroup \/init\.scope, which the user running xum cannot manage/
          ) as string,
        },
      ],
      [
        "both controllers when no limit is set",
        { own: "/xum", cgroups: { xum: { controllers: "memory" } } },
        {},
        {
          state: "unavailable",
          reason:
            "The cpu controller is not available in cgroup /xum. Enable it in the parent cgroup's cgroup.subtree_control.",
        },
      ],
      [
        "only the controllers of the saved limits",
        { own: "/xum", cgroups: { xum: { controllers: "memory" } } },
        { memoryGiB: 2 },
        { state: "ready", cgroup: "/xum" },
      ],
      [
        "an OS without cgroups",
        { own: "/xum", cgroups: { xum: { controllers: "cpu memory" } }, platform: "win32" },
        {},
        { state: "unsupported", reason: "Agent resource limits need Linux with cgroup v2." },
      ],
    ])("%s", async (_name, setup, limits, support) => {
      // Root ignores file modes, so xum's cgroup cannot be root's there.
      if (setup.rootOwned === true && process.getuid?.() === 0) return;
      tree = await createFakeCgroupTree({ sudoWorks: true, ...setup });
      if (setup.rootOwned === true) {
        await fs.chmod(path.join(tree.root, setup.own, "cgroup.subtree_control"), 0o444);
      }

      expect(await checkAgentCgroupSupport(limits, tree.host)).toEqual(support);
      expect(tree.writes).toEqual([]);
      expect(tree.sudoCalls).toEqual([]);
    });

    it("without a cgroup v2 hierarchy", async () => {
      tree = await createFakeCgroupTree({ own: "/xum", cgroups: { xum: {} } });
      await fs.rm(path.join(tree.root, "cgroup.controllers"));

      expect(await checkAgentCgroupSupport({}, tree.host)).toEqual({
        state: "unsupported",
        reason: `No cgroup v2 hierarchy is mounted at ${tree.root}.`,
      });
    });
  });

  describe("reports why the limits cannot apply", () => {
    it.each([
      ["not Linux", "darwin" as const, "/xum", "Agent resource limits need Linux with cgroup v2."],
      [
        "the root cgroup",
        undefined,
        "/",
        "xum runs in the root cgroup. Start xum in a cgroup of its own.",
      ],
      [
        "another xum's agent cgroup",
        undefined,
        "/outer/xum-agents",
        "xum runs in cgroup /outer/xum-agents, the agent cgroup of another xum, whose limits already apply.",
      ],
    ])("%s", async (_name, platform, own, reason) => {
      tree = await createFakeCgroupTree({
        own,
        platform,
        cgroups: { xum: { controllers: "cpu memory" } },
      });
      expect(await applyAgentCgroupLimits({ cpuCores: 2 }, tree.host)).toEqual({
        status: { state: "unavailable", reason },
        enrollmentTarget: null,
      });
      expect(tree.writes).toEqual([]);
    });

    it("no cgroup v2 hierarchy", async () => {
      tree = await createFakeCgroupTree({ own: "/xum", cgroups: { xum: {} } });
      await fs.rm(path.join(tree.root, "cgroup.controllers"));
      const result = await applyAgentCgroupLimits({ cpuCores: 2 }, tree.host);
      expect(result.status).toEqual({
        state: "unavailable",
        reason: `No cgroup v2 hierarchy is mounted at ${tree.root}.`,
      });
    });

    it("a controller that the parent does not provide", async () => {
      tree = await createFakeCgroupTree({
        own: "/xum",
        cgroups: { xum: { controllers: "memory" } },
      });
      const result = await applyAgentCgroupLimits({ cpuCores: 2, memoryGiB: 1 }, tree.host);
      expect(result.status).toEqual({
        state: "unavailable",
        reason:
          "The cpu controller is not available in cgroup /xum. Enable it in the parent cgroup's cgroup.subtree_control.",
      });
      expect(tree.writes).toEqual([]);
    });

    it("a cgroup the user cannot manage, when sudo cannot give it to that user either", async () => {
      // Root ignores file modes, so the check cannot fail there.
      if (process.getuid?.() === 0) return;
      tree = await createFakeCgroupTree({ own: "/xum", cgroups: { xum: { controllers: "cpu" } } });
      await fs.chmod(path.join(tree.root, "xum", "cgroup.subtree_control"), 0o444);
      const cannotManage =
        /^xum runs in cgroup \/xum, which the user running xum cannot manage .*\. Start xum in a cgroup delegated to that user\.$/;
      const sudoFailed =
        /^xum runs in cgroup \/xum, which the user running xum cannot manage .*\. Start xum in a cgroup delegated to that user\. Delegating \/xum with sudo failed: sudo: a password is required$/;

      // An apply that may not run sudo, such as one after an unrelated config write.
      const before = await applyAgentCgroupLimits({ cpuCores: 2 }, tree.host);
      expect(before.status).toHaveProperty("reason", expect.stringMatching(cannotManage));
      expect(tree.sudoCalls).toEqual([]);

      const tried = await applyAgentCgroupLimits({ cpuCores: 2 }, tree.host, { trySudo: true });
      expect(tried.status).toHaveProperty("reason", expect.stringMatching(sudoFailed));
      expect(tree.sudoCalls).toEqual(["xum"]);

      // Later applies that may not run sudo keep reporting its error.
      const after = await applyAgentCgroupLimits({ cpuCores: 3 }, tree.host);
      expect(after.status).toHaveProperty("reason", expect.stringMatching(sudoFailed));
      expect(tree.sudoCalls).toEqual(["xum"]);
      expect(tree.writes).toEqual([]);
    });

    it("a test command that did not join xum-agents", async () => {
      tree = await createFakeCgroupTree({
        own: "/xum",
        cgroups: { xum: { controllers: "cpu" } },
        probe: () => "0::/xum/xum-app\n",
      });
      const result = await applyAgentCgroupLimits({ cpuCores: 2 }, tree.host);
      expect(result).toEqual({
        status: {
          state: "unavailable",
          reason: "A test command ran in cgroup /xum/xum-app, not /xum/xum-agents.",
        },
        enrollmentTarget: null,
      });
    });

    it("a kernel write that fails", async () => {
      tree = await createFakeCgroupTree({
        own: "/xum",
        cgroups: { xum: { controllers: "cpu" } },
        beforeWrite: (file) => {
          if (!file.endsWith("cpu.max")) return undefined;
          const error: NodeJS.ErrnoException = new Error("EINVAL: invalid argument");
          error.code = "EINVAL";
          return error;
        },
      });
      const result = await applyAgentCgroupLimits({ cpuCores: 2 }, tree.host);
      expect(result).toEqual({
        status: {
          state: "unavailable",
          reason: "Could not set up cgroup /xum/xum-agents: EINVAL: invalid argument",
        },
        enrollmentTarget: null,
      });
    });
  });
});
