import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  MAX_STAGED_ATTACHMENT_SIZE_BYTES,
  STAGED_ATTACHMENT_DIR,
  STAGED_ATTACHMENT_MIRROR_DIR_NAME,
} from "@/common/constants/stagedAttachments";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";

import {
  backfillStagedAttachmentMirror,
  copyStagedAttachmentMirrorEntries,
  copyStagedWorkspaceAttachments,
  extractStagedAttachmentPathsFromFile,
  extractStagedAttachmentPathsFromText,
  readStagedWorkspaceAttachment,
  rehydrateStagedWorkspaceAttachments,
  sanitizeStagedFilename,
  stageWorkspaceAttachment,
} from "./stageWorkspaceAttachment";

let tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("stageWorkspaceAttachment", () => {
  test("writes arbitrary files under the staged attachment directory and keeps git clean", async () => {
    const repo = await makeTempDir("mux-stage-attachment-");
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    const runtime = new LocalRuntime(repo);
    const cases = [
      { filename: "../../notes.md", mediaType: "text/markdown", bytes: Buffer.from("markdown") },
      { filename: "data.csv", mediaType: "text/csv", bytes: Buffer.from("a,b") },
      { filename: "payload.bin", mediaType: "", bytes: Buffer.from([0, 1, 2]) },
    ];

    for (const item of cases) {
      const result = await stageWorkspaceAttachment({
        runtime,
        workspacePath: repo,
        sessionDir: await makeTempDir("mux-stage-session-"),
        filename: item.filename,
        mediaType: item.mediaType,
        sizeBytes: item.bytes.byteLength,
        dataBase64: item.bytes.toString("base64"),
      });

      expect(result.success).toBe(true);
      if (!result.success) continue;
      expect(result.data.filename).toBe(path.basename(item.filename));
      expect(result.data.stagedPath).toStartWith(`${STAGED_ATTACHMENT_DIR}/`);
      expect(await readFile(path.join(repo, result.data.stagedPath))).toEqual(item.bytes);
    }

    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    expect(status).toBe("");
  });

  test("reads staged files for download and rejects paths outside staging", async () => {
    const repo = await makeTempDir("mux-stage-attachment-download-");
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    const runtime = new LocalRuntime(repo);
    const bytes = Buffer.from("markdown");

    const staged = await stageWorkspaceAttachment({
      runtime,
      workspacePath: repo,
      sessionDir: await makeTempDir("mux-stage-session-"),
      filename: "notes.md",
      mediaType: "text/markdown",
      sizeBytes: bytes.byteLength,
      dataBase64: bytes.toString("base64"),
    });
    expect(staged.success).toBe(true);
    if (!staged.success) return;

    for (const stagedPath of [
      "../README.md",
      "/.mux/user-attachments/id/notes.md",
      ".mux/user-attachments/../notes.md",
      ".mux/user-attachments/id//notes.md",
      ".mux/user-attachments/id/",
    ]) {
      const invalidDownload = await readStagedWorkspaceAttachment({
        runtime,
        workspacePath: repo,
        sessionDir: await makeTempDir("mux-stage-session-"),
        stagedPath,
      });
      expect(invalidDownload).toEqual({ success: false, error: "Invalid staged attachment path." });
    }

    const downloaded = await readStagedWorkspaceAttachment({
      runtime,
      workspacePath: repo,
      sessionDir: await makeTempDir("mux-stage-session-"),
      stagedPath: staged.data.stagedPath,
    });

    expect(downloaded).toEqual({
      success: true,
      data: {
        filename: "notes.md",
        mediaType: "text/markdown",
        sizeBytes: bytes.byteLength,
        dataBase64: bytes.toString("base64"),
      },
    });
  });

  test("sanitizes staged filenames while preserving extensions", () => {
    expect(sanitizeStagedFilename("../../notes.md")).toBe("notes.md");
    expect(sanitizeStagedFilename("..\\..\\bad\u0000name?.csv")).toBe("badname-.csv");
    expect(sanitizeStagedFilename("...env")).toBe("env");
    expect(sanitizeStagedFilename("...\u0000")).toBe("attachment");
    expect(sanitizeStagedFilename(`${"a".repeat(140)}.txt`)).toHaveLength(120);
    expect(sanitizeStagedFilename(`${"a".repeat(140)}.txt`)).toEndWith(".txt");
  });

  test("stages files in non-git workspaces", async () => {
    const dir = await makeTempDir("mux-stage-attachment-nongit-");
    const runtime = new LocalRuntime(dir);
    const bytes = Buffer.from("text");

    const result = await stageWorkspaceAttachment({
      runtime,
      workspacePath: dir,
      sessionDir: await makeTempDir("mux-stage-session-"),
      filename: "notes.txt",
      mediaType: "",
      sizeBytes: bytes.byteLength,
      dataBase64: bytes.toString("base64"),
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.mediaType).toBe("text/plain");
    expect(await readFile(path.join(dir, result.data.stagedPath), "utf8")).toBe("text");
  });

  test("lists and copies non-zip staged files", async () => {
    const sourceDir = await makeTempDir("mux-stage-attachment-list-source-");
    const targetDir = await makeTempDir("mux-stage-attachment-list-target-");
    const sourceRuntime = new LocalRuntime(sourceDir);
    const targetRuntime = new LocalRuntime(targetDir);
    const bytes = Buffer.from("notes");

    const staged = await stageWorkspaceAttachment({
      runtime: sourceRuntime,
      workspacePath: sourceDir,
      sessionDir: await makeTempDir("mux-stage-session-"),
      filename: "notes.md",
      mediaType: "text/markdown",
      sizeBytes: bytes.byteLength,
      dataBase64: bytes.toString("base64"),
    });
    expect(staged.success).toBe(true);
    if (!staged.success) return;

    const copied = await copyStagedWorkspaceAttachments({
      sourceRuntime,
      targetRuntime,
      sourceWorkspacePath: sourceDir,
      targetWorkspacePath: targetDir,
    });

    expect(copied).toEqual({ success: true, data: undefined });
    expect(await readFile(path.join(targetDir, staged.data.stagedPath))).toEqual(bytes);
  });

  test("copies selected staged attachments into a fork target and keeps git clean", async () => {
    const sourceRepo = await makeTempDir("mux-stage-attachment-copy-source-");
    const targetRepo = await makeTempDir("mux-stage-attachment-copy-target-");
    execFileSync("git", ["init", "-b", "main"], { cwd: sourceRepo, stdio: "ignore" });
    execFileSync("git", ["init", "-b", "main"], { cwd: targetRepo, stdio: "ignore" });
    const sourceRuntime = new LocalRuntime(sourceRepo);
    const targetRuntime = new LocalRuntime(targetRepo);
    const bytes = Buffer.from("forked zip bytes");

    const staged = await stageWorkspaceAttachment({
      runtime: sourceRuntime,
      workspacePath: sourceRepo,
      sessionDir: await makeTempDir("mux-stage-session-"),
      filename: "ARCHIVE.ZIP",
      mediaType: "application/zip",
      sizeBytes: bytes.byteLength,
      dataBase64: bytes.toString("base64"),
    });
    expect(staged.success).toBe(true);
    if (!staged.success) return;

    const futureStaged = await stageWorkspaceAttachment({
      runtime: sourceRuntime,
      workspacePath: sourceRepo,
      sessionDir: await makeTempDir("mux-stage-session-"),
      filename: "future.zip",
      mediaType: "application/zip",
      sizeBytes: bytes.byteLength,
      dataBase64: bytes.toString("base64"),
    });
    expect(futureStaged.success).toBe(true);
    if (!futureStaged.success) return;

    const copied = await copyStagedWorkspaceAttachments({
      sourceRuntime,
      targetRuntime,
      sourceWorkspacePath: sourceRepo,
      targetWorkspacePath: targetRepo,
      stagedPaths: [staged.data.stagedPath],
    });

    expect(copied).toEqual({ success: true, data: undefined });
    expect(await readFile(path.join(targetRepo, staged.data.stagedPath))).toEqual(bytes);
    let futureAttachmentExists = true;
    try {
      await readFile(path.join(targetRepo, futureStaged.data.stagedPath));
    } catch {
      futureAttachmentExists = false;
    }
    expect(futureAttachmentExists).toBe(false);
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: targetRepo,
      encoding: "utf8",
    });
    expect(status).toBe("");
  });

  test("skips stale referenced staged attachments during fork copy", async () => {
    const sourceRepo = await makeTempDir("mux-stage-attachment-stale-source-");
    const targetRepo = await makeTempDir("mux-stage-attachment-stale-target-");
    execFileSync("git", ["init", "-b", "main"], { cwd: sourceRepo, stdio: "ignore" });
    execFileSync("git", ["init", "-b", "main"], { cwd: targetRepo, stdio: "ignore" });
    const sourceRuntime = new LocalRuntime(sourceRepo);
    const targetRuntime = new LocalRuntime(targetRepo);
    const bytes = Buffer.from("still present");

    const staged = await stageWorkspaceAttachment({
      runtime: sourceRuntime,
      workspacePath: sourceRepo,
      sessionDir: await makeTempDir("mux-stage-session-"),
      filename: "present.zip",
      mediaType: "application/zip",
      sizeBytes: bytes.byteLength,
      dataBase64: bytes.toString("base64"),
    });
    expect(staged.success).toBe(true);
    if (!staged.success) return;

    const copied = await copyStagedWorkspaceAttachments({
      sourceRuntime,
      targetRuntime,
      sourceWorkspacePath: sourceRepo,
      targetWorkspacePath: targetRepo,
      stagedPaths: [staged.data.stagedPath, ".mux/user-attachments/missing/deleted.zip"],
    });

    expect(copied).toEqual({ success: true, data: undefined });
    expect(await readFile(path.join(targetRepo, staged.data.stagedPath))).toEqual(bytes);
  });

  test("extracts current and legacy staged attachment paths from persisted text", () => {
    const text =
      "before `.xum/user-attachments/one/notes.md` middle `.mux/user-attachments/two/data.csv` legacy `.mux/user-attachments/three/ARCHIVE.ZIP` after";

    expect(extractStagedAttachmentPathsFromText(text)).toEqual([
      ".xum/user-attachments/one/notes.md",
      ".mux/user-attachments/two/data.csv",
      ".mux/user-attachments/three/ARCHIVE.ZIP",
    ]);
  });

  test("extracts staged paths from a history file across read-chunk boundaries", async () => {
    const dir = await makeTempDir("mux-stage-history-scan-");
    const filePath = path.join(dir, "chat.jsonl");
    const straddling = `${STAGED_ATTACHMENT_DIR}/11111111-1111-4111-8111-111111111111/a.md`;
    const last = `${STAGED_ATTACHMENT_DIR}/22222222-2222-4222-8222-222222222222/b.md`;
    // Multi-byte padding puts the first path across the 1 MiB read boundary; the last path sits on
    // a final line without a trailing newline.
    const padding = "é".repeat(512 * 1024 - 8);
    await writeFile(filePath, `{"t":"${padding}\`${straddling}\`"}\n{"t":"\`${last}\`"}`);

    expect((await extractStagedAttachmentPathsFromFile(filePath)).sort()).toEqual(
      [straddling, last].sort()
    );
  });

  test("rejects invalid base64 before writing", async () => {
    const repo = await makeTempDir("mux-stage-attachment-bad-base64-");
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    const runtime = new LocalRuntime(repo);

    const result = await stageWorkspaceAttachment({
      runtime,
      workspacePath: repo,
      sessionDir: await makeTempDir("mux-stage-session-"),
      filename: "archive.zip",
      mediaType: "application/zip",
      sizeBytes: 0,
      dataBase64: "not base64!",
    });

    expect(result.success).toBe(false);
    expect(
      await Array.fromAsync(new Bun.Glob(`${STAGED_ATTACHMENT_DIR}/**`).scan({ cwd: repo }))
    ).toEqual([]);
  });

  test("rejects mismatched payload sizes before writing", async () => {
    const repo = await makeTempDir("mux-stage-attachment-invalid-");
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    const runtime = new LocalRuntime(repo);

    const result = await stageWorkspaceAttachment({
      runtime,
      workspacePath: repo,
      sessionDir: await makeTempDir("mux-stage-session-"),
      filename: "archive.txt",
      mediaType: "text/plain",
      sizeBytes: 4,
      dataBase64: Buffer.from("zip").toString("base64"),
    });

    expect(result.success).toBe(false);
    expect(
      await Array.fromAsync(new Bun.Glob(`${STAGED_ATTACHMENT_DIR}/**`).scan({ cwd: repo }))
    ).toEqual([]);
  });
});

