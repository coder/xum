import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { AgentCgroupHost } from "./agentCgroup";

interface FakeCgroup {
  controllers?: string;
  subtreeControl?: string;
  procs?: string[];
}

export interface FakeCgroupTree {
  root: string;
  host: AgentCgroupHost;
  /** Every value written through the host, in order. */
  writes: Array<{ file: string; value: string }>;
  read: (cgroup: string, file: string) => Promise<string>;
  /** Put a process in a cgroup, as a fork in that cgroup would. */
  addProcess: (cgroup: string, pid: string) => Promise<void>;
  /** The cgroup directories that the host was asked to delegate with sudo, in order. */
  sudoCalls: string[];
  dispose: () => Promise<void>;
}

function errnoError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: simulated kernel error`);
  error.code = code;
  return error;
}

/**
 * A cgroup v2 tree in a temp directory whose host writes follow the kernel rules the agent cgroup
 * code depends on: enabling a controller fails with EBUSY while the cgroup holds processes, and
 * writing a PID to `cgroup.procs` moves that process out of every other cgroup.
 */
export async function createFakeCgroupTree(options: {
  own: string;
  cgroups: Record<string, FakeCgroup>;
  platform?: NodeJS.Platform;
  probe?: (procsFile: string) => string;
  /** Runs before each host write; a returned error is thrown instead of writing. */
  beforeWrite?: (file: string, value: string) => NodeJS.ErrnoException | undefined;
  /** Whether `sudo -n` works; by default it fails, as on a host without passwordless sudo. */
  sudoWorks?: boolean;
  systemdBooted?: boolean;
}): Promise<FakeCgroupTree> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xum-cgroup-"));
  const dirOf = (cgroup: string) => path.join(root, cgroup);
  await fs.writeFile(path.join(root, "cgroup.controllers"), "cpu io memory pids\n");
  const createCgroup = async (cgroup: string, spec: FakeCgroup) => {
    await fs.mkdir(dirOf(cgroup), { recursive: true });
    await fs.writeFile(
      path.join(dirOf(cgroup), "cgroup.controllers"),
      `${spec.controllers ?? ""}\n`
    );
    await fs.writeFile(
      path.join(dirOf(cgroup), "cgroup.subtree_control"),
      `${spec.subtreeControl ?? ""}\n`
    );
    await fs.writeFile(
      path.join(dirOf(cgroup), "cgroup.procs"),
      (spec.procs ?? []).map((pid) => `${pid}\n`).join("")
    );
  };
  for (const [cgroup, spec] of Object.entries(options.cgroups)) {
    await createCgroup(cgroup, spec);
  }

  const readWords = async (file: string) => {
    try {
      return (await fs.readFile(file, "utf-8")).split(/\s+/).filter(Boolean);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  };
  const allProcsFiles = async (): Promise<string[]> => {
    const entries = await fs.readdir(root, { recursive: true });
    return entries
      .filter((entry) => path.basename(entry) === "cgroup.procs")
      .map((entry) => path.join(root, entry));
  };
  const movePid = async (target: string, pid: string) => {
    for (const file of await allProcsFiles()) {
      const pids = await readWords(file);
      if (pids.includes(pid)) {
        await fs.writeFile(
          file,
          pids
            .filter((other) => other !== pid)
            .map((p) => `${p}\n`)
            .join("")
        );
      }
    }
    await fs.appendFile(target, `${pid}\n`);
  };

  let own = options.own;
  const writes: FakeCgroupTree["writes"] = [];
  const sudoCalls: string[] = [];
  const host: AgentCgroupHost = {
    platform: options.platform ?? "linux",
    cgroupRoot: root,
    uid: 1000,
    readSelfCgroup: () => Promise.resolve(`0::${own}\n`),
    writeFile: async (file, value) => {
      const failure = options.beforeWrite?.(file, value);
      if (failure) {
        throw failure;
      }
      const name = path.basename(file);
      if (name === "cgroup.subtree_control") {
        if ((await readWords(path.join(path.dirname(file), "cgroup.procs"))).length > 0) {
          throw errnoError("EBUSY");
        }
        const enabled = new Set(await readWords(file));
        for (const word of value.split(/\s+/).filter(Boolean)) {
          if (word.startsWith("+")) enabled.add(word.slice(1));
          else if (word.startsWith("-")) enabled.delete(word.slice(1));
        }
        await fs.writeFile(file, `${[...enabled].join(" ")}\n`);
      } else if (name === "cgroup.procs") {
        await movePid(file, value.trim());
      } else {
        await fs.writeFile(file, value);
      }
      writes.push({ file: path.relative(root, file), value });
    },
    probeEnrollment: (procsFile) =>
      Promise.resolve(
        options.probe?.(procsFile) ?? `0::/${path.relative(root, path.dirname(procsFile))}\n`
      ),
    isSystemdBooted: () => Promise.resolve(options.systemdBooted ?? false),
    // What the sudo script does as root: create the cgroup and its xum-app child unless they
    // exist (their files stay as they are), give them to the user, and move xum into xum-app.
    delegateWithSudo: async (cgroupDir) => {
      sudoCalls.push(path.relative(root, cgroupDir));
      if (options.sudoWorks !== true) {
        throw new Error("sudo: a password is required");
      }
      const cgroup = `/${path.relative(root, cgroupDir)}`;
      for (const [dir, spec] of [
        [cgroup, { controllers: "cpu memory" }],
        [`${cgroup}/xum-app`, {}],
      ] as const) {
        try {
          await fs.access(dirOf(dir));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
          await createCgroup(dir, spec);
        }
      }
      await movePid(path.join(dirOf(`${cgroup}/xum-app`), "cgroup.procs"), String(process.pid));
      own = `${cgroup}/xum-app`;
    },
  };

  return {
    root,
    host,
    writes,
    read: (cgroup, file) => fs.readFile(path.join(dirOf(cgroup), file), "utf-8"),
    addProcess: (cgroup, pid) =>
      fs.appendFile(path.join(dirOf(cgroup), "cgroup.procs"), `${pid}\n`),
    sudoCalls,
    dispose: () => fs.rm(root, { recursive: true, force: true }),
  };
}
