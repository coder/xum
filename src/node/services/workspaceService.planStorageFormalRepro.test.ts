/**
 * Deterministic repros of the violations found by the TLA+ model in formal/plan-storage/
 * (run formal/plan-storage/check.sh). Each repro states the CORRECT contract and fails today at
 * its "Target assertion"; `expectReproFailure` passes only on that exact mismatch, so a repro
 * broken elsewhere (a fixture, a mock) fails instead of passing as a bare `test.failing` would.
 * Its passing control runs the same steps on the path the code already handles. When a fix lands
 * the repro fails with "repro passed", and the fix unwraps it into a plain test.
 *
 * Plans live at plans/<project basename>/<workspace name>.md: the projects below are a/project and
 * b/project, so local workspaces of both share plans/project/. Real Config, real git repositories
 * (an isolated GIT_CONFIG_GLOBAL), local runtime unless stated.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execFileSync } from "child_process";
import { constants as fsConstants, openSync, closeSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { getXumHome } from "@/common/constants/paths";
import { getPlanFilePath, sharesPlanStorage } from "@/common/utils/planStorage";
import type { RuntimeConfig } from "@/common/types/runtime";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import * as runtimeHelpers from "@/node/utils/runtime/helpers";
import { expectReproFailure } from "@/node/utils/formalRepro.testHarness";
import { FileChangeTracker } from "./utils/fileChangeTracker";
import type { WorkspaceService } from "./workspaceService";
import {
  createWorkspaceServiceHarness,
  withTempMuxRoot,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

describe("plan storage (formal/plan-storage)", () => {
  let harness: WorkspaceServiceHarness;
  let service: WorkspaceService;
  let projectA: string;
  let projectB: string;
  let gitHome: string;
  const savedGitEnv = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };

  beforeEach(async () => {
    gitHome = await fs.mkdtemp(path.join(os.tmpdir(), "plan-storage-formal-git-"));
    await fs.writeFile(path.join(gitHome, "gitconfig"), "");
    process.env.GIT_CONFIG_GLOBAL = path.join(gitHome, "gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    harness = await createWorkspaceServiceHarness();
    service = harness.service;
    // WorkspaceService derives projectName from the basename: both are "project".
    projectA = path.join(harness.rootDir, "a", "project");
    projectB = path.join(harness.rootDir, "b", "project");
    for (const projectPath of [projectA, projectB]) {
      await fs.mkdir(projectPath, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: projectPath, stdio: "pipe" });
      execFileSync(
        "git",
        [
          "-c",
          "user.email=t@example.com",
          "-c",
          "user.name=T",
          "commit",
          "--allow-empty",
          "-m",
          "i",
        ],
        { cwd: projectPath, stdio: "pipe" }
      );
    }
    await harness.config.editConfig((cfg) => {
      cfg.projects.set(projectA, { workspaces: [], trusted: true });
      cfg.projects.set(projectB, { workspaces: [], trusted: true });
      return cfg;
    });
    spyOn(runtimeFactory, "runBackgroundInit").mockResolvedValue(undefined);
  });

  afterEach(async () => {
    mock.restore();
    await harness.cleanup();
    for (const [key, value] of Object.entries(savedGitEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(gitHome, { recursive: true, force: true });
  });

  const addWorkspace = (
    projectPath: string,
    id: string,
    name: string,
    runtimeConfig: RuntimeConfig = { type: "local" }
  ) =>
    harness.config.editConfig((cfg) => {
      cfg.projects
        .get(projectPath)!
        .workspaces.push({ id, name, path: projectPath, runtimeConfig });
      return cfg;
    });
  const writePlan = async (root: string, name: string, content: string) => {
    const planPath = getPlanFilePath(name, "project", root);
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, content);
    return planPath;
  };
  const rowsNamed = (name: string) =>
    [...harness.config.loadConfigOrDefault().projects.values()]
      .flatMap((project) => project.workspaces)
      .filter((workspace) => workspace.name === name);
  const createLocal = (projectPath: string, branchName: string) =>
    service.create(projectPath, branchName, "main", undefined, { type: "local" });

  // MC_create_race (#5181): create() checks the plan-directory names before its awaits and its
  // registration write does not re-check them, so two creates of one name in same-basename
  // projects both register (a local runtime has no checkout directory to collide on).
  describe("create re-checks the plan-directory names when it registers (#5181)", () => {
    // Runs `during` once, when create() for `projectPath` reaches its checkout step: after the
    // name preflight, before the registration write.
    const atCheckoutOf = (projectPath: string, during: () => Promise<unknown>) => {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the original receiver
      const realCreate = LocalRuntime.prototype.createWorkspace;
      let fired = false;
      spyOn(LocalRuntime.prototype, "createWorkspace").mockImplementation(async function (
        this: LocalRuntime,
        params
      ) {
        if (!fired && params.projectPath === projectPath) {
          fired = true;
          await during();
        }
        return realCreate.call(this, params);
      });
    };

    test("a create of a name a same-basename project registered after the preflight does not register it too", async () => {
      await expectReproFailure(
        () =>
          withTempMuxRoot(async () => {
            let other: Awaited<ReturnType<WorkspaceService["create"]>> | undefined;
            atCheckoutOf(projectB, async () => {
              other = await createLocal(projectA, "twin");
            });

            await createLocal(projectB, "twin");

            expect(other?.success ? other.data.metadata.name : other?.error).toBe("twin");
            // Target assertion: one plans/project/twin.md, so at most one live row named "twin".
            expect(rowsNamed("twin").length).toBe(1);
          }),
        { matcher: "toBe", expected: "1", received: "2" }
      );
    });

    test("control: the same creates one after the other give the second a collision suffix", async () => {
      await withTempMuxRoot(async () => {
        const first = await createLocal(projectA, "twin");
        const second = await createLocal(projectB, "twin");

        expect(first.success ? first.data.metadata.name : first.error).toBe("twin");
        expect(second.success ? second.data.metadata.name : second.error).toMatch(/^twin-/);
        expect(rowsNamed("twin")).toHaveLength(1);
      });
    });
  });

  // MC_fork_race (#5175): fork() copies the plan before its registration write; the loser of two
  // forks to one name keeps its copy (copiedPlanPath := undefined), which overwrote the winner's
  // live plan.
  describe("a fork that loses the name leaves the winner's plan alone (#5175)", () => {
    test("a fork whose copy lands after a concurrent fork to the same name registered keeps the winner's plan", async () => {
      await expectReproFailure(
        () =>
          withTempMuxRoot(async (root) => {
            await addWorkspace(projectA, "aaaaaaaa01", "src-x");
            await addWorkspace(projectA, "aaaaaaaa02", "src-y");
            await writePlan(root, "src-x", "# X's plan\n");
            await writePlan(root, "src-y", "# Y's plan\n");
            const twinPlan = getPlanFilePath("twin", "project", root);
            const realCopy = runtimeHelpers.copyPlanFileAcrossRuntimes;
            let winner: Awaited<ReturnType<WorkspaceService["fork"]>> | undefined;
            let racing = false;
            spyOn(runtimeHelpers, "copyPlanFileAcrossRuntimes").mockImplementation(
              async (...args) => {
                if (!racing) {
                  racing = true;
                  // Between this fork's name check and its copy, a fork of src-x takes "twin" and its
                  // agent writes the plan.
                  winner = await service.fork("aaaaaaaa01", "twin");
                  await fs.writeFile(twinPlan, "# twin's live plan\n");
                }
                return realCopy(...args);
              }
            );

            const loser = await service.fork("aaaaaaaa02", "twin");

            expect(winner?.success ? winner.data.metadata.name : winner?.error).toBe("twin");
            expect(loser.success).toBe(false);
            expect(rowsNamed("twin")).toHaveLength(1);
            // Target assertion: the registered winner's live plan is intact.
            expect((await fs.readFile(twinPlan, "utf8")).trim()).toBe("# twin's live plan");
          }),
        { matcher: "toBe", expected: '"# twin\'s live plan"', received: '"# Y\'s plan"' }
      );
    });

    test("control: a fork to that name after the winner registered is refused before it copies", async () => {
      await withTempMuxRoot(async (root) => {
        await addWorkspace(projectA, "aaaaaaaa01", "src-x");
        await addWorkspace(projectA, "aaaaaaaa02", "src-y");
        await writePlan(root, "src-x", "# X's plan\n");
        await writePlan(root, "src-y", "# Y's plan\n");
        const twinPlan = getPlanFilePath("twin", "project", root);

        const winner = await service.fork("aaaaaaaa01", "twin");
        await fs.writeFile(twinPlan, "# twin's live plan\n");
        const loser = await service.fork("aaaaaaaa02", "twin");

        expect(winner.success ? winner.data.metadata.name : winner.error).toBe("twin");
        expect(loser.success).toBe(false);
        expect(await fs.readFile(twinPlan, "utf8")).toBe("# twin's live plan\n");
      });
    });
  });

  // MC_rename_race: rename() checks the new name before its awaits, its config write does not
  // re-check it, and movePlanFile's `mv` overwrites the target. A create that takes the name in
  // between keeps a row whose plan the rename then replaces.
  describe("a rename onto a name a concurrent create took leaves that workspace's plan alone", () => {
    test("a rename racing a same-basename create of its new name does not overwrite the created workspace's plan", async () => {
      await expectReproFailure(
        () =>
          withTempMuxRoot(async (root) => {
            await addWorkspace(projectA, "aaaaaaaa03", "old");
            await writePlan(root, "old", "# A's plan\n");
            const twinPlan = getPlanFilePath("twin", "project", root);
            // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the original receiver
            const realRename = LocalRuntime.prototype.renameWorkspace;
            let created: Awaited<ReturnType<WorkspaceService["create"]>> | undefined;
            spyOn(LocalRuntime.prototype, "renameWorkspace").mockImplementation(async function (
              this: LocalRuntime,
              ...args: Parameters<LocalRuntime["renameWorkspace"]>
            ) {
              if (created === undefined) {
                // After the rename's name check: project B takes "twin" and its agent writes a plan.
                created = await createLocal(projectB, "twin");
                await fs.writeFile(twinPlan, "# B's live plan\n");
              }
              return realRename.apply(this, args);
            });

            await service.rename("aaaaaaaa03", "twin");

            expect(created?.success ? created.data.metadata.name : created?.error).toBe("twin");
            // Target assertion: the created workspace's live plan is intact.
            expect((await fs.readFile(twinPlan, "utf8")).trim()).toBe("# B's live plan");
            // The rename must also not register: one plan path, so one live row named "twin". A
            // fix that only stops `mv` from overwriting fails here, not as "repro passed".
            expect(rowsNamed("twin").length).toBe(1);
          }),
        { matcher: "toBe", expected: '"# B\'s live plan"', received: '"# A\'s plan"' }
      );
    });

    test("control: a rename onto a name another project already uses is refused and moves nothing", async () => {
      await withTempMuxRoot(async (root) => {
        await addWorkspace(projectA, "aaaaaaaa03", "old");
        await writePlan(root, "old", "# A's plan\n");
        const created = await createLocal(projectB, "twin");
        const twinPlan = await writePlan(root, "twin", "# B's live plan\n");

        const renamed = await service.rename("aaaaaaaa03", "twin");

        expect(created.success ? created.data.metadata.name : created.error).toBe("twin");
        expect(renamed.success).toBe(false);
        expect(await fs.readFile(twinPlan, "utf8")).toBe("# B's live plan\n");
      });
    });
  });

  // MC_seeded_clear: once two live rows share one plan path (the races above, #5174, #5180), a
  // removal keeps the path (its sharing guard) but a full clear deletes it unguarded.
  describe("a full clear never deletes another live workspace's plan", () => {
    const seedSharedRows = async (root: string) => {
      await addWorkspace(projectA, "aaaaaaaa04", "twin");
      await addWorkspace(projectB, "bbbbbbbb04", "twin");
      return writePlan(root, "twin", "# A's live plan\n");
    };

    test("a full clear of one of two workspaces sharing a plan path keeps the other's plan", async () => {
      await expectReproFailure(
        () =>
          withTempMuxRoot(async (root) => {
            const twinPlan = await seedSharedRows(root);

            const cleared = await service.truncateHistory("bbbbbbbb04", 1.0);

            expect(cleared.success ? "" : cleared.error).toBe("");
            // Target assertion: A is live and the plan path is also A's.
            expect((await fs.readFile(twinPlan, "utf8").catch(() => "(deleted)")).trim()).toBe(
              "# A's live plan"
            );
          }),
        { matcher: "toBe", expected: '"# A\'s live plan"', received: '"(deleted)"' }
      );
    });

    test("control: removing that workspace keeps the other's plan", async () => {
      await withTempMuxRoot(async (root) => {
        const twinPlan = await seedSharedRows(root);

        const removed = await service.remove("bbbbbbbb04");

        expect(removed.success ? "" : removed.error).toBe("");
        expect(await fs.readFile(twinPlan, "utf8")).toBe("# A's live plan\n");
      });
    });
  });

  // MC_alias (#5180): sharesPlanStorage compares raw SSH host strings. With no ssh_config entry
  // for the host, `box` and `<current user>@box` are one endpoint and one remote home, so one
  // ~/.mux/plans directory, yet the guards treat them as separate storage.
  describe("sharesPlanStorage compares SSH endpoints, not host spellings (#5180)", () => {
    const ssh = (host: string): RuntimeConfig => ({ type: "ssh", host, srcBaseDir: "~/xum" });
    const user = os.userInfo().username;
    // Xum delegates to the system ssh, so an ssh_config rule (say `Host *` with `User deploy`)
    // can make the bare spelling another endpoint, and then the two do not share storage. Skip
    // the repro there rather than report #5180. Without ssh, OpenSSH defaults apply: one endpoint.
    const sshEndpoint = (host: string): string | undefined => {
      try {
        return execFileSync("ssh", ["-G", host], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        })
          .split("\n")
          .filter((line) => /^(user|hostname|port) /.test(line))
          .sort()
          .join("\n");
      } catch {
        return undefined;
      }
    };
    const bare = sshEndpoint("formal-box.invalid");
    const qualified = sshEndpoint(`${user}@formal-box.invalid`);
    const sshConfigSplitsSpellings =
      bare !== undefined && qualified !== undefined && bare !== qualified;

    test.skipIf(sshConfigSplitsSpellings)(
      "two spellings of one SSH endpoint share plan storage",
      async () => {
        await expectReproFailure(
          () =>
            // Target assertion.
            expect(
              sharesPlanStorage(ssh("formal-box.invalid"), ssh(`${user}@formal-box.invalid`))
            ).toBe(true),
          { matcher: "toBe", expected: "true", received: "false" }
        );
      }
    );

    test("control: one spelling shares plan storage", () => {
      expect(sharesPlanStorage(ssh("formal-box.invalid"), ssh("formal-box.invalid"))).toBe(true);
    });
  });

  // MC_two_installs (#5174): an SSH runtime keeps plans in ~/.mux on the host whatever the local
  // installation, and every guard reads only its own installation's config. Two installations with
  // a same-basename project on one host get distinct remote checkouts but one plan path, and a
  // clear in one deletes the other's live plan.
  describe("a full clear in one installation never deletes another installation's plan on a shared SSH host (#5174)", () => {
    const sshConfig: RuntimeConfig = {
      type: "ssh",
      host: "formal-box.invalid",
      srcBaseDir: "~/xum",
    };
    // The other installation's workspace: its project lives at another local path (another
    // machine); its own config, invisible here, holds a live row named "twin".
    const otherInstallProject = "/home/someone-else/checkouts/project";

    const clearRemovesPlanPaths = async () => {
      await addWorkspace(projectA, "aaaaaaaa05", "twin", sshConfig);
      const removed: string[] = [];
      spyOn(runtimeHelpers, "execBuffered").mockImplementation((_runtime, command, options) => {
        if (command.startsWith("rm -f")) {
          removed.push(...Object.values(options.pathEnv ?? {}));
          return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, duration: 0 });
        }
        return Promise.reject(new Error(`unexpected remote command in test: ${command}`));
      });
      const cleared = await service.truncateHistory("aaaaaaaa05", 1.0);
      expect(cleared.success ? "" : cleared.error).toBe("");
      return removed;
    };

    test("the clear's deletion misses the other installation's live plan", async () => {
      await expectReproFailure(
        () =>
          withTempMuxRoot(async () => {
            // The other installation has its own local root (another machine's home), so a fix
            // that scopes remote plan paths per installation gives it a path of its own. Its plan
            // path is resolved while its root is active; the clear runs under this harness's root.
            const other = await withTempMuxRoot(() => {
              const otherRuntime = runtimeFactory.createRuntime(sshConfig, {
                projectPath: otherInstallProject,
              });
              return Promise.resolve({
                localHome: getXumHome(),
                checkout: otherRuntime.getWorkspacePath(otherInstallProject, "twin"),
                planPath: getPlanFilePath("twin", "project", otherRuntime.getXumHome()),
              });
            });
            const ownRuntime = runtimeFactory.createRuntime(sshConfig, { projectPath: projectA });
            // Preconditions: the two installations have distinct local roots, and nothing else
            // collides (the two workspaces have separate remote checkouts).
            expect(other.localHome).not.toBe(getXumHome());
            expect(other.checkout).not.toBe(ownRuntime.getWorkspacePath(projectA, "twin"));

            const removed = await clearRemovesPlanPaths();

            expect(removed.length).toBeGreaterThan(0);
            // Target assertion.
            expect(removed.includes(other.planPath)).toBe(false);
          }),
        { matcher: "toBe", expected: "false", received: "true" }
      );
    });

    test("control: the clear deletes its own plan path on the host", async () => {
      await withTempMuxRoot(async () => {
        const ownRuntime = runtimeFactory.createRuntime(sshConfig, { projectPath: projectA });

        const removed = await clearRemovesPlanPaths();

        expect(removed).toContain(getPlanFilePath("twin", "project", ownRuntime.getXumHome()));
      });
    });
  });
});

// NoBlockedRead: sendMessage awaits FileChangeTracker.getChangedAttachments (agentSession), which
// stats each tracked path and readFile()s it when its mtime moved. A FIFO at a tracked path (the
// plan file, or any file the agent read) has no writer, so that read never returns.
// POSIX only: Windows has no mkfifo.
describe.skipIf(process.platform === "win32")(
  "send-path change detection never blocks on a non-regular file",
  () => {
    let dir: string;
    let fifoPath: string | undefined;

    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-storage-fifo-"));
      fifoPath = undefined;
    });

    afterEach(async () => {
      // Unblock a reader parked on the FIFO (a writer that opens and closes gives it EOF), so the
      // libuv thread it holds is released.
      if (fifoPath !== undefined) {
        try {
          closeSync(openSync(fifoPath, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK));
        } catch {
          // No reader is parked.
        }
      }
      await fs.rm(dir, { recursive: true, force: true });
    });

    const settlesWithin = async (promise: Promise<unknown>, ms: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ms);
      });
      try {
        return await Promise.race([promise.then(() => "settled" as const), timeout]);
      } finally {
        clearTimeout(timer);
      }
    };

    const trackedThenReplaced = async (replace: (p: string) => Promise<void>) => {
      const tracked = path.join(dir, "plan.md");
      await fs.writeFile(tracked, "# plan\n");
      const tracker = new FileChangeTracker();
      // Read at timestamp 0, so any later mtime counts as a change.
      await tracker.record(tracked, { content: "# plan\n", timestamp: 0 });
      await replace(tracked);
      return tracker;
    };

    test("a FIFO at a tracked path does not block getChangedAttachments", async () => {
      await expectReproFailure(
        async () => {
          const tracker = await trackedThenReplaced(async (tracked) => {
            await fs.rm(tracked);
            execFileSync("mkfifo", [tracked]);
            fifoPath = tracked;
          });

          // Target assertion.
          expect(await settlesWithin(tracker.getChangedAttachments(), 2000)).toBe("settled");
        },
        { matcher: "toBe", expected: '"settled"', received: '"timeout"' }
      );
    });

    test("control: a regular file at a tracked path is read and reported", async () => {
      const tracker = await trackedThenReplaced((tracked) => fs.writeFile(tracked, "# edited\n"));

      const detection = await tracker.getChangedAttachments();

      expect(detection.attachments).toHaveLength(1);
    });
  }
);