// #3947: snapshot archives delete the checkout, and `.xum/user-attachments` is git-excluded,
// so the session-dir mirror is what lets staged uploads survive an archive/unarchive cycle.
describe("staged attachment session mirror", () => {
  async function stageInRepo(bytes: Buffer, filename = "notes.md") {
    const repo = await makeTempDir("mux-stage-mirror-repo-");
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    const sessionDir = await makeTempDir("mux-stage-mirror-session-");
    const runtime = new LocalRuntime(repo);
    const staged = await stageWorkspaceAttachment({
      runtime,
      workspacePath: repo,
      sessionDir,
      filename,
      mediaType: "text/markdown",
      sizeBytes: bytes.byteLength,
      dataBase64: bytes.toString("base64"),
    });
    if (!staged.success) throw new Error(staged.error);
    return { repo, sessionDir, runtime, stagedPath: staged.data.stagedPath };
  }

  function mirrorPathFor(sessionDir: string, stagedPath: string): string {
    const relative = stagedPath.slice(`${STAGED_ATTACHMENT_DIR}/`.length);
    return path.join(sessionDir, STAGED_ATTACHMENT_MIRROR_DIR_NAME, ...relative.split("/"));
  }

  test("staging writes the same bytes to the session mirror", async () => {
    const bytes = Buffer.from("mirror me");
    const { sessionDir, stagedPath } = await stageInRepo(bytes);

    expect(await readFile(mirrorPathFor(sessionDir, stagedPath))).toEqual(bytes);
  });

  test("download falls back to the mirror once the checkout copy is gone", async () => {
    const bytes = Buffer.from("survives archive");
    const { repo, sessionDir, runtime, stagedPath } = await stageInRepo(bytes);
    await rm(path.join(repo, STAGED_ATTACHMENT_DIR), { recursive: true, force: true });

    const downloaded = await readStagedWorkspaceAttachment({
      runtime,
      workspacePath: repo,
      sessionDir,
      stagedPath,
    });
    expect(downloaded.success && downloaded.data.dataBase64).toBe(bytes.toString("base64"));

    await rm(path.join(sessionDir, STAGED_ATTACHMENT_MIRROR_DIR_NAME), { recursive: true });
    const missing = await readStagedWorkspaceAttachment({
      runtime,
      workspacePath: repo,
      sessionDir,
      stagedPath,
    });
    expect(missing.success).toBe(false);
  });

  test("legacy checkout-only attachments still download without a mirror entry", async () => {
    const repo = await makeTempDir("mux-stage-mirror-legacy-");
    const sessionDir = await makeTempDir("mux-stage-mirror-legacy-session-");
    const legacyPath = ".mux/user-attachments/legacy-id/old.txt";
    await mkdir(path.join(repo, ".mux/user-attachments/legacy-id"), { recursive: true });
    await writeFile(path.join(repo, legacyPath), "legacy bytes");

    const downloaded = await readStagedWorkspaceAttachment({
      runtime: new LocalRuntime(repo),
      workspacePath: repo,
      sessionDir,
      stagedPath: legacyPath,
    });
    expect(downloaded.success && downloaded.data.dataBase64).toBe(
      Buffer.from("legacy bytes").toString("base64")
    );
  });

  test("rehydrates mirror entries into a recreated checkout", async () => {
    const bytes = Buffer.from("restored bytes");
    const { repo, sessionDir, runtime, stagedPath } = await stageInRepo(bytes);
    // Snapshot archive removes the whole checkout; restore recreates it from git only.
    await rm(path.join(repo, ".xum"), { recursive: true, force: true });

    const result = await rehydrateStagedWorkspaceAttachments({
      runtime,
      workspacePath: repo,
      sessionDir,
    });

    expect(result).toEqual({
      success: true,
      data: { restored: [stagedPath], skipped: [], failed: [] },
    });
    expect(await readFile(path.join(repo, stagedPath))).toEqual(bytes);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    expect(status).toBe("");
  });

  test("rehydration skips mirror entries staging could not have produced", async () => {
    const { repo, sessionDir, runtime, stagedPath } = await stageInRepo(Buffer.from("ok"));
    await rm(path.join(repo, ".xum"), { recursive: true, force: true });
    const mirrorRoot = path.join(sessionDir, STAGED_ATTACHMENT_MIRROR_DIR_NAME);
    const outside = await makeTempDir("mux-stage-mirror-outside-");
    await writeFile(path.join(outside, "secret.txt"), "secret");
    const id = "11111111-1111-4111-8111-111111111111";
    await mkdir(path.join(mirrorRoot, id, "nested"), { recursive: true });
    await symlink(path.join(outside, "secret.txt"), path.join(mirrorRoot, id, "secret.txt"));
    await writeFile(path.join(mirrorRoot, id, "bad$name.txt"), "x");
    await mkdir(path.join(mirrorRoot, "not-a-uuid"), { recursive: true });
    await writeFile(path.join(mirrorRoot, "not-a-uuid", "a.txt"), "x");
    await writeFile(path.join(mirrorRoot, "loose.txt"), "x");

    const result = await rehydrateStagedWorkspaceAttachments({
      runtime,
      workspacePath: repo,
      sessionDir,
    });

    expect(result.success && result.data.restored).toEqual([stagedPath]);
    expect(result.success && result.data.skipped.length).toBe(5);
    const restoredFiles = await Array.fromAsync(
      new Bun.Glob("**/*").scan({ cwd: path.join(repo, STAGED_ATTACHMENT_DIR), dot: true })
    );
    expect(restoredFiles).toEqual([stagedPath.slice(STAGED_ATTACHMENT_DIR.length + 1)]);
  });

  test("rehydration never overwrites existing files", async () => {
    const { repo, sessionDir, runtime, stagedPath } = await stageInRepo(Buffer.from("mirror"));
    await writeFile(path.join(repo, stagedPath), "edited in checkout");

    const result = await rehydrateStagedWorkspaceAttachments({
      runtime,
      workspacePath: repo,
      sessionDir,
    });

    expect(result.success && result.data.skipped).toEqual([stagedPath]);
    expect(await readFile(path.join(repo, stagedPath), "utf8")).toBe("edited in checkout");
  });

  test("rehydration refuses when the checkout staging root is a symlink", async () => {
    const { repo, sessionDir, runtime } = await stageInRepo(Buffer.from("mirror"));
    await rm(path.join(repo, ".xum"), { recursive: true, force: true });
    const outside = await makeTempDir("mux-stage-mirror-escape-");
    // A repo can track `.xum` as a symlink; writes through it would land outside the checkout.
    await symlink(outside, path.join(repo, ".xum"));

    const result = await rehydrateStagedWorkspaceAttachments({
      runtime,
      workspacePath: repo,
      sessionDir,
    });

    expect(result.success).toBe(false);
    expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: outside, dot: true }))).toEqual(
      []
    );
  });

  test.skipIf(process.getuid?.() === 0)(
    "rehydration reports write errors as failed so callers can retry",
    async () => {
      const { repo, sessionDir, runtime, stagedPath } = await stageInRepo(Buffer.from("ok"));
      const entryDir = path.dirname(path.join(repo, stagedPath));
      await rm(path.join(repo, stagedPath));
      await chmod(entryDir, 0o500);
      try {
        const result = await rehydrateStagedWorkspaceAttachments({
          runtime,
          workspacePath: repo,
          sessionDir,
        });
        expect(result).toEqual({
          success: true,
          data: { restored: [], skipped: [], failed: [stagedPath] },
        });
      } finally {
        await chmod(entryDir, 0o755);
      }
    }
  );

  test.skipIf(process.getuid?.() === 0)(
    "an unreadable mirror entry does not block its siblings",
    async () => {
      const { repo, sessionDir, runtime, stagedPath } = await stageInRepo(Buffer.from("ok"));
      await rm(path.join(repo, ".xum"), { recursive: true, force: true });
      const lockedDir = path.join(
        sessionDir,
        STAGED_ATTACHMENT_MIRROR_DIR_NAME,
        "33333333-3333-4333-8333-333333333333"
      );
      await mkdir(lockedDir);
      await writeFile(path.join(lockedDir, "locked.txt"), "x");
      await chmod(lockedDir, 0o000);
      try {
        const result = await rehydrateStagedWorkspaceAttachments({
          runtime,
          workspacePath: repo,
          sessionDir,
        });
        expect(result.success && result.data.restored).toEqual([stagedPath]);
        // An enumeration error may be transient, so callers must be able to retry it (#4905).
        expect(result.success && result.data.failed).toEqual([
          `${STAGED_ATTACHMENT_DIR}/33333333-3333-4333-8333-333333333333`,
        ]);
      } finally {
        await chmod(lockedDir, 0o755);
      }
    }
  );

  test("rehydration limited to retry paths leaves other mirror entries alone", async () => {
    const { repo, sessionDir, runtime, stagedPath } = await stageInRepo(Buffer.from("ok"));
    await rm(path.join(repo, ".xum"), { recursive: true, force: true });
    const retryId = "44444444-4444-4444-8444-444444444444";
    const retryDir = path.join(sessionDir, STAGED_ATTACHMENT_MIRROR_DIR_NAME, retryId);
    await mkdir(retryDir);
    await writeFile(path.join(retryDir, "retry.txt"), "retry");

    // A failed unreadable `<id>` dir is recorded as `<dir>/<id>`: it covers every file in it.
    const result = await rehydrateStagedWorkspaceAttachments({
      runtime,
      workspacePath: repo,
      sessionDir,
      onlyPaths: [`${STAGED_ATTACHMENT_DIR}/${retryId}`],
    });

    expect(result).toEqual({
      success: true,
      data: {
        restored: [`${STAGED_ATTACHMENT_DIR}/${retryId}/retry.txt`],
        skipped: [],
        failed: [],
      },
    });
    expect(await Bun.file(path.join(repo, stagedPath)).exists()).toBe(false);
  });

  test("staging keeps a newly created session dir private", async () => {
    const repo = await makeTempDir("mux-stage-mirror-private-");
    // Not created yet: the first chat write has not happened when the creation flow stages.
    const sessionDir = path.join(await makeTempDir("mux-stage-mirror-sessions-"), "ws");
    const bytes = Buffer.from("private");
    // A permissive umask would otherwise make plain mkdir create it group/world-readable.
    const previousUmask = process.umask(0o022);
    const staged = await stageWorkspaceAttachment({
      runtime: new LocalRuntime(repo),
      workspacePath: repo,
      sessionDir,
      filename: "a.txt",
      mediaType: "text/plain",
      sizeBytes: bytes.byteLength,
      dataBase64: bytes.toString("base64"),
    }).finally(() => process.umask(previousUmask));

    expect(staged.success).toBe(true);
    expect((await stat(sessionDir)).mode & 0o777).toBe(0o700);
  });

  test.skipIf(process.getuid?.() === 0)(
    "fork mirror copy skips unreadable entries instead of throwing",
    async () => {
      const { sessionDir, stagedPath } = await stageInRepo(Buffer.from("locked"));
      const targetSessionDir = await makeTempDir("mux-stage-mirror-fork-locked-");
      const entryDir = path.dirname(mirrorPathFor(sessionDir, stagedPath));
      await chmod(entryDir, 0o000);
      try {
        await copyStagedAttachmentMirrorEntries({
          sourceSessionDir: sessionDir,
          targetSessionDir,
          stagedPaths: [stagedPath],
        });
      } finally {
        await chmod(entryDir, 0o755);
      }
      expect(
        await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: targetSessionDir, dot: true }))
      ).toEqual([]);
    }
  );

  test("copies referenced mirror entries into a fork's session dir", async () => {
    const bytes = Buffer.from("fork me");
    const { sessionDir, stagedPath } = await stageInRepo(bytes);
    const targetSessionDir = await makeTempDir("mux-stage-mirror-fork-session-");

    await copyStagedAttachmentMirrorEntries({
      sourceSessionDir: sessionDir,
      targetSessionDir,
      stagedPaths: [
        stagedPath,
        `${STAGED_ATTACHMENT_DIR}/22222222-2222-4222-8222-222222222222/gone.txt`,
      ],
    });

    expect(await readFile(mirrorPathFor(targetSessionDir, stagedPath))).toEqual(bytes);
  });

  // #4845: uploads staged before the mirror existed have only a checkout copy.
  describe("backfill before a snapshot archive", () => {
    async function stageWithoutMirror(bytes: Buffer, filename = "notes.md") {
      const staged = await stageInRepo(bytes, filename);
      await rm(path.join(staged.sessionDir, STAGED_ATTACHMENT_MIRROR_DIR_NAME), {
        recursive: true,
      });
      return staged;
    }

    async function listMirror(sessionDir: string): Promise<string[]> {
      const mirrorRoot = path.join(sessionDir, STAGED_ATTACHMENT_MIRROR_DIR_NAME);
      const entries = await Array.fromAsync(
        new Bun.Glob("**/*").scan({ cwd: mirrorRoot, dot: true, throwErrorOnBrokenSymlink: false })
      ).catch(() => []);
      return entries.sort();
    }

    test("copies only referenced checkout uploads that have no mirror entry", async () => {
      const bytes = Buffer.from("staged before the mirror");
      const { repo, sessionDir, runtime, stagedPath } = await stageWithoutMirror(bytes);
      const unreferenced = await stageWorkspaceAttachment({
        runtime,
        workspacePath: repo,
        sessionDir,
        filename: "unreferenced.md",
        sizeBytes: 1,
        dataBase64: Buffer.from("u").toString("base64"),
      });
      const mirrored = await stageWorkspaceAttachment({
        runtime,
        workspacePath: repo,
        sessionDir,
        filename: "mirrored.md",
        sizeBytes: 1,
        dataBase64: Buffer.from("m").toString("base64"),
      });
      if (!unreferenced.success || !mirrored.success) throw new Error("staging failed");
      await rm(path.dirname(mirrorPathFor(sessionDir, unreferenced.data.stagedPath)), {
        recursive: true,
      });
      // An existing mirror entry wins over a checkout copy the workspace edited later.
      await writeFile(path.join(repo, mirrored.data.stagedPath), "edited in checkout");

      const result = await backfillStagedAttachmentMirror({
        workspacePath: repo,
        sessionDir,
        stagedPaths: [stagedPath, mirrored.data.stagedPath],
      });

      expect(result).toEqual({ copied: [stagedPath], skipped: [] });
      expect(await readFile(mirrorPathFor(sessionDir, stagedPath))).toEqual(bytes);
      expect(await readFile(mirrorPathFor(sessionDir, mirrored.data.stagedPath), "utf8")).toBe("m");
      expect(
        await readFile(mirrorPathFor(sessionDir, unreferenced.data.stagedPath)).catch(() => null)
      ).toBeNull();
    });

    test("repairs a symlinked mirror entry without touching directories or link targets", async () => {
      const bytes = Buffer.from("only valid copy");
      const { repo, sessionDir, runtime, stagedPath } = await stageWithoutMirror(bytes);
      async function stageMore(filename: string): Promise<string> {
        const staged = await stageWorkspaceAttachment({
          runtime,
          workspacePath: repo,
          sessionDir,
          filename,
          sizeBytes: 1,
          dataBase64: Buffer.from("x").toString("base64"),
        });
        if (!staged.success) throw new Error(staged.error);
        return staged.data.stagedPath;
      }
      const dirPath = await stageMore("dir.md");
      const ancestorPath = await stageMore("ancestor.md");
      const outside = await makeTempDir("mux-stage-backfill-corrupt-");
      await writeFile(path.join(outside, "other.txt"), "other");
      // Symlinked leaf: replaced from the checkout, the link target stays untouched.
      await mkdir(path.dirname(mirrorPathFor(sessionDir, stagedPath)), { recursive: true });
      await symlink(path.join(outside, "other.txt"), mirrorPathFor(sessionDir, stagedPath));
      // Directory in place of the entry: never deleted.
      const dirMirror = mirrorPathFor(sessionDir, dirPath);
      await rm(dirMirror);
      await mkdir(path.join(dirMirror, "keep"), { recursive: true });
      // Symlinked `<uuid>` mirror dir: nothing is written through it.
      const ancestorMirrorDir = path.dirname(mirrorPathFor(sessionDir, ancestorPath));
      await rm(ancestorMirrorDir, { recursive: true });
      await symlink(outside, ancestorMirrorDir);

      const result = await backfillStagedAttachmentMirror({
        workspacePath: repo,
        sessionDir,
        stagedPaths: [stagedPath, dirPath, ancestorPath],
      });

      expect(result).toEqual({ copied: [stagedPath], skipped: [dirPath, ancestorPath] });
      expect(await readFile(mirrorPathFor(sessionDir, stagedPath))).toEqual(bytes);
      expect((await stat(path.join(dirMirror, "keep"))).isDirectory()).toBe(true);
      expect(await Array.fromAsync(new Bun.Glob("*").scan({ cwd: outside, dot: true }))).toEqual([
        "other.txt",
      ]);
      expect(await readFile(path.join(outside, "other.txt"), "utf8")).toBe("other");
    });

    test("never copies symlinks, special files, oversized files, or non-canonical paths", async () => {
      const { repo, sessionDir } = await stageWithoutMirror(Buffer.from("ok"));
      const outside = await makeTempDir("mux-stage-backfill-outside-");
      await writeFile(path.join(outside, "secret.txt"), "secret");
      const stagingRoot = path.join(repo, STAGED_ATTACHMENT_DIR);
      const id = (n: number) =>
        `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

      // Symlinked leaf.
      await mkdir(path.join(stagingRoot, id(1)));
      await symlink(path.join(outside, "secret.txt"), path.join(stagingRoot, id(1), "secret.txt"));
      // Symlinked `<uuid>` segment.
      await symlink(outside, path.join(stagingRoot, id(2)));
      // Oversized regular file.
      await mkdir(path.join(stagingRoot, id(3)));
      await writeFile(
        path.join(stagingRoot, id(3), "big.bin"),
        Buffer.alloc(MAX_STAGED_ATTACHMENT_SIZE_BYTES + 1)
      );
      // A FIFO would block a plain open() forever.
      await mkdir(path.join(stagingRoot, id(4)));
      execFileSync("mkfifo", [path.join(stagingRoot, id(4), "pipe.txt")]);
      // Names and shapes staging never produces.
      await writeFile(path.join(stagingRoot, id(1), "bad$name.txt"), "x");
      await mkdir(path.join(stagingRoot, "not-a-uuid"));
      await writeFile(path.join(stagingRoot, "not-a-uuid", "a.txt"), "x");
      await mkdir(path.join(stagingRoot, id(5), "nested"), { recursive: true });
      await writeFile(path.join(stagingRoot, id(5), "nested", "a.txt"), "x");
      await mkdir(path.join(repo, ".mux/user-attachments", id(6)), { recursive: true });
      await writeFile(path.join(repo, ".mux/user-attachments", id(6), "a.txt"), "x");

      const stagedPaths = [
        `${STAGED_ATTACHMENT_DIR}/${id(1)}/secret.txt`,
        `${STAGED_ATTACHMENT_DIR}/${id(2)}/secret.txt`,
        `${STAGED_ATTACHMENT_DIR}/${id(3)}/big.bin`,
        `${STAGED_ATTACHMENT_DIR}/${id(4)}/pipe.txt`,
        `${STAGED_ATTACHMENT_DIR}/${id(1)}/bad$name.txt`,
        `${STAGED_ATTACHMENT_DIR}/not-a-uuid/a.txt`,
        `${STAGED_ATTACHMENT_DIR}/${id(5)}/nested/a.txt`,
        `.mux/user-attachments/${id(6)}/a.txt`,
        `${STAGED_ATTACHMENT_DIR}/${id(7)}/missing.txt`,
      ];
      const result = await backfillStagedAttachmentMirror({
        workspacePath: repo,
        sessionDir,
        stagedPaths,
      });

      expect(result).toEqual({ copied: [], skipped: stagedPaths });
      expect(await listMirror(sessionDir)).toEqual([]);
    });

    test("never reads through a symlinked staging root", async () => {
      const { repo, sessionDir, stagedPath } = await stageWithoutMirror(Buffer.from("ok"));
      const outside = await makeTempDir("mux-stage-backfill-root-");
      // A repo can track `.xum` as a symlink to a tree holding the same relative path.
      await rename(path.join(repo, ".xum"), path.join(outside, ".xum"));
      await symlink(path.join(outside, ".xum"), path.join(repo, ".xum"));

      const result = await backfillStagedAttachmentMirror({
        workspacePath: repo,
        sessionDir,
        stagedPaths: [stagedPath],
      });

      expect(result).toEqual({ copied: [], skipped: [stagedPath] });
      expect(await listMirror(sessionDir)).toEqual([]);
    });
  });
});
