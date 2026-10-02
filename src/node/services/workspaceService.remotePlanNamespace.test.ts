/**
 * SSH plans live in an installation-scoped tree on the host (#5174): two Xum installations on one
 * SSH host used to share ~/.mux/plans/<project basename>/<name>.md, and a clear in one deleted the
 * other's plan. Rows from older builds still read that shared legacy path, read-only, until their
 * fallback retires.
 *
 * A LocalRuntime stands in for the SSH host (its plan home is the temp root's ~/.xum), so plan
 * files, the remote `rm` and the legacy copy are real files and real shell commands.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createMuxMessage } from "@/common/types/message";
import type { RuntimeConfig } from "@/common/types/runtime";
import { getPlanFilePath } from "@/common/utils/planStorage";
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
const LEGACY_PLAN = "# Plan written by an older build\n";

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

  /** A row as an older build left it: no legacy-fallback flag. */
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
  /** The shared pre-#5174 path every installation on the host used for this workspace. */
  const writeLegacyPlan = () =>
    writeFile(getPlanFilePath("twin", "project", host.getXumHome()), LEGACY_PLAN);
  const scopedPlanPath = async () =>
    expandTilde(await resolvePlanFilePath(harness.config, host, owner()));
  const planContent = () =>
    getWorkspacePlanContent(
      { workspaceService: harness.service, config: harness.config } as unknown as ORPCContext,
      id
    );
  const seedHistory = async () => {
    const appended = await harness.historyService.appendToHistory(
      id,
      createMuxMessage("user-1", "user", "please plan", {})
    );
    expect(appended.success).toBe(true);
  };

  test("installations with the same local project path get distinct plan paths", async () => {
    const otherInstallation = new Config(path.join(harness.rootDir, "other-installation"));

    const own = await resolvePlanFilePath(harness.config, host, owner());
    const other = await resolvePlanFilePath(otherInstallation, host, owner());

    expect(own).not.toBe(other);
    expect(own).not.toBe(getPlanFilePath("twin", "project", host.getXumHome()));
  });

  test("an older row still reads its legacy plan: copied, never moved, and the fallback retires", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      const legacyPlan = await writeLegacyPlan();

      const read = await planContent();

      expect(read.success ? read.data.content : read.error).toBe(LEGACY_PLAN);
      expect(await readIfExists(await scopedPlanPath())).toBe(LEGACY_PLAN);
      expect(await readIfExists(legacyPlan)).toBe(LEGACY_PLAN);
      expect(harness.config.isRemotePlanLegacyFallbackRetired(id)).toBe(true);
    });
  });

  test("an adoption returns the plan it copied, even if the legacy file changed meanwhile", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      const legacyPlan = await writeLegacyPlan();
      const location = await resolvePlanFileLocation(harness.config, host, owner());
      const fallback = location.sharedLegacy!;
      // An older build edits the legacy file after the read's probe, before its copy.
      const racedLocation = {
        ...location,
        sharedLegacy: {
          ...fallback,
          exclusive: async <T>(fn: () => Promise<T>) => {
            await fs.writeFile(legacyPlan, "# Edited by an older build\n");
            return fallback.exclusive(fn);
          },
        },
      };

      const read = await runtimeHelpers.readPlanFile(host, racedLocation);

      expect(await readIfExists(await scopedPlanPath())).toBe(read.content);
      expect(read.content).toBe("# Edited by an older build\n");
    });
  });

  test("an adoption whose flag write fails still returns the plan it copied", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      const legacyPlan = await writeLegacyPlan();
      const location = await resolvePlanFileLocation(harness.config, host, owner());
      const fallback = location.sharedLegacy!;
      const racedLocation = {
        ...location,
        sharedLegacy: {
          ...fallback,
          exclusive: async <T>(fn: () => Promise<T>) => {
            await fs.writeFile(legacyPlan, "# Edited by an older build\n");
            return fallback.exclusive(fn);
          },
          retire: () => Promise.reject(new Error("config write failed")),
        },
      };

      const read = await runtimeHelpers.readPlanFile(host, racedLocation);

      expect(read.content).toBe("# Edited by an older build\n");
      expect(await readIfExists(await scopedPlanPath())).toBe(read.content);
    });
  });

  test("a non-regular file at the plan path keeps the legacy fallback open", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      await writeLegacyPlan();
      await fs.mkdir(await scopedPlanPath(), { recursive: true });

      const read = await planContent();

      expect(read.success ? read.data.content : read.error).toBe(LEGACY_PLAN);
      expect(harness.config.isRemotePlanLegacyFallbackRetired(id)).toBe(false);
    });
  });

  test("a removal waits out an adoption in flight, so the deleted plan is not copied back", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      await writeLegacyPlan();
      // A read (in any backend) holds the legacy-plan lock, has passed its flag check, and is
      // about to copy...
      let entered!: () => void;
      const copying = new Promise<void>((resolve) => (entered = resolve));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const adoptTarget = resolvePlanFilePath(harness.config, host, owner());
      const exec = runtimeHelpers.execBuffered;
      spyOn(runtimeHelpers, "execBuffered").mockImplementation(
        async (runtime, command, options) => {
          if (command.includes(".adopt.") && options.pathEnv?.XUM_PLAN === (await adoptTarget)) {
            entered();
            await gate;
          }
          return exec(runtime, command, options);
        }
      );
      // ...and resumes once the removal reaches its fence (or, without one, once it is done).
      const retire = runtimeHelpers.retireSharedLegacyPlan;
      spyOn(runtimeHelpers, "retireSharedLegacyPlan").mockImplementation((runtime, at) => {
        release();
        return retire(runtime, at);
      });
      const read = runtimeHelpers.readPlanFile(
        host,
        await resolvePlanFileLocation(harness.config, host, owner())
      );
      await copying;

      const removed = await harness.service.remove(id, true);
      release();
      await read;

      expect(removed.success ? "" : removed.error).toBe("");
      expect(await readIfExists(await scopedPlanPath())).toBeUndefined();
    });
  });

  test("a rename carries an older row's legacy plan to the new name and leaves the legacy file", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      const legacyPlan = await writeLegacyPlan();

      const renamed = await harness.service.rename(id, "renamed");

      expect(renamed.success ? "" : renamed.error).toBe("");
      const newScoped = expandTilde(
        await resolvePlanFilePath(harness.config, host, { ...owner(), name: "renamed" })
      );
      expect(await readIfExists(newScoped)).toBe(LEGACY_PLAN);
      expect(await readIfExists(legacyPlan)).toBe(LEGACY_PLAN);
      expect(harness.config.isRemotePlanLegacyFallbackRetired(id)).toBe(true);
    });
  });

  test("a rename whose legacy-plan copy fails is refused and keeps the fallback open", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      await writeLegacyPlan();
      // A file where the plan directory belongs: the copy's mkdir fails.
      const planDir = path.dirname(await scopedPlanPath());
      await writeFile(planDir, "not a directory\n");

      const renamed = await harness.service.rename(id, "renamed");

      expect(renamed.success).toBe(false);
      const row = harness.config
        .loadConfigOrDefault()
        .projects.get(projectPath)
        ?.workspaces.find((w) => w.id === id);
      expect(row?.name).toBe("twin");
      expect(harness.config.isRemotePlanLegacyFallbackRetired(id)).toBe(false);
      await fs.rm(planDir);
      const read = await planContent();
      expect(read.success ? read.data.content : read.error).toBe(LEGACY_PLAN);
    });
  });

  test("the Context tab's editable plan path is the adopted copy, never the shared legacy file", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      const legacyPlan = await writeLegacyPlan();

      const state = await harness.service.getPostCompactionState(id);

      expect(state.planPath).toBe(await scopedPlanPath());
      expect(await readIfExists(await scopedPlanPath())).toBe(LEGACY_PLAN);
      expect(await readIfExists(legacyPlan)).toBe(LEGACY_PLAN);
    });
  });

  test("post-compaction attachments never list the adopted legacy plan as an edited file", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      const legacyPlan = await writeLegacyPlan();
      const location = await resolvePlanFileLocation(harness.config, host, owner());
      const legacyPath = getPlanFilePath("twin", "project", host.getXumHome());

      const attachments = await AttachmentService.generatePostCompactionAttachments(
        location,
        [{ path: legacyPath, diff: "@@ -1 +1 @@", truncated: false }],
        [],
        host
      );

      expect(await readIfExists(legacyPlan)).toBe(LEGACY_PLAN);
      expect(attachments.map((attachment) => attachment.type)).toEqual(["plan_file_reference"]);
    });
  });

  test("a new row never reads the shared legacy path", async () => {
    await withTempMuxRoot(async () => {
      await harness.config.addWorkspace(projectPath, { ...owner(), createdAt: undefined });
      await writeLegacyPlan();

      const read = await planContent();

      expect(read.success).toBe(false);
      expect(await readIfExists(await scopedPlanPath())).toBeUndefined();
    });
  });

  test("a full clear keeps the legacy plan, and no read, snapshot or attachment brings it back", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      await seedHistory();
      const legacyPlan = await writeLegacyPlan();

      const cleared = await harness.service.truncateHistory(id, 1.0);

      expect(cleared.success ? "" : cleared.error).toBe("");
      // Another installation's workspace may own it: never deleted.
      expect(await readIfExists(legacyPlan)).toBe(LEGACY_PLAN);
      expect((await planContent()).success).toBe(false);
      const snapshot = await harness.service.planReviewEnsureSnapshot(id);
      expect(snapshot.success ? "created" : snapshot.error.type).toBe("plan_missing");
      const location = await resolvePlanFileLocation(harness.config, host, owner());
      expect(await AttachmentService.generatePlanFileReference(location, host)).toBeNull();
      expect(await readIfExists(await scopedPlanPath())).toBeUndefined();
    });
  });

  test("a read that saw the fallback open before a clear cannot copy the legacy plan back", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      await seedHistory();
      await writeLegacyPlan();
      // The read resolved its location and passed its first check while the fallback was open...
      const location = await resolvePlanFileLocation(harness.config, host, owner());
      const fallback = location.sharedLegacy!;
      let firstCheck = true;
      const staleLocation = {
        ...location,
        sharedLegacy: {
          ...fallback,
          isRetired: () => (firstCheck ? ((firstCheck = false), false) : fallback.isRetired()),
        },
      };
      // ...then the clear retired it and deleted the plan path, before the read's copy.
      const cleared = await harness.service.truncateHistory(id, 1.0);
      expect(cleared.success ? "" : cleared.error).toBe("");

      const read = await runtimeHelpers.readPlanFile(host, staleLocation);

      expect(read.exists).toBe(false);
      expect(await readIfExists(await scopedPlanPath())).toBeUndefined();
    });
  });

  test("a clear whose plan deletion fails has already retired the fallback for good", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      await seedHistory();
      const legacyPlan = await writeLegacyPlan();
      const execBuffered = spyOn(runtimeHelpers, "execBuffered").mockResolvedValue({
        stdout: "",
        stderr: "rm: cannot remove",
        exitCode: 1,
        duration: 0,
      });

      const cleared = await harness.service.truncateHistory(id, 1.0);
      execBuffered.mockRestore();

      expect(cleared.success).toBe(false);
      expect(harness.config.isRemotePlanLegacyFallbackRetired(id)).toBe(true);
      expect((await planContent()).success).toBe(false);
      expect(await readIfExists(legacyPlan)).toBe(LEGACY_PLAN);
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
      const legacyPlan = await writeLegacyPlan();
      const ownScoped = await writeFile(
        await resolvePlanFilePath(harness.config, host, owner()),
        "# Own plan\n"
      );

      const cleared = await harness.service.truncateHistory(id, 1.0);

      expect(cleared.success ? "" : cleared.error).toBe("");
      expect(await readIfExists(ownScoped)).toBeUndefined();
      expect(await readIfExists(otherScoped)).toBe("# The other installation's plan\n");
      expect(await readIfExists(legacyPlan)).toBe(LEGACY_PLAN);
    });
  });

  test("an unusable installation identity refuses the rename and keeps the fallback open", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      await writeLegacyPlan();
      const identityFile = path.join(harness.config.rootDir, INSTALLATION_ID_FILE);
      await fs.writeFile(identityFile, "corrupt\n");

      const renamed = await harness.service.rename(id, "renamed");

      expect(renamed.success ? "" : renamed.error).toContain(identityFile);
      const row = harness.config
        .loadConfigOrDefault()
        .projects.get(projectPath)
        ?.workspaces.find((w) => w.id === id);
      expect(row?.name).toBe("twin");
      expect(harness.config.isRemotePlanLegacyFallbackRetired(id)).toBe(false);
    });
  });

  test("an unusable installation identity refuses the clear and changes nothing", async () => {
    await withTempMuxRoot(async () => {
      await addOlderRow();
      await seedHistory();
      const legacyPlan = await writeLegacyPlan();
      const identityFile = path.join(harness.config.rootDir, INSTALLATION_ID_FILE);
      await fs.writeFile(identityFile, "corrupt\n");

      const cleared = await harness.service.truncateHistory(id, 1.0);

      expect(cleared.success ? "" : cleared.error).toContain(identityFile);
      expect(await fs.readFile(identityFile, "utf8")).toBe("corrupt\n");
      expect(harness.config.isRemotePlanLegacyFallbackRetired(id)).toBe(false);
      expect(await readIfExists(legacyPlan)).toBe(LEGACY_PLAN);
      const history = await harness.historyService.getLastMessages(id, 10);
      expect(history.success ? history.data.length : -1).toBe(1);
    });
  });
});
