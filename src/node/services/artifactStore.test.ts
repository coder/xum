import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  MAX_ARTIFACT_LIST_DEPTH,
  MAX_ARTIFACT_LIST_ENTRIES,
  MAX_ARTIFACT_LIST_VISITS,
  listArtifactsInDir,
  parseArtifactRelativePath,
  readArtifactFromDir,
} from "./artifactStore";

describe("artifactStore", () => {
  let tempDir: string;
  let artifactsDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-store-"));
    artifactsDir = path.join(tempDir, "scratch", "artifacts");
    await fs.mkdir(artifactsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function write(relPath: string, content: string | Buffer, mtimeSec?: number) {
    const absPath = path.join(artifactsDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content);
    if (mtimeSec != null) await fs.utimes(absPath, mtimeSec, mtimeSec);
  }

  describe("listArtifactsInDir", () => {
    test("returns nothing when the folder does not exist yet", async () => {
      const result = await listArtifactsInDir(path.join(tempDir, "missing"));
      expect(result).toEqual({ entries: [], truncated: false });
    });

    test("lists nested files newest first with kinds, skipping hidden entries and symlinks", async () => {
      await write("old.md", "# old", 1_000);
      await write("data/new.json", "{}", 3_000);
      await write("pic.PNG", "png", 2_000);
      await write(".hidden.md", "x", 4_000);
      await write(".git/config", "x", 4_000);
      const outside = path.join(tempDir, "secret.txt");
      await fs.writeFile(outside, "secret");
      await fs.symlink(outside, path.join(artifactsDir, "link.txt"));
      await fs.symlink(tempDir, path.join(artifactsDir, "linked-dir"));

      const { entries, truncated } = await listArtifactsInDir(artifactsDir);

      expect(truncated).toBe(false);
      expect(entries.map((e) => [e.path, e.kind])).toEqual([
        ["data/new.json", "json"],
        ["pic.PNG", "image"],
        ["old.md", "markdown"],
      ]);
      expect(entries[0]?.size).toBe(2);
    });

    test("stops descending past the depth limit and reports truncation", async () => {
      const deep = Array.from({ length: MAX_ARTIFACT_LIST_DEPTH + 1 }, (_, i) => `d${i}`).join("/");
      await write(`${deep}/too-deep.md`, "x");
      await write("top.md", "x");

      const { entries, truncated } = await listArtifactsInDir(artifactsDir);

      expect(entries.map((e) => e.path)).toEqual(["top.md"]);
      expect(truncated).toBe(true);
    });

    test("keeps the newest files when over the entry cap, not the alphabetically first", async () => {
      for (let i = 0; i < MAX_ARTIFACT_LIST_ENTRIES; i++) {
        await write(`a-${String(i).padStart(4, "0")}.txt`, "x", 1_000);
      }
      await write("z-newest.txt", "x", 5_000);

      const { entries, truncated } = await listArtifactsInDir(artifactsDir);

      expect(entries).toHaveLength(MAX_ARTIFACT_LIST_ENTRIES);
      expect(entries[0]?.path).toBe("z-newest.txt");
      expect(truncated).toBe(true);
    });

    test("stops the walk after the visit budget, even through empty folders", async () => {
      // Only a visit budget stops reading thousands of empty folders.
      await Promise.all(
        Array.from({ length: MAX_ARTIFACT_LIST_VISITS + 10 }, (_, i) =>
          fs.mkdir(path.join(artifactsDir, `d${String(i).padStart(5, "0")}`))
        )
      );

      const { entries, truncated } = await listArtifactsInDir(artifactsDir);

      expect(entries).toEqual([]);
      expect(truncated).toBe(true);
    });

    test("streams a folder and stops reading it at the visit budget", async () => {
      // A folder far larger than the budget: entries past the budget must never be read.
      let pulled = 0;
      // A sync generator: `for await` reads it like a Dir handle.
      function* hugeFolder() {
        for (let i = 0; i < MAX_ARTIFACT_LIST_VISITS * 10; i++) {
          pulled += 1;
          yield { name: `.skip-${i}`, isDirectory: () => false, isFile: () => false };
        }
      }
      const opendir = spyOn(fs, "opendir").mockImplementationOnce(
        () => Promise.resolve(hugeFolder()) as unknown as ReturnType<typeof fs.opendir>
      );
      try {
        const { truncated } = await listArtifactsInDir(artifactsDir);
        expect(truncated).toBe(true);
        // The entry that trips the budget is pulled, nothing after it.
        expect(pulled).toBe(MAX_ARTIFACT_LIST_VISITS + 1);
      } finally {
        opendir.mockRestore();
      }
    });

    test("skips an unreadable subfolder instead of failing the listing", async () => {
      if (process.getuid?.() === 0) return; // root reads through chmod 000
      await write("ok.md", "x");
      await write("locked/secret.md", "x");
      await fs.chmod(path.join(artifactsDir, "locked"), 0o000);
      try {
        const { entries, truncated } = await listArtifactsInDir(artifactsDir);
        expect(entries.map((e) => e.path)).toEqual(["ok.md"]);
        expect(truncated).toBe(true);
      } finally {
        await fs.chmod(path.join(artifactsDir, "locked"), 0o755);
      }
    });

    test("does not list names that reads would refuse", async () => {
      if (process.platform === "win32") return; // backslash is a separator there
      await write("a\\b.md", "x");
      await write("C:x.md", "x");
      await write("fine.md", "x");

      const { entries } = await listArtifactsInDir(artifactsDir);

      expect(entries.map((e) => e.path)).toEqual(["fine.md"]);
    });
  });

  describe("parseArtifactRelativePath", () => {
    test.each([
      ["", "Artifact path is empty"],
      ["/etc/passwd", "Artifact path must be relative to the artifacts folder"],
      ["C:/x.md", "Artifact path must be relative to the artifacts folder"],
      ["../secret.txt", "Artifact path is invalid"],
      ["a/../../secret.txt", "Artifact path is invalid"],
      ["a//b.md", "Artifact path is invalid"],
      ["a\\b.md", "Artifact path is invalid"],
      [".env", "Artifact path is invalid"],
    ])("rejects %p", (input, error) => {
      expect(parseArtifactRelativePath(input)).toBe(error);
    });

    test("accepts nested relative paths", () => {
      expect(parseArtifactRelativePath("reports/q3.md")).toEqual(["reports", "q3.md"]);
    });
  });

  describe("readArtifactFromDir", () => {
    test("reads text as utf8 and images as base64", async () => {
      await write("notes.md", "# Hi");
      await write("pic.png", Buffer.from([0x89, 0x50, 0x00, 0x47]));

      const text = await readArtifactFromDir(artifactsDir, "notes.md", 1024);
      const image = await readArtifactFromDir(artifactsDir, "pic.png", 1024);

      expect(text).toMatchObject({
        success: true,
        data: { status: "ok", kind: "markdown", encoding: "utf8", content: "# Hi", size: 4 },
      });
      expect(image).toMatchObject({
        success: true,
        data: { status: "ok", kind: "image", encoding: "base64", content: "iVAARw==" },
      });
    });

    test("reports non-image files with NUL bytes as binary", async () => {
      await write("blob.bin", Buffer.from([1, 0, 2]));
      const result = await readArtifactFromDir(artifactsDir, "blob.bin", 1024);
      expect(result).toMatchObject({ success: true, data: { status: "binary", kind: "text" } });
    });

    test("reports files over the cap as too large without returning content", async () => {
      await write("big.txt", "x".repeat(11));
      const result = await readArtifactFromDir(artifactsDir, "big.txt", 10);
      expect(result).toMatchObject({
        success: true,
        data: { status: "too_large", path: "big.txt", kind: "text", size: 11, maxBytes: 10 },
      });
      expect(result.success && "content" in result.data).toBe(false);
    });

    test("accepts a file exactly at the cap", async () => {
      await write("edge.txt", "x".repeat(10));
      const result = await readArtifactFromDir(artifactsDir, "edge.txt", 10);
      expect(result).toMatchObject({ success: true, data: { status: "ok", size: 10 } });
    });

    test("refuses a symlinked file even when it points inside the folder", async () => {
      await write("real.md", "inside");
      await fs.symlink(path.join(artifactsDir, "real.md"), path.join(artifactsDir, "alias.md"));
      const result = await readArtifactFromDir(artifactsDir, "alias.md", 1024);
      expect(result).toEqual({ success: false, error: "Artifact not found: alias.md" });
    });

    test("refuses files reached through a symlinked folder that leaves the artifacts dir", async () => {
      await fs.writeFile(path.join(tempDir, "secret.txt"), "secret");
      await fs.symlink(tempDir, path.join(artifactsDir, "escape"));
      const result = await readArtifactFromDir(artifactsDir, "escape/secret.txt", 1024);
      expect(result).toEqual({ success: false, error: "Artifact not found: escape/secret.txt" });
    });

    test("refuses traversal and missing files", async () => {
      await fs.writeFile(path.join(tempDir, "scratch", "outside.md"), "x");
      expect(await readArtifactFromDir(artifactsDir, "../outside.md", 1024)).toEqual({
        success: false,
        error: "Artifact path is invalid",
      });
      expect(await readArtifactFromDir(artifactsDir, "missing.md", 1024)).toEqual({
        success: false,
        error: "Artifact not found: missing.md",
      });
    });

    test("refuses a FIFO without blocking on open", async () => {
      // Opening a FIFO with no writer blocks; the read must refuse it before open().
      execFileSync("mkfifo", [path.join(artifactsDir, "pipe.txt")]);
      const result = await readArtifactFromDir(artifactsDir, "pipe.txt", 1024);
      expect(result).toEqual({ success: false, error: "Artifact not found: pipe.txt" });
    });

    test("reads files larger than one read chunk completely", async () => {
      const content = "abcdefghij".repeat(20_000);
      await write("big.md", content);
      const result = await readArtifactFromDir(artifactsDir, "big.md", 1024 * 1024);
      expect(result.success && result.data.status === "ok" && result.data.content).toBe(content);
    });

    test("refuses a symlinked artifacts folder for listing and reading", async () => {
      const home = path.join(tempDir, "home");
      await fs.mkdir(home);
      await fs.writeFile(path.join(home, "notes.md"), "private");
      const linkedDir = path.join(tempDir, "scratch2", "artifacts");
      await fs.mkdir(path.dirname(linkedDir), { recursive: true });
      await fs.symlink(home, linkedDir);

      expect(await listArtifactsInDir(linkedDir)).toEqual({ entries: [], truncated: false });
      expect(await readArtifactFromDir(linkedDir, "notes.md", 1024)).toEqual({
        success: false,
        error: "Artifact not found: notes.md",
      });
    });

    test("refuses directories", async () => {
      await fs.mkdir(path.join(artifactsDir, "folder"));
      expect(await readArtifactFromDir(artifactsDir, "folder", 1024)).toEqual({
        success: false,
        error: "Artifact not found: folder",
      });
    });
  });
});
