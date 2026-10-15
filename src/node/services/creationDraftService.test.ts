import cjsFs from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import { describe, expect, it, spyOn } from "bun:test";
import { Config } from "@/node/config";
import { TestTempDir } from "@/node/services/tools/testHelpers";
import type { CreationDraftScope, DraftAttachment } from "@/common/orpc/schemas/drafts";
import { MAX_DRAFT_JSON_BYTES } from "@/constants/drafts";
import {
  CreationDraftRejectedError,
  CreationDraftService,
  creationDraftImportId,
} from "./creationDraftService";

const PROJECT_A = "/projects/a";
const PROJECT_B = "/projects/b";
const scope = (draftId: string): CreationDraftScope => ({ kind: "creation", draftId });

const image: DraftAttachment = {
  kind: "provider",
  id: "img-1",
  url: "data:image/png;base64,iVBORw0KGgo=",
  mediaType: "image/png",
  filename: "shot.png",
};

async function createHarness(tempDir: TestTempDir) {
  const config = new Config(path.join(tempDir.path, "xum-home"));
  await config.editConfig((cfg) => {
    cfg.projects.set(PROJECT_A, { workspaces: [] });
    cfg.projects.set(PROJECT_B, { workspaces: [] });
    return cfg;
  });
  const oldRoot = path.join(config.rootDir, "drafts");
  // The record location is a downgrade contract: outside the old drafts root, whose GC an
  // older build runs.
  const recordFile = (id: string) => path.join(config.rootDir, "creation-drafts", `${id}.json`);
  return { config, oldRoot, recordFile };
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(
    () => true,
    () => false
  );
}

describe("CreationDraftService", () => {
  it("changes the project of the same record and keeps it on a stale text-only save", async () => {
    using tempDir = new TestTempDir("creation-drafts-move");
    const { config, recordFile } = await createHarness(tempDir);
    const service = new CreationDraftService(config);

    await service.update({
      scope: scope("d1"),
      projectPath: PROJECT_A,
      text: "fix it",
      attachments: [image],
      manualName: "my-name",
    });
    await service.update({
      scope: scope("d1"),
      projectPath: PROJECT_B,
      execution: { projectPath: PROJECT_B, agent: null, runtime: null, trunkBranch: null },
    });
    // An older window that still shows project A only sends text.
    await service.update({ scope: scope("d1"), text: "fix it now" });

    const reloaded = new CreationDraftService(config);
    const record = await reloaded.get("d1");
    expect(record).toMatchObject({
      projectPath: PROJECT_B,
      text: "fix it now",
      attachments: [image],
      manualName: "my-name",
    });
    const list = await reloaded.list();
    expect(list.drafts.map((draft) => [draft.draftId, draft.projectPath])).toEqual([
      ["d1", PROJECT_B],
    ]);
    expect(await exists(recordFile("d1"))).toBe(true);
  });

  it("keeps an emptied record and its row", async () => {
    using tempDir = new TestTempDir("creation-drafts-empty");
    const { config } = await createHarness(tempDir);
    const service = new CreationDraftService(config);

    await service.update({ scope: scope("d1"), projectPath: PROJECT_A, text: "hello" });
    await service.update({ scope: scope("d1"), text: "", attachments: [] });

    const list = await new CreationDraftService(config).list();
    expect(list.drafts.map((draft) => draft.draftId)).toEqual(["d1"]);
  });

  it("refuses execution choices made for another project, and unowned projects", async () => {
    using tempDir = new TestTempDir("creation-drafts-provenance");
    const { config, recordFile } = await createHarness(tempDir);
    const service = new CreationDraftService(config);
    await service.update({ scope: scope("d1"), projectPath: PROJECT_B, text: "keep" });
    const before = await fs.readFile(recordFile("d1"), "utf-8");

    const staleSsh = {
      projectPath: PROJECT_A,
      agent: null,
      runtime: { mode: "ssh" as const, host: "a-host" },
      trunkBranch: null,
    };
    const refusal = (input: Omit<Parameters<typeof service.update>[0], "scope">, id = "d1") =>
      service.update({ scope: scope(id), ...input }).catch((error: unknown) => error);
    expect(await refusal({ execution: staleSsh })).toBeInstanceOf(CreationDraftRejectedError);
    expect(await refusal({ projectPath: "/projects/unknown" })).toBeInstanceOf(
      CreationDraftRejectedError
    );
    expect(await fs.readFile(recordFile("d1"), "utf-8")).toBe(before);

    // A deleted draft: a late save without a project is refused, one with a project recreates it.
    await service.update({ scope: scope("gone"), projectPath: PROJECT_A, text: "sent" });
    await service.delete("gone");
    expect(await refusal({ text: "late" }, "gone")).toBeInstanceOf(CreationDraftRejectedError);
    expect(await exists(recordFile("gone"))).toBe(false);
    await service.update({ scope: scope("gone"), projectPath: PROJECT_A, text: "late" });
    expect(await exists(recordFile("gone"))).toBe(true);

    // The stored project must still be registered, even for a save that moves the draft away.
    await config.editConfig((cfg) => {
      cfg.projects.delete(PROJECT_B);
      return cfg;
    });
    expect(await refusal({ projectPath: PROJECT_A, text: "after removal" })).toBeInstanceOf(
      CreationDraftRejectedError
    );
    expect(await fs.readFile(recordFile("d1"), "utf-8")).toBe(before);
  });

  it("refuses a record over the size cap and keeps the last complete file", async () => {
    using tempDir = new TestTempDir("creation-drafts-size");
    const { config, recordFile } = await createHarness(tempDir);
    const service = new CreationDraftService(config);
    await service.update({ scope: scope("d1"), projectPath: PROJECT_A, text: "small" });
    const smallFileBytes = (await fs.stat(recordFile("d1"))).size;

    // One byte over the cap as written, file version included.
    const huge = "x".repeat(MAX_DRAFT_JSON_BYTES + 1 - smallFileBytes + "small".length);
    expect(
      await service.update({ scope: scope("d1"), text: huge }).catch((error: unknown) => error)
    ).toBeInstanceOf(Error);
    expect((await new CreationDraftService(config).get("d1"))?.text).toBe("small");
    expect(await exists(recordFile("d1"))).toBe(true);
  });

  it("deletes a removed project's records by their project field", async () => {
    using tempDir = new TestTempDir("creation-drafts-project-removal");
    const { config } = await createHarness(tempDir);
    const service = new CreationDraftService(config);
    await service.update({ scope: scope("a1"), projectPath: PROJECT_A, text: "a" });
    await service.update({ scope: scope("moved"), projectPath: PROJECT_A, text: "m" });
    await service.update({ scope: scope("moved"), projectPath: PROJECT_B });

    expect(await service.deleteProjectDrafts(PROJECT_A)).toEqual(["a1"]);
    const list = await new CreationDraftService(config).list();
    expect(list.drafts.map((draft) => draft.draftId)).toEqual(["moved"]);
  });
});

