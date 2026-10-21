import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { AgentCgroupHost } from "./agentCgroup";

interface FakeCgroup {
  controllers?: string;
  subtreeControl?: string;
  procs?: string[];
  /** The `cgroup.type`. Without it the file is missing, which the code reads as a domain. */
  type?: string;
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

/** Controllers that the kernel lets a cgroup enable while it holds processes (threaded ones). */
const THREADED_CONTROLLERS = new Set(["cpu", "cpuset", "perf_event", "pids"]);

/**
 * A cgroup v2 tree in a temp directory whose host writes follow the kernel rules the agent cgroup
 * code depends on (cgroup_vet_subtree_control_enable and cgroup_migrate_vet_dst):
 * - Enabling a domain controller such as memory fails with EBUSY while the cgroup holds processes.
 * - Enabling only threaded controllers such as cpu succeeds there, and the cgroup becomes a thread
 *   root: enabling a domain controller then fails with EOPNOTSUPP, and its children are
 *   "domain invalid", so moving a process into one fails with EOPNOTSUPP.
 * - Writing a PID to `cgroup.procs` moves that process out of every other cgroup.
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
    const controllersFile = path.join(dirOf(cgroup), "cgroup.controllers");
    await fs.writeFile(controllersFile, `${spec.controllers ?? ""}\n`);
    // Read-only, as the kernel's: it lists what the parent enables, not a setting of the cgroup.
    await fs.chmod(controllersFile, 0o444);
    await fs.writeFile(
      path.join(dirOf(cgroup), "cgroup.subtree_control"),
      `${spec.subtreeControl ?? ""}\n`
    );
    await fs.writeFile(
      path.join(dirOf(cgroup), "cgroup.procs"),
      (spec.procs ?? []).map((pid) => `${pid}\n`).join("")
    );
    if (spec.type !== undefined) {
      await fs.writeFile(path.join(dirOf(cgroup), "cgroup.type"), `${spec.type}\n`);
    }
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

  /** The cgroup whose `cgroup.procs` lists this process, as the kernel's /proc/self/cgroup. */
  const ownCgroup = async () => {
    for (const file of await allProcsFiles()) {
      if ((await readWords(file)).includes(String(process.pid))) {
        return `/${path.relative(root, path.dirname(file))}`;
      }
    }
    return options.own;
  };
  /** A cgroup that holds processes and enables a threaded controller for its children. */
  const isThreadRoot = async (dir: string) =>
    (await readWords(path.join(dir, "cgroup.procs"))).length > 0 &&
    (await readWords(path.join(dir, "cgroup.subtree_control"))).some((controller) =>
      THREADED_CONTROLLERS.has(controller)
    );
  const writes: FakeCgroupTree["writes"] = [];
  const sudoCalls: string[] = [];
  const host: AgentCgroupHost = {
    platform: options.platform ?? "linux",
    cgroupRoot: root,
    uid: 1000,
    readSelfCgroup: async () => `0::${await ownCgroup()}\n`,
    writeFile: async (file, value) => {
      const failure = options.beforeWrite?.(file, value);
      if (failure) {
        throw failure;
      }
      const name = path.basename(file);
      if (name === "cgroup.subtree_control") {
        const words = value.split(/\s+/).filter(Boolean);
        const enablesDomain = words.some(
          (word) => word.startsWith("+") && !THREADED_CONTROLLERS.has(word.slice(1))
        );
        const dir = path.dirname(file);
        if (enablesDomain && (await isThreadRoot(dir))) {
          throw errnoError("EOPNOTSUPP");
        }
        if (enablesDomain && (await readWords(path.join(dir, "cgroup.procs"))).length > 0) {
          throw errnoError("EBUSY");
        }
        const enabled = new Set(await readWords(file));
        for (const word of words) {
          if (word.startsWith("+")) enabled.add(word.slice(1));
          else if (word.startsWith("-")) enabled.delete(word.slice(1));
        }
        await fs.writeFile(file, `${[...enabled].join(" ")}\n`);
      } else if (name === "cgroup.procs") {
        if (await isThreadRoot(path.dirname(path.dirname(file)))) {
          throw errnoError("EOPNOTSUPP");
        }
        await movePid(file, value.trim());
      } else {
        await fs.writeFile(file, value);
      }
      writes.push({ file: path.relative(root, file), value });
    },
    probeEnrollment: async (procsFile) => {
      const custom = options.probe?.(procsFile);
      if (custom !== undefined) {
        return custom;
      }
      // The test shell starts in xum's cgroup and stays there when the kernel refuses the move.
      if (await isThreadRoot(path.dirname(path.dirname(procsFile)))) {
        return `0::${await ownCgroup()}\n`;
      }
      return `0::/${path.relative(root, path.dirname(procsFile))}\n`;
    },
    isSystemdBooted: () => Promise.resolve(options.systemdBooted ?? false),
    // What the sudo step does as root: give the cgroup to the user, which makes it writable.
    delegateWithSudo: async (cgroupDir) => {
      sudoCalls.push(path.relative(root, cgroupDir));
      if (options.sudoWorks !== true) {
        throw new Error("sudo: a password is required");
      }
      await fs.chmod(cgroupDir, 0o755);
      for (const name of ["cgroup.procs", "cgroup.subtree_control"]) {
        await fs.chmod(path.join(cgroupDir, name), 0o644);
      }
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
