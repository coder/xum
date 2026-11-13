// Renames that put a workspace's registry entry back where it was, while a plugin sweep runs.
// A sweep that read override documents before it took its locks, and compared registry entries
// after them, saw no change and reported a stale enable clean: the directory it had read at the
// entry's path was not the workspace's checkout then. Every case here must keep consent: the
// sweep fails the workspace (its tombstone stays) or the workspace's document holds no key.
// The sweep reads documents only under the lock of every workspace it sweeps (docs/AGENTS.md,
// "Plugin override sweep: no unlocked pre-lock scan").
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "fs/promises";
import * as fsPromisesModule from "node:fs/promises";
import * as os from "os";
import * as path from "path";
import { AsyncLocalStorage } from "node:async_hooks";
import { Config } from "@/node/config";
import { WorkspaceMcpOverridesService } from "./workspaceMcpOverridesService";

const prefix = "plugin:0123456789abcdef:";
const staleKey = `${prefix}echo`;

describe("plugin sweep: a rename that puts a workspace back where it was", () => {
  let tempDir: string;
  let config: Config;
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-mcp-rename-races-"));
    config = new Config(tempDir);
  });
  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function registerWorkspace(name: string) {
    const projectPath = `/fake/${name}`;
    const workspaceId = `ws-${name}`;
    const workspacePath = path.join(config.srcDir, name, "branch");
    await fs.mkdir(workspacePath, { recursive: true });
    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: "branch",
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });
    return { workspaceId, workspacePath };
  }
  const docOf = (p: string) => path.join(p, ".xum", "mcp.local.jsonc");
  const writeDoc = async (p: string, enabledServers: string[]) => {
    await fs.mkdir(path.dirname(docOf(p)), { recursive: true });
    await fs.writeFile(docOf(p), JSON.stringify({ enabledServers }));
  };
  const holdsKey = async (p: string) =>
    (await fs.readFile(docOf(p), "utf-8").catch(() => "")).includes(prefix);
  /** The registry half of renameWorkspace (worktree path follows the entry name). */
  const renameEntry = (workspaceId: string, newPath: string) =>
    config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        for (const entry of project.workspaces) {
          if (entry.id === workspaceId) {
            entry.name = path.basename(newPath);
            entry.path = newPath;
          }
        }
      }
      return cfg;
    });
  /** renameWorkspace's steps under the workspace's lock: move the checkout, rewrite the entry. */
  const renameCheckout = async (
    service: WorkspaceMcpOverridesService,
    workspaceId: string,
    from: string,
    to: string
  ) => {
    const release = await service.acquireWorkspaceLock(workspaceId);
    try {
      await fs.rename(from, to);
      await renameEntry(workspaceId, to);
    } finally {
      await release();
    }
  };

  async function lockFilesOf(service: WorkspaceMcpOverridesService, workspaceId: string) {
    const locksDir = path.join(config.rootDir, "mcp-overrides-locks");
    const before = new Set(await fs.readdir(locksDir).catch(() => [] as string[]));
    const release = await service.acquireWorkspaceLock(workspaceId);
    try {
      return (await fs.readdir(locksDir))
        .filter((name) => name.endsWith(".lock") && !before.has(name))
        .map((name) => path.join(locksDir, name));
    } finally {
      await release();
    }
  }

  /**
   * Runs a sweep of `ids` and two writer phases at fixed points of the SWEEP's own progress.
   * Phase 1 runs at the sweep's first stat of `watched` (an unlocked scan's first read of the
   * checkout) or at the sweep's first link of one of `lockOwner`'s lock files (the sweep taking
   * that workspace's lock), whichever comes first. Bounded: if it has not finished in
   * 1500 ms (it waits for a lock the sweep holds), the sweep goes on and it finishes later.
   * Phase 2 runs right after the sweep's second stat of `watched` returned when phase 1 came
   * from a stat; when phase 1 came from the sweep's lock link, phase 2 starts at once after
   * phase 1 and waits for whatever lock the sweep holds. The phases' own fs calls are not triggers.
   */
  async function sweepWithPhases(
    service: WorkspaceMcpOverridesService,
    ids: string[],
    watched: string,
    lockOwner: string,
    phase1: () => Promise<void>,
    phase2: () => Promise<void>
  ) {
    const lockFiles = new Set(await lockFilesOf(service, lockOwner));
    const mine = new AsyncLocalStorage<boolean>();
    const timeline: string[] = [];
    const realStat = fsPromisesModule.stat;
    const realLink = fsPromisesModule.link;
    let statCount = 0;
    let trigger: "stat" | "link" | undefined;
    let phase1Done = false;
    let phase1Promise: Promise<void> | undefined;
    let phase2Promise: Promise<void> | undefined;
    const runPhase2 = () => {
      phase2Promise ??= mine
        .run(true, () => phase2())
        .then(() => {
          timeline.push("phase2-done");
        });
      return phase2Promise;
    };
    const runPhase1 = async (via: "stat" | "link") => {
      trigger = via;
      timeline.push(`trigger-${via}`);
      phase1Promise = mine
        .run(true, () => phase1())
        .then(() => {
          phase1Done = true;
          timeline.push("phase1-done");
          if (via === "link") void runPhase2();
        });
      await Promise.race([phase1Promise, new Promise((r) => setTimeout(r, 1500))]);
      if (!phase1Done) timeline.push("phase1-blocked");
    };
    const statSpy = spyOn(fsPromisesModule, "stat").mockImplementation((async (
      ...args: Parameters<typeof fsPromisesModule.stat>
    ) => {
      if (mine.getStore() === true || String(args[0]) !== watched) return realStat(...args);
      statCount++;
      if (trigger === undefined) {
        await runPhase1("stat");
        return realStat(...args);
      }
      const result = await realStat(...args);
      if (trigger === "stat" && statCount === 2 && phase1Done) {
        timeline.push("stat2");
        await runPhase2();
      }
      return result;
    }) as typeof fsPromisesModule.stat);
    const linkSpy = spyOn(fsPromisesModule, "link").mockImplementation((async (
      existing: Parameters<typeof fsPromisesModule.link>[0],
      target: Parameters<typeof fsPromisesModule.link>[1]
    ) => {
      if (mine.getStore() !== true && trigger === undefined && lockFiles.has(String(target))) {
        await runPhase1("link");
      }
      return realLink(existing, target);
    }) as typeof fsPromisesModule.link);
    let failures: Array<{ workspaceId: string; error: unknown }> = [];
    try {
      failures = await service.prunePluginOverrideKeysForWorkspaces(ids, prefix);
      timeline.push("sweep-returned");
    } finally {
      statSpy.mockRestore();
      linkSpy.mockRestore();
    }
    await phase1Promise;
    if (phase1Done) await runPhase2();
    return { failures, timeline };
  }

  it("a rename away and back while the sweep waits for the workspace's lock", async () => {
    // A rename moves A to B under the workspace's lock, a third actor makes a new directory at
    // A, and a second rename moves B back to A while the sweep takes its lock on A's key.
    const key = staleKey;
    const a = path.join(config.srcDir, "subject", "branch");
    const b = path.join(config.srcDir, "subject", "renamed");
    await fs.mkdir(path.dirname(docOf(a)), { recursive: true });
    await fs.writeFile(docOf(a), JSON.stringify({ enabledServers: [key, "other"] }));
    await config.editConfig((cfg) => {
      cfg.projects.set("/fake/subject", {
        workspaces: [
          {
            path: a,
            id: "ws-subject",
            name: "branch",
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
      });
      return cfg;
    });
    const service = new WorkspaceMcpOverridesService(config);
    const movePath = (checkout: string) =>
      config.editConfig((cfg) => {
        const entry = cfg.projects.get("/fake/subject")?.workspaces[0];
        if (entry === undefined) throw new Error("the subject workspace is not registered");
        entry.path = checkout;
        entry.name = path.basename(checkout);
        return cfg;
      });
    // The first rename holds the workspace's lock across the move and the entry rewrite.
    const releaseFirst = await service.acquireWorkspaceLock("ws-subject");
    await fs.rename(a, b);
    await fs.mkdir(a);
    let firstCommitted = false;
    let secondCommitted = false;
    const realLink = fsPromisesModule.link;
    const linkSpy = spyOn(fsPromisesModule, "link").mockImplementation(async (from, to) => {
      if (!String(to).includes(`${path.sep}mcp-overrides-locks${path.sep}`)) {
        return realLink(from, to);
      }
      // The sweep's first lock attempt: the first rename commits its entry and lets go.
      if (!firstCommitted) {
        firstCommitted = true;
        await movePath(b);
        await releaseFirst();
      }
      const result = await realLink(from, to);
      // The second rename takes the lock of B, which the sweep does not contend for.
      if (!secondCommitted) {
        secondCommitted = true;
        const releaseSecond = await service.acquireWorkspaceLock("ws-subject");
        try {
          await fs.rmdir(a);
          await fs.rename(b, a);
          await movePath(a);
        } finally {
          await releaseSecond();
        }
      }
      return result;
    });
    let failures: Array<{ workspaceId: string; error: unknown }>;
    try {
      failures = await service.prunePluginOverrideKeysForWorkspaces(["ws-subject"], prefix);
    } finally {
      linkSpy.mockRestore();
      if (!firstCommitted) await releaseFirst();
    }
    expect({ firstCommitted, secondCommitted }).toEqual({
      firstCommitted: true,
      secondCommitted: true,
    });
    const failed = failures.some((failure) => failure.workspaceId === "ws-subject");
    const stale = (await fs.readFile(docOf(a), "utf-8")).includes(prefix);
    // Either outcome keeps consent: the sweep fails the workspace (its tombstone stays), or
    // the document at A no longer holds the key.
    expect(failed || !stale).toBe(true);
  }, 20_000);

  it("a rename away and back, with another directory at the old path in between", async () => {
    const service = new WorkspaceMcpOverridesService(config);
    const w = await registerWorkspace("aba1-w");
    await writeDoc(w.workspacePath, [staleKey, "other"]);
    const a = w.workspacePath;
    const b = path.join(path.dirname(a), "renamed");
    const { failures } = await sweepWithPhases(
      service,
      [w.workspaceId],
      a,
      w.workspaceId,
      async () => {
        await renameCheckout(service, w.workspaceId, a, b);
        await fs.mkdir(a); // third actor: another directory takes the old path
      },
      async () => {
        await fs.rmdir(a); // third actor leaves
        await renameCheckout(service, w.workspaceId, b, a); // renamed back to its old name
      }
    );
    const failed = failures.map((f) => f.workspaceId);
    const keyAtA = await holdsKey(a);
    const keyAtB = await holdsKey(b);
    const violation = failed.length === 0 && (keyAtA || keyAtB);
    expect(violation).toBe(false);
  }, 20_000);

  async function registerInProject(project: string, name: string) {
    const projectPath = `/fake/${project}`;
    const workspaceId = `ws-${project}-${name}`;
    const workspacePath = path.join(config.srcDir, project, name);
    await fs.mkdir(workspacePath, { recursive: true });
    await config.editConfig((cfg) => {
      const entry = cfg.projects.get(projectPath) ?? { workspaces: [] };
      entry.workspaces.push({
        path: workspacePath,
        id: workspaceId,
        name,
        runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
      });
      cfg.projects.set(projectPath, entry);
      return cfg;
    });
    return { workspaceId, workspacePath };
  }

  it("two workspaces of one project swap names and swap back", async () => {
    const service = new WorkspaceMcpOverridesService(config);
    const w = await registerInProject("aba2", "w");
    const y = await registerInProject("aba2", "y");
    await writeDoc(w.workspacePath, [staleKey, "other"]);
    await writeDoc(y.workspacePath, ["clean"]);
    const a = w.workspacePath;
    const tmp = path.join(path.dirname(a), "tmp-name");
    const c = y.workspacePath;
    const { failures } = await sweepWithPhases(
      service,
      [w.workspaceId, y.workspaceId],
      a,
      w.workspaceId,
      async () => {
        await renameCheckout(service, w.workspaceId, a, tmp);
        await renameCheckout(service, y.workspaceId, c, a);
      },
      async () => {
        await renameCheckout(service, y.workspaceId, a, c);
        await renameCheckout(service, w.workspaceId, tmp, a);
      }
    );
    const failed = failures.map((f) => f.workspaceId);
    const keyAtA = await holdsKey(a);
    const violation = !failed.includes(w.workspaceId) && keyAtA;
    expect(violation).toBe(false);
  }, 20_000);

  it("a rename that rolls back over a directory another process made at the old path", async () => {
    // One lock hold: move, a third actor makes A, the entry rewrite fails, the rollback moves
    // B back onto the (empty) directory at A. The entry never changes.
    const service = new WorkspaceMcpOverridesService(config);
    const w = await registerWorkspace("aba3-w");
    await writeDoc(w.workspacePath, [staleKey, "other"]);
    const a = w.workspacePath;
    const b = path.join(path.dirname(a), "rolling");
    let release: (() => Promise<void>) | undefined;
    const { failures } = await sweepWithPhases(
      service,
      [w.workspaceId],
      a,
      w.workspaceId,
      async () => {
        release = await service.acquireWorkspaceLock(w.workspaceId);
        await fs.rename(a, b);
        await fs.mkdir(a); // third actor
      },
      async () => {
        // The rollback: rename(2) replaces an empty directory.
        await fs.rename(b, a);
        await release?.();
      }
    );
    const failed = failures.map((f) => f.workspaceId);
    const keyAtA = await holdsKey(a);
    const violation = failed.length === 0 && keyAtA;
    expect(violation).toBe(false);
  }, 20_000);

  it("a rename that rolls back over another directory while the sweep waits for its lock", async () => {
    const service = new WorkspaceMcpOverridesService(config);
    const w = await registerWorkspace("aba3b-w");
    const other = await registerWorkspace("aba3b-other");
    await writeDoc(w.workspacePath, [staleKey, "other"]);
    const a = w.workspacePath;
    const b = path.join(path.dirname(a), "rolling");
    let release: (() => Promise<void>) | undefined;
    let rollback: Promise<void> | undefined;
    const { failures } = await sweepWithPhases(
      service,
      [w.workspaceId, other.workspaceId],
      a,
      w.workspaceId,
      async () => {
        release = await service.acquireWorkspaceLock(w.workspaceId);
        await fs.rename(a, b);
        await fs.mkdir(a); // third actor
      },
      () => {
        // Not awaited here: the rollback lands 1 s later, while the sweep waits for the
        // workspace's lock.
        rollback = new Promise<void>((resolve) => setTimeout(resolve, 1000)).then(async () => {
          await fs.rename(b, a);
          await release?.();
        });
        return Promise.resolve();
      }
    );
    // Let the delayed rollback land if the sweep returned before it.
    await rollback;
    const failed = failures.map((f) => f.workspaceId);
    const keyAtA = await holdsKey(a);
    const violation = !failed.includes(w.workspaceId) && keyAtA;
    expect(violation).toBe(false);
  }, 20_000);

  it("a rename away and back, with a symlink to a clean directory at the old path in between", async () => {
    const service = new WorkspaceMcpOverridesService(config);
    const w = await registerWorkspace("aba4-w");
    await writeDoc(w.workspacePath, [staleKey, "other"]);
    const a = w.workspacePath;
    const b = path.join(path.dirname(a), "renamed");
    const clean = path.join(tempDir, "clean-dir");
    await fs.mkdir(clean, { recursive: true });
    const { failures } = await sweepWithPhases(
      service,
      [w.workspaceId],
      a,
      w.workspaceId,
      async () => {
        await renameCheckout(service, w.workspaceId, a, b);
        await fs.symlink(clean, a);
      },
      async () => {
        await fs.unlink(a);
        await renameCheckout(service, w.workspaceId, b, a);
      }
    );
    const failed = failures.map((f) => f.workspaceId);
    const keyAtA = await holdsKey(a);
    const violation = failed.length === 0 && keyAtA;
    expect(violation).toBe(false);
  }, 20_000);
});
