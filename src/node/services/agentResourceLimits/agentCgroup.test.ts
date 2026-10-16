import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import { applyAgentCgroupLimits } from "./agentCgroup";
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

    it("a cgroup the user cannot manage", async () => {
      // Root ignores file modes, so the check cannot fail there.
      if (process.getuid?.() === 0) return;
      tree = await createFakeCgroupTree({ own: "/xum", cgroups: { xum: { controllers: "cpu" } } });
      await fs.chmod(path.join(tree.root, "xum", "cgroup.subtree_control"), 0o444);
      const result = await applyAgentCgroupLimits({ cpuCores: 2 }, tree.host);
      expect(result.status.state).toBe("unavailable");
      expect(result.status).toHaveProperty(
        "reason",
        expect.stringContaining("xum runs in cgroup /xum, which the user running xum cannot manage")
      );
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