describe("CreationDraftService one-way import", () => {
  async function writeOld(
    oldRoot: string,
    entries: unknown[],
    bodies: Array<{ projectPath: string; draftId: string; text: string; nameState?: unknown }>
  ): Promise<string[]> {
    await fs.mkdir(oldRoot, { recursive: true });
    await fs.writeFile(path.join(oldRoot, "list.json"), JSON.stringify({ version: 1, entries }));
    const files: string[] = [];
    for (const body of bodies) {
      const dir = path.join(oldRoot, `hash-${body.projectPath.replace(/\W/g, "")}`);
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${body.draftId}.json`);
      await fs.writeFile(file, JSON.stringify({ version: 1, attachments: [], ...body }));
      files.push(file);
    }
    return files;
  }

  const UNOWNED_ROW = {
    projectPath: "/projects/removed",
    draftId: "kept",
    subProjectPath: null,
    createdAt: 7,
  };

  async function readOldList(oldRoot: string): Promise<unknown> {
    return (
      JSON.parse(await fs.readFile(path.join(oldRoot, "list.json"), "utf-8")) as {
        entries: unknown;
      }
    ).entries;
  }

  it("imports listed, default, body-only, empty and name-only drafts without id collisions", async () => {
    using tempDir = new TestTempDir("creation-drafts-import");
    const { config, oldRoot } = await createHarness(tempDir);
    const files = await writeOld(
      oldRoot,
      [
        { projectPath: PROJECT_A, draftId: "listed", subProjectPath: null, createdAt: 5 },
        { projectPath: PROJECT_A, draftId: "empty", subProjectPath: null, createdAt: 6 },
        UNOWNED_ROW,
      ],
      [
        { projectPath: PROJECT_A, draftId: "listed", text: "listed text" },
        { projectPath: PROJECT_A, draftId: "default", text: "default A" },
        { projectPath: PROJECT_B, draftId: "default", text: "default B" },
        {
          projectPath: PROJECT_B,
          draftId: "named",
          text: "",
          nameState: { autoGenerate: false, manualName: "typed-name" },
        },
      ]
    );

    const service = new CreationDraftService(config);
    const list = await service.list();
    const byOldScope = (projectPath: string, draftId: string) =>
      list.drafts.find((draft) => draft.draftId === creationDraftImportId(projectPath, draftId));
    expect(byOldScope(PROJECT_A, "listed")).toMatchObject({ preview: "listed text", createdAt: 5 });
    expect(byOldScope(PROJECT_A, "empty")).toMatchObject({ projectPath: PROJECT_A, preview: "" });
    expect(byOldScope(PROJECT_A, "default")?.preview).toBe("default A");
    expect(byOldScope(PROJECT_B, "default")?.preview).toBe("default B");
    expect(byOldScope(PROJECT_B, "named")?.manualName).toBe("typed-name");
    expect(list.drafts).toHaveLength(5);
    expect(list.importError).toBeNull();
    for (const file of files) expect(await exists(file)).toBe(false);
    // Only imported rows leave the old list (an unregistered project's row stays).
    expect(await readOldList(oldRoot)).toEqual([UNOWNED_ROW]);

    // Idempotent: a restart imports nothing twice.
    const restarted = await new CreationDraftService(config).list();
    expect(restarted.drafts).toHaveLength(5);
  });

  it("keeps an old draft's body and list row until its record is saved", async () => {
    using tempDir = new TestTempDir("creation-drafts-import-write-failure");
    const { config, oldRoot } = await createHarness(tempDir);
    const row = { projectPath: PROJECT_A, draftId: "listed", subProjectPath: null, createdAt: 5 };
    const [oldFile] = await writeOld(
      oldRoot,
      [row],
      [{ projectPath: PROJECT_A, draftId: "listed", text: "keep me" }]
    );
    // Every record write fails (at its atomic rename).
    const recordsDir = path.join(config.rootDir, "creation-drafts");
    const realRename = cjsFs.rename.bind(cjsFs);
    const renameSpy = spyOn(cjsFs, "rename").mockImplementation(((
      from: cjsFs.PathLike,
      to: cjsFs.PathLike,
      callback: cjsFs.NoParamCallback
    ) => {
      if (path.dirname(String(to)) === recordsDir) {
        callback(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));
        return;
      }
      realRename(from, to, callback);
    }) as typeof cjsFs.rename);
    let failed: Awaited<ReturnType<CreationDraftService["list"]>>;
    try {
      failed = await new CreationDraftService(config).list();
    } finally {
      renameSpy.mockRestore();
    }
    expect(failed.importError).not.toBeNull();
    expect(await exists(oldFile)).toBe(true);
    expect(await readOldList(oldRoot)).toEqual([row]);

    const service = new CreationDraftService(config);
    expect((await service.list()).importError).toBeNull();
    expect((await service.get(creationDraftImportId(PROJECT_A, "listed")))?.text).toBe("keep me");
  });

  it("keeps the old drafts and loads the records when the old dir cannot be read", async () => {
    using tempDir = new TestTempDir("creation-drafts-import-unreadable");
    const { config, oldRoot } = await createHarness(tempDir);
    await new CreationDraftService(config).update({
      scope: scope("new"),
      projectPath: PROJECT_A,
      text: "new",
    });
    const [oldFile] = await writeOld(
      oldRoot,
      [],
      [{ projectPath: PROJECT_A, draftId: "d", text: "old" }]
    );
    const realReaddir = fs.readdir.bind(fs);
    const readdirSpy = spyOn(fs, "readdir").mockImplementation((async (
      ...args: Parameters<typeof fs.readdir>
    ) => {
      if (path.resolve(String(args[0])) === path.resolve(oldRoot)) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return realReaddir(...args);
    }) as typeof fs.readdir);
    let list: Awaited<ReturnType<CreationDraftService["list"]>>;
    try {
      list = await new CreationDraftService(config).list();
    } finally {
      readdirSpy.mockRestore();
    }

    expect(list.drafts.map((draft) => draft.draftId)).toEqual(["new"]);
    expect(list.importError).not.toBeNull();
    expect(await exists(oldFile)).toBe(true);
  });

  it("keeps old content that differs from an existing record, with a visible error", async () => {
    using tempDir = new TestTempDir("creation-drafts-import-conflict");
    const { config, oldRoot } = await createHarness(tempDir);
    await writeOld(oldRoot, [], [{ projectPath: PROJECT_A, draftId: "d", text: "first" }]);
    await new CreationDraftService(config).list();
    const id = creationDraftImportId(PROJECT_A, "d");
    await new CreationDraftService(config).update({
      scope: scope(id),
      text: "edited after upgrade",
    });

    // Downgrade wrote the old body again with other text; then the user re-upgrades.
    const [oldFile] = await writeOld(
      oldRoot,
      [],
      [{ projectPath: PROJECT_A, draftId: "d", text: "edited after downgrade" }]
    );
    const service = new CreationDraftService(config);
    // The first load fails after its import ran; the retried load imports (and counts) again.
    const recordsDir = path.join(config.rootDir, "creation-drafts");
    const realReaddir = fs.readdir.bind(fs);
    const readdirSpy = spyOn(fs, "readdir").mockImplementation((async (
      ...args: Parameters<typeof fs.readdir>
    ) => {
      if (path.resolve(String(args[0])) === path.resolve(recordsDir)) {
        readdirSpy.mockRestore();
        throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      }
      return realReaddir(...args);
    }) as typeof fs.readdir);
    expect(await service.list().catch((error: unknown) => error)).toBeInstanceOf(Error);
    readdirSpy.mockRestore();
    const list = await service.list();
    expect((await service.get(id))?.text).toBe("edited after upgrade");
    expect(list.importError).not.toBeNull();
    expect(list.importError).toBe((await new CreationDraftService(config).list()).importError);
    expect(await exists(oldFile)).toBe(true);
  });
});
