/**
 * SSH plans live in an installation-scoped tree on the host (#5174): two Xum installations on one
 * SSH host used to share ~/.mux/plans/<project basename>/<name>.md, and a clear in one deleted the
 * other's plan. A row from an older build migrates once (planLocation.ts migrateRemotePlan): its
 * own plans/<id>.md plan is copied into the scoped path, legacy files stay untouched, and the row
 * flag then keeps every read on the scoped path (formal/plan-storage/PlanMigration.tla).
 *
 * A LocalRuntime stands in for the SSH host (its plan home is the temp root's ~/.xum), so plan
 * files, the remote `rm` and the migration script are real files and real shell commands.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createMuxMessage } from "@/common/types/message";
import type { RuntimeConfig } from "@/common/types/runtime";
import { getLegacyPlanFilePath, getPlanFilePath } from "@/common/utils/planStorage";
import { Config } from "@/node/config";
import { INSTALLATION_ID_FILE } from "@/node/config/installationIdentity";
import type { ORPCContext } from "@/node/orpc/context";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import { expandTilde } from "@/node/runtime/tildeExpansion";
import * as runtimeHelpers from "@/node/utils/runtime/helpers";
import { resolvePlanFileLocation, resolvePlanFilePath } from "@/node/utils/runtime/planLocation";
import { AttachmentService } from "./attachmentService";
import { getWorkspacePlanContent } from "./workspaceOperations";
import {
  createWorkspaceServiceHarness,
  withTempMuxRoot,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

const sshConfig: RuntimeConfig = { type: "ssh", host: "plans.invalid", srcBaseDir: "~/xum" };
const ID_PLAN = "# This workspace's plan, written by an older build\n";
const SHARED_PLAN = "# A plan at the shared pre-#5174 path, maybe another installation's\n";

describe("SSH plans are installation-scoped (#5174)", () => {
  let harness: WorkspaceServiceHarness;
  let projectPath: string;
  let host: LocalRuntime;
  const id = "aaaaaaaa51";
  const owner = () => ({
    id,
    name: "twin",
    projectName: "project",
    projectPath,
    runtimeConfig: sshConfig,
  });

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    projectPath = path.join(harness.rootDir, "a", "project");
    await fs.mkdir(projectPath, { recursive: true });
    host = new LocalRuntime(projectPath);
    spyOn(runtimeFactory, "createRuntime").mockReturnValue(host);
  });

  afterEach(async () => {
    mock.restore();
    await harness.cleanup();
  });

  /** A row as an older build left it: no migration flag. */
  const addOlderRow = () =>
    harness.config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        trusted: true,
        workspaces: [{ id, name: "twin", path: projectPath, runtimeConfig: sshConfig }],
      });
      return cfg;
    });
  const writeFile = async (tildePath: string, content: string) => {
    const filePath = expandTilde(tildePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
    return filePath;
  };
  const readIfExists = (filePath: string) =>
    fs.readFile(filePath, "utf8").catch(() => undefined as string | undefined);
  /** plans/<id>.md: provably this workspace's, from before plans moved to <project>/<name>.md. */
  const writeIdPlan = () => writeFile(getLegacyPlanFilePath(id, host.getXumHome()), ID_PLAN);
  /** The shared pre-#5174 path every installation on the host used for this workspace name. */
  const writeSharedPlan = (content = SHARED_PLAN) =>
    writeFile(getPlanFilePath("twin", "project", host.getXumHome()), content);
  const scopedPlanPath = async (config: Config = harness.config) =>
    expandTilde(await resolvePlanFilePath(config, host, owner()));
  const planContent = async () => {
    const read = await getWorkspacePlanContent(
      { workspaceService: harness.service, config: harness.config } as unknown as ORPCContext,
      id
    );
    return read.success ? read.data.content : undefined;
  };
  const resetIdentity = () => fs.rm(path.join(harness.config.rootDir, INSTALLATION_ID_FILE));
  const seedHistory = async () => {
    const appended = await harness.historyService.appendToHistory(
      id,
      createMuxMessage("user-1", "user", "please plan", {})
    );
    expect(appended.success).toBe(true);
  };
  const migrated = () => harness.config.isRemotePlanMigrated(id);
  const offer = async () => {
    const result = await harness.service.getImportableLegacyPlan(id);
    expect(result.success).toBe(true);
    return result.success ? result.data : undefined;
  };

  test("installations with the same local project path get distinct plan paths", async () => {
    const otherInstallation = new Config(path.join(harness.rootDir, "other-installation"));

    const own = await resolvePlanFilePath(harness.config, host, owner());
    const other = await resolvePlanFilePath(otherInstallation, host, owner());

    expect(own).not.toBe(other);
    expect(own).not.toBe(getPlanFilePath("twin", "project", host.getXumHome()));
  });

  test("the reported sequence: after migrating the id plan, an identity reset adopts nothing", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      const idPlan = await writeIdPlan();
      const sharedPlan = await writeSharedPlan();

      expect(await planContent()).toBe(ID_PLAN);
      expect(migrated()).toBe(true);
      await resetIdentity();

      // The new identity's namespace is empty, and stays the only place a read looks.
      expect(await planContent()).toBeUndefined();
      expect(await readIfExists(await scopedPlanPath())).toBeUndefined();
      expect(await readIfExists(idPlan)).toBe(ID_PLAN);
      expect(await readIfExists(sharedPlan)).toBe(SHARED_PLAN);
    });
  });

  test("the id plan wins over the shared path, and both legacy files stay as they were", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      const idPlan = await writeIdPlan();
      const sharedPlan = await writeSharedPlan();

      expect(await planContent()).toBe(ID_PLAN);

      expect(await readIfExists(await scopedPlanPath())).toBe(ID_PLAN);
      expect(await readIfExists(idPlan)).toBe(ID_PLAN);
      expect(await readIfExists(sharedPlan)).toBe(SHARED_PLAN);
      // No temp file left beside the plan.
      expect(await fs.readdir(path.dirname(await scopedPlanPath()))).toEqual(["twin.md"]);
    });
  });

  test("a row with no legacy plan migrates on its first read; a shared file written later stays out", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();

      expect(await planContent()).toBeUndefined();
      expect(migrated()).toBe(true);
      await writeSharedPlan();

      expect(await planContent()).toBeUndefined();
      expect(await readIfExists(await scopedPlanPath())).toBeUndefined();
    });
  });

  test("a row whose only legacy plan is the shared one imports nothing and stays unmigrated", async () => {
    await withTempMuxRoot(async () => {
      // Pending the import-policy decision (planLocation.ts TODO): no automatic import.
      await addOlderRow();
      const sharedPlan = await writeSharedPlan();

      expect(await planContent()).toBeUndefined();
      expect(migrated()).toBe(false);
      expect(await readIfExists(sharedPlan)).toBe(SHARED_PLAN);

      // The first plan written to the scoped path migrates the row; the shared file stays out.
      await writeFile(await scopedPlanPath(), "# New plan\n");
      expect(await planContent()).toBe("# New plan\n");
      expect(migrated()).toBe(true);
    });
  });

  test("a shared-only plan is offered for import, and the import copies it once", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      const sharedPlan = await writeSharedPlan();

      expect(await offer()).toBe(sharedPlan);
      expect(await planContent()).toBeUndefined();

      const imported = await harness.service.importLegacyPlan(id);
      expect(imported.success ? imported.data.status : imported.error).toBe("imported");
      expect(await planContent()).toBe(SHARED_PLAN);
      expect(migrated()).toBe(true);
      // The legacy file stays: another installation may own it.
      expect(await readIfExists(sharedPlan)).toBe(SHARED_PLAN);
      expect(await offer()).toBeNull();
      expect((await harness.service.getPostCompactionState(id)).planPath).toBe(
        await scopedPlanPath()
      );

      // A repeat (another click, another window) changes nothing.
      await writeSharedPlan("# Edited later at the shared path\n");
      const again = await harness.service.importLegacyPlan(id);
      expect(again.success ? again.data.status : again.error).toBe("already_present");
      expect(await planContent()).toBe(SHARED_PLAN);
    });
  });

  test("an import never replaces a plan already in this installation's path", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      await writeSharedPlan();
      await writeFile(await scopedPlanPath(), "# Written here first\n");

      const imported = await harness.service.importLegacyPlan(id);

      expect(imported.success ? imported.data.status : imported.error).toBe("already_present");
      expect(await planContent()).toBe("# Written here first\n");
    });
  });

  test("an import takes the workspace's own id plan over the shared path", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      await writeIdPlan();
      const sharedPlan = await writeSharedPlan();
      // Before any read: the import is the first migration.
      const imported = await harness.service.importLegacyPlan(id);

      expect(imported.success ? imported.data.status : imported.error).toBe("imported");
      expect(await planContent()).toBe(ID_PLAN);
      expect(await readIfExists(sharedPlan)).toBe(SHARED_PLAN);
    });
  });

  test("after a full clear there is nothing to import, and no plan comes back", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      await seedHistory();
      await writeSharedPlan();
      expect(await offer()).not.toBeNull();

      const cleared = await harness.service.truncateHistory(id, 1.0);
      expect(cleared.success ? "" : cleared.error).toBe("");
      const imported = await harness.service.importLegacyPlan(id);

      expect(imported.success ? imported.data.status : imported.error).toBe("nothing_to_import");
      expect(await planContent()).toBeUndefined();
      expect(await offer()).toBeNull();
    });
  });

  test("a new row is never offered an import, whatever sits at the shared path", async () => {
    await withTempMuxRoot(async () => {
      await harness.config.addWorkspace(projectPath, { ...owner(), createdAt: undefined });
      await writeSharedPlan();

      expect(await offer()).toBeNull();
      const imported = await harness.service.importLegacyPlan(id);
      expect(imported.success ? imported.data.status : imported.error).toBe("nothing_to_import");
      expect(await planContent()).toBeUndefined();
    });
  });

  test("a failed copy fails the read, keeps the row unmigrated, and the next read migrates", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      const idPlan = await writeIdPlan();
      // A file where the plan directory belongs: the migration's mkdir fails.
      const planDir = path.dirname(await scopedPlanPath());
      await writeFile(planDir, "not a directory\n");

      expect(await planContent()).toBeUndefined();
      expect(migrated()).toBe(false);
      expect(await readIfExists(idPlan)).toBe(ID_PLAN);

      await fs.rm(planDir);
      expect(await planContent()).toBe(ID_PLAN);
      expect(migrated()).toBe(true);
    });
  });

  test("a copy that landed before a failed flag write is kept, and the next read records it", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      await writeIdPlan();
      const markMigrated = spyOn(harness.config, "markRemotePlanMigrated").mockRejectedValueOnce(
        new Error("config write failed")
      );

      expect(await planContent()).toBe(ID_PLAN);
      expect(migrated()).toBe(false);
      // An older build edits its id plan meanwhile: the scoped copy already won.
      await fs.writeFile(expandTilde(getLegacyPlanFilePath(id, host.getXumHome())), "# Edited\n");
      markMigrated.mockRestore();

      expect(await planContent()).toBe(ID_PLAN);
      expect(migrated()).toBe(true);
    });
  });

  test("a non-regular file at the plan path fails the read and keeps the row unmigrated", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      await writeIdPlan();
      await fs.mkdir(await scopedPlanPath(), { recursive: true });

      expect(await planContent()).toBeUndefined();
      expect(migrated()).toBe(false);
    });
  });

  test("a full clear of an unmigrated row deletes no legacy file and nothing comes back", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      await seedHistory();
      const idPlan = await writeIdPlan();
      const sharedPlan = await writeSharedPlan();

      const cleared = await harness.service.truncateHistory(id, 1.0);

      expect(cleared.success ? "" : cleared.error).toBe("");
      expect(migrated()).toBe(true);
      expect(await readIfExists(idPlan)).toBe(ID_PLAN);
      expect(await readIfExists(sharedPlan)).toBe(SHARED_PLAN);
      expect(await planContent()).toBeUndefined();
      const snapshot = await harness.service.planReviewEnsureSnapshot(id);
      expect(snapshot.success ? "created" : snapshot.error.type).toBe("plan_missing");
      const location = await resolvePlanFileLocation(harness.config, host, owner());
      expect(await AttachmentService.generatePlanFileReference(location, host)).toBeNull();
      expect(await readIfExists(await scopedPlanPath())).toBeUndefined();
    });
  });

  test("a clear racing a migration in flight waits for it, then deletes the copy", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      await seedHistory();
      await writeIdPlan();
      // A read (in any backend) holds the migration lock and is about to copy...
      let entered!: () => void;
      const copying = new Promise<void>((resolve) => (entered = resolve));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const exec = runtimeHelpers.execBuffered;
      spyOn(runtimeHelpers, "execBuffered").mockImplementation(async (runtime, command, opts) => {
        if (opts.pathEnv?.XUM_ID_PLAN !== undefined) {
          entered();
          await gate;
        }
        return exec(runtime, command, opts);
      });
      const read = planContent();
      await copying;

      // ...the clear waits for the lock (the copy lands first), marks the row, deletes the copy.
      const cleared = harness.service.truncateHistory(id, 1.0);
      release();
      await read;

      const clearResult = await cleared;
      expect(clearResult.success ? "" : clearResult.error).toBe("");
      expect(migrated()).toBe(true);
      expect(await readIfExists(await scopedPlanPath())).toBeUndefined();
      expect(await planContent()).toBeUndefined();
    });
  });

  test("a clear whose plan deletion fails has already marked the row for good", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      await seedHistory();
      const idPlan = await writeIdPlan();
      const execBuffered = spyOn(runtimeHelpers, "execBuffered").mockResolvedValue({
        stdout: "",
        stderr: "rm: cannot remove",
        exitCode: 1,
        duration: 0,
      });

      const cleared = await harness.service.truncateHistory(id, 1.0);
      execBuffered.mockRestore();

      expect(cleared.success).toBe(false);
      expect(migrated()).toBe(true);
      expect(await planContent()).toBeUndefined();
      expect(await readIfExists(idPlan)).toBe(ID_PLAN);
    });
  });

  test("a removal deletes the scoped plan and leaves both legacy files", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      const idPlan = await writeIdPlan();
      const sharedPlan = await writeSharedPlan();
      const scoped = await scopedPlanPath();

      const removed = await harness.service.remove(id, true);

      expect(removed.success ? "" : removed.error).toBe("");
      expect(await readIfExists(scoped)).toBeUndefined();
      expect(await readIfExists(idPlan)).toBe(ID_PLAN);
      expect(await readIfExists(sharedPlan)).toBe(SHARED_PLAN);
    });
  });

  test("after a downgrade and upgrade, the older build's legacy edits stay out", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      await writeIdPlan();
      expect(await planContent()).toBe(ID_PLAN);
      // An older build ignores the flag and edits the legacy files.
      await writeSharedPlan("# Edited by an older build\n");
      await fs.writeFile(
        expandTilde(getLegacyPlanFilePath(id, host.getXumHome())),
        "# Edited by an older build\n"
      );

      expect(await planContent()).toBe(ID_PLAN);
    });
  });

  test("every plan consumer sees the migrated scoped plan, never a legacy path", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      await seedHistory();
      const idPlan = await writeIdPlan();
      const sharedPlanPath = getPlanFilePath("twin", "project", host.getXumHome());
      await writeSharedPlan();
      const scoped = await scopedPlanPath();

      // The Context tab's editable path (it may migrate the row itself).
      const state = await harness.service.getPostCompactionState(id);
      expect(state.planPath).toBe(scoped);
      // Post-compaction attachments: the plan reference, and no legacy file as an edited file.
      const location = await resolvePlanFileLocation(harness.config, host, owner());
      expect(location).toEqual({
        planPath: await resolvePlanFilePath(harness.config, host, owner()),
      });
      const attachments = await AttachmentService.generatePostCompactionAttachments(
        location,
        [{ path: location.planPath, diff: "@@ -1 +1 @@", truncated: false }],
        [],
        host
      );
      expect(attachments).toEqual([
        { type: "plan_file_reference", planFilePath: location.planPath, planContent: ID_PLAN },
      ]);
      // A plan-review snapshot.
      const snapshot = await harness.service.planReviewEnsureSnapshot(id);
      expect(snapshot.success).toBe(true);
      // A rename carries the scoped plan; the legacy files stay where they are.
      const renamed = await harness.service.rename(id, "renamed");
      expect(renamed.success ? "" : renamed.error).toBe("");
      const renamedScoped = expandTilde(
        await resolvePlanFilePath(harness.config, host, { ...owner(), name: "renamed" })
      );
      expect(await readIfExists(renamedScoped)).toBe(ID_PLAN);
      expect(await readIfExists(scoped)).toBeUndefined();
      expect(await readIfExists(idPlan)).toBe(ID_PLAN);
      expect(await readIfExists(expandTilde(sharedPlanPath))).toBe(SHARED_PLAN);
    });
  });

  test("a new row never reads a legacy path", async () => {
    await withTempMuxRoot(async () => {
      await harness.config.addWorkspace(projectPath, { ...owner(), createdAt: undefined });
      await writeIdPlan();
      await writeSharedPlan();

      expect(await planContent()).toBeUndefined();
      expect(await readIfExists(await scopedPlanPath())).toBeUndefined();
    });
  });

  test("a clear in one installation leaves another installation's plans on the host alone", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      await seedHistory();
      // The other installation: same local project path, same workspace name, own identity.
      const otherInstallation = new Config(path.join(harness.rootDir, "other-installation"));
      const otherScoped = await writeFile(
        await resolvePlanFilePath(otherInstallation, host, owner()),
        "# The other installation's plan\n"
      );
      const sharedPlan = await writeSharedPlan();
      const ownScoped = await writeFile(
        await resolvePlanFilePath(harness.config, host, owner()),
        "# Own plan\n"
      );

      const cleared = await harness.service.truncateHistory(id, 1.0);

      expect(cleared.success ? "" : cleared.error).toBe("");
      expect(await readIfExists(ownScoped)).toBeUndefined();
      expect(await readIfExists(otherScoped)).toBe("# The other installation's plan\n");
      expect(await readIfExists(sharedPlan)).toBe(SHARED_PLAN);
    });
  });

  test("an unusable installation identity refuses the rename and keeps the row unmigrated", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      await writeIdPlan();
      const identityFile = path.join(harness.config.rootDir, INSTALLATION_ID_FILE);
      await fs.writeFile(identityFile, "corrupt\n");

      const renamed = await harness.service.rename(id, "renamed");

      expect(renamed.success ? "" : renamed.error).toContain(identityFile);
      const row = harness.config
        .loadConfigOrDefault()
        .projects.get(projectPath)
        ?.workspaces.find((w) => w.id === id);
      expect(row?.name).toBe("twin");
      expect(migrated()).toBe(false);
    });
  });

  test("an unusable installation identity refuses the clear and changes nothing", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      await seedHistory();
      const idPlan = await writeIdPlan();
      const identityFile = path.join(harness.config.rootDir, INSTALLATION_ID_FILE);
      await fs.writeFile(identityFile, "corrupt\n");

      const cleared = await harness.service.truncateHistory(id, 1.0);

      expect(cleared.success ? "" : cleared.error).toContain(identityFile);
      expect(await fs.readFile(identityFile, "utf8")).toBe("corrupt\n");
      expect(migrated()).toBe(false);
      expect(await readIfExists(idPlan)).toBe(ID_PLAN);
      const history = await harness.historyService.getLastMessages(id, 10);
      expect(history.success ? history.data.length : -1).toBe(1);
    });
  });
});
