import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  getShelfScopeDir,
  listShelfScope,
  MAX_SHELF_FILE_BYTES,
  PROJECT_SHELF_MULTI_PROJECT_ERROR,
  MAX_SHELF_TITLE_LENGTH,
  pinToShelf,
  readShelfEntry,
  SHELF_ENTRY_CHANGED_ERROR,
  shelfEntryName,
  unpinFromShelf,
} from "./artifactShelf";
import { projectMemoryDirName } from "./memoryService";

let root: string;
let shelfRoot: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-shelf-"));
  shelfRoot = path.join(root, "artifacts");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const meta = (title: string, pinnedAtMs = 1) => ({
  sourceWorkspaceId: "ws-1",
  version: 1,
  title,
  kind: "markdown" as const,
  pinnedAtMs,
  pinnedBy: "agent" as const,
});

function projectDir(identity = "/repos/app"): string {
  const dir = getShelfScopeDir(shelfRoot, "project", identity);
  if (typeof dir !== "string") throw new Error(dir.error);
  return dir;
}

describe("shelf paths", () => {
  test("project shelves use the project memory naming; multi-project has none", () => {
    expect(projectDir("/repos/app")).toBe(
      path.join(shelfRoot, "project", projectMemoryDirName("/repos/app"))
    );
    expect(getShelfScopeDir(shelfRoot, "global", "")).toBe(path.join(shelfRoot, "global"));
    expect(getShelfScopeDir(shelfRoot, "project", "")).toEqual({
      error: PROJECT_SHELF_MULTI_PROJECT_ERROR,
    });
  });

  test("entry names flatten nested artifact paths", () => {
    expect(shelfEntryName("reports/q3/summary.md")).toBe("reports__q3__summary.md");
  });
});

describe("pin, list, read, unpin", () => {
  test("pinning copies bytes and re-pinning the same path replaces the entry", async () => {
    const scopeDir = projectDir();
    await pinToShelf({
      shelfRoot,
      scopeDir,
      relPath: "notes/a.md",
      bytes: Buffer.from("one"),
      meta: meta("First", 1),
    });
    await pinToShelf({
      shelfRoot,
      scopeDir,
      relPath: "notes/a.md",
      bytes: Buffer.from("two!"),
      meta: meta("Second", 2),
    });
    await pinToShelf({
      shelfRoot,
      scopeDir,
      relPath: "b.md",
      bytes: Buffer.from("b"),
      meta: meta("B", 3),
    });
    const entries = await listShelfScope(shelfRoot, scopeDir, "project");
    expect(entries.map((e) => [e.name, e.title, e.size])).toEqual([
      ["b.md", "B", 1],
      ["notes__a.md", "Second", 4],
    ]);
    const read = await readShelfEntry(shelfRoot, scopeDir, "notes__a.md");
    expect(read.status === "ok" && read.bytes.toString()).toBe("two!");
    expect(read.status === "ok" && read.meta.sourcePath).toBe("notes/a.md");
  });

  test("a pin never replaces another source's entry or your own pin", async () => {
    const scopeDir = getShelfScopeDir(shelfRoot, "global", "") as string;
    const pin = (
      relPath: string,
      text: string,
      overrides: { sourceWorkspaceId?: string; pinnedBy?: "agent" | "user" }
    ) =>
      pinToShelf({
        shelfRoot,
        scopeDir,
        relPath,
        bytes: Buffer.from(text),
        meta: { ...meta(text), ...overrides },
      });

    expect(await pin("report.html", "user-a", { pinnedBy: "user" })).toEqual({
      success: true,
      name: "report.html",
    });
    // Same name from another workspace: new entry, the first one keeps its bytes.
    expect(await pin("report.html", "agent-b", { sourceWorkspaceId: "ws-2" })).toEqual({
      success: true,
      name: "report.html~2",
    });
    // Same workspace and path, but an agent pin must not replace the user's pin.
    expect(await pin("report.html", "agent-a", {})).toEqual({
      success: true,
      name: "report.html~3",
    });
    // Paths that flatten to the same name are different sources.
    expect(await pin("a/b.md", "nested", {})).toEqual({ success: true, name: "a__b.md" });
    expect(await pin("a__b.md", "flat", {})).toEqual({ success: true, name: "a__b.md~2" });
    // Re-pinning its own entry still replaces it.
    expect(await pin("report.html", "agent-b2", { sourceWorkspaceId: "ws-2" })).toEqual({
      success: true,
      name: "report.html~2",
    });

    const text = async (name: string) => {
      const read = await readShelfEntry(shelfRoot, scopeDir, name);
      return read.status === "ok" ? read.bytes.toString() : read.status;
    };
    expect(await text("report.html")).toBe("user-a");
    expect(await text("report.html~2")).toBe("agent-b2");
    expect(await text("report.html~3")).toBe("agent-a");
    expect(await text("a__b.md")).toBe("nested");
  });

  test("refuses an artifact named meta.json, in any letter case", async () => {
    const scopeDir = projectDir();
    for (const relPath of ["reports/meta.json", "reports/META.JSON", "Meta.Json"]) {
      expect(
        await pinToShelf({
          shelfRoot,
          scopeDir,
          relPath,
          bytes: Buffer.from("{}"),
          meta: meta("Meta"),
        })
      ).toMatchObject({ success: false });
    }
    expect(await listShelfScope(shelfRoot, scopeDir, "project")).toEqual([]);
    expect(await fs.readdir(scopeDir).catch(() => [])).toEqual([]);
  });

  test("a failed swap keeps the previous entry", async () => {
    const scopeDir = projectDir();
    const pin = (text: string) =>
      pinToShelf({
        shelfRoot,
        scopeDir,
        relPath: "a.md",
        bytes: Buffer.from(text),
        meta: meta(text),
      });
    expect(await pin("old")).toMatchObject({ success: true });
    const realRename = fs.rename;
    const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from).includes(".staging-")) throw new Error("disk full");
      return realRename(from, to);
    });
    try {
      const result = await pin("new").catch(() => ({ success: false }));
      expect(result.success).toBe(false);
    } finally {
      rename.mockRestore();
    }
    const read = await readShelfEntry(shelfRoot, scopeDir, "a.md");
    expect(read.status === "ok" && read.bytes.toString()).toBe("old");
    // Nothing is left behind next to the entry.
    expect(await fs.readdir(scopeDir)).toEqual(["a.md"]);
  });

  test("an entry that cannot be checked is never overwritten", async () => {
    const scopeDir = projectDir();
    const pin = (text: string) =>
      pinToShelf({
        shelfRoot,
        scopeDir,
        relPath: "a.md",
        bytes: Buffer.from(text),
        meta: meta(text),
      });
    expect(await pin("old")).toMatchObject({ success: true });
    const realLstat = fs.lstat;
    const entryDir = path.join(scopeDir, "a.md");
    const lstat = spyOn(fs, "lstat").mockImplementation((async (target: string) => {
      if (target === entryDir) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return realLstat(target);
    }) as typeof fs.lstat);
    try {
      expect(await pin("new")).toMatchObject({ success: false });
    } finally {
      lstat.mockRestore();
    }
    const read = await readShelfEntry(shelfRoot, scopeDir, "a.md");
    expect(read.status === "ok" && read.bytes.toString()).toBe("old");
  });

  test("reads the whole entry even when one read returns fewer bytes", async () => {
    const scopeDir = projectDir();
    await pinToShelf({
      shelfRoot,
      scopeDir,
      relPath: "a.md",
      bytes: Buffer.from("0123456789"),
      meta: meta("A"),
    });
    const realOpen = fs.open;
    const open = spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      const realRead = handle.read.bind(handle);
      // Short reads: at most 4 bytes per call.
      handle.read = ((buffer: Buffer, offset: number, length: number, position: number) =>
        realRead(buffer, offset, Math.min(length, 4), position)) as typeof handle.read;
      return handle;
    });
    try {
      const read = await readShelfEntry(shelfRoot, scopeDir, "a.md");
      expect(read.status === "ok" && read.bytes.toString()).toBe("0123456789");
    } finally {
      open.mockRestore();
    }
  });

  test("refuses files over the 10 MB cap", async () => {
    const pinned = await pinToShelf({
      shelfRoot,
      scopeDir: projectDir(),
      relPath: "big.json",
      bytes: Buffer.alloc(MAX_SHELF_FILE_BYTES + 1),
      meta: meta("Big"),
    });
    expect(pinned.success).toBe(false);
    expect(!pinned.success && pinned.error).toContain("capped");
    expect(await listShelfScope(shelfRoot, projectDir(), "project")).toEqual([]);
  });

  test("a pin from a long legacy workspace id stays listed", async () => {
    const scopeDir = projectDir();
    const sourceWorkspaceId = `${"p".repeat(150)}-${"w".repeat(149)}`;
    expect(
      await pinToShelf({
        shelfRoot,
        scopeDir,
        relPath: "a.md",
        bytes: Buffer.from("a"),
        meta: { ...meta("A"), sourceWorkspaceId },
      })
    ).toEqual({ success: true, name: "a.md" });
    expect(await listShelfScope(shelfRoot, scopeDir, "project")).toMatchObject([
      { name: "a.md", sourceWorkspaceId },
    ]);
  });

  test("a pin whose details the shelf could not read back is refused, not written", async () => {
    const scopeDir = projectDir();
    const pinned = await pinToShelf({
      shelfRoot,
      scopeDir,
      relPath: "a.md",
      bytes: Buffer.from("a"),
      meta: { ...meta("A"), sourceWorkspaceId: "w".repeat(5000) },
    });
    expect(pinned.success).toBe(false);
    expect(await fs.readdir(scopeDir).catch(() => [])).toEqual([]);
  });

  test("a pin clamps a long title to the stored bound", async () => {
    const scopeDir = projectDir();
    await pinToShelf({
      shelfRoot,
      scopeDir,
      relPath: "a.md",
      bytes: Buffer.from("a"),
      meta: meta("t".repeat(5000)),
    });
    const [entry] = await listShelfScope(shelfRoot, scopeDir, "project");
    expect(entry?.title.length).toBe(MAX_SHELF_TITLE_LENGTH);
    expect(entry?.title.endsWith("…")).toBe(true);
  });

  test("an unpin from a stale listing keeps an entry that was pinned again", async () => {
    const scopeDir = projectDir();
    const pin = (pinnedAtMs: number) =>
      pinToShelf({
        shelfRoot,
        scopeDir,
        relPath: "a.md",
        bytes: Buffer.from(`at ${pinnedAtMs}`),
        meta: meta("A", pinnedAtMs),
      });
    await pin(1);
    // Someone else re-pinned the name after this listing showed pinnedAtMs 1.
    await pin(2);
    expect(await unpinFromShelf(shelfRoot, scopeDir, "a.md", 1)).toEqual({
      success: false,
      error: SHELF_ENTRY_CHANGED_ERROR,
    });
    expect(await listShelfScope(shelfRoot, scopeDir, "project")).toMatchObject([
      { name: "a.md", pinnedAtMs: 2 },
    ]);
    expect(await unpinFromShelf(shelfRoot, scopeDir, "a.md", 2)).toEqual({ success: true });
    expect(await listShelfScope(shelfRoot, scopeDir, "project")).toEqual([]);
    // Already gone: still idempotent.
    expect(await unpinFromShelf(shelfRoot, scopeDir, "a.md", 2)).toEqual({ success: true });
  });

  test("unpin removes the entry and is idempotent", async () => {
    const scopeDir = projectDir();
    await pinToShelf({
      shelfRoot,
      scopeDir,
      relPath: "a.md",
      bytes: Buffer.from("a"),
      meta: meta("A"),
    });
    expect(await unpinFromShelf(shelfRoot, scopeDir, "a.md")).toEqual({ success: true });
    expect(await unpinFromShelf(shelfRoot, scopeDir, "a.md")).toEqual({ success: true });
    expect(await listShelfScope(shelfRoot, scopeDir, "project")).toEqual([]);
    expect(await unpinFromShelf(shelfRoot, scopeDir, "../x")).toMatchObject({ success: false });
  });

  test("reads refuse traversal names, symlinked entries and symlinked content files", async () => {
    const scopeDir = projectDir();
    await pinToShelf({
      shelfRoot,
      scopeDir,
      relPath: "a.md",
      bytes: Buffer.from("a"),
      meta: meta("A"),
    });
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.md"), "secret");
    expect(await readShelfEntry(shelfRoot, scopeDir, "../../outside")).toEqual({
      status: "missing",
    });

    // An entry dir that is a symlink to another (valid-looking) entry outside the shelf.
    await fs.cp(path.join(scopeDir, "a.md"), path.join(outside, "entry"), { recursive: true });
    await fs.symlink(path.join(outside, "entry"), path.join(scopeDir, "linked.md"));
    expect(await readShelfEntry(shelfRoot, scopeDir, "linked.md")).toEqual({ status: "missing" });
    expect((await listShelfScope(shelfRoot, scopeDir, "project")).map((e) => e.name)).toEqual([
      "a.md",
    ]);

    // A content file swapped for a symlink is not followed.
    await fs.rm(path.join(scopeDir, "a.md", "a.md"));
    await fs.symlink(path.join(outside, "secret.md"), path.join(scopeDir, "a.md", "a.md"));
    expect(await readShelfEntry(shelfRoot, scopeDir, "a.md")).toEqual({ status: "missing" });
  });

  test("malformed meta hides an entry instead of failing the listing", async () => {
    const scopeDir = projectDir();
    await pinToShelf({
      shelfRoot,
      scopeDir,
      relPath: "a.md",
      bytes: Buffer.from("a"),
      meta: meta("A"),
    });
    await fs.mkdir(path.join(scopeDir, "broken"));
    await fs.writeFile(path.join(scopeDir, "broken", "meta.json"), "{nope");
    expect((await listShelfScope(shelfRoot, scopeDir, "project")).map((e) => e.name)).toEqual([
      "a.md",
    ]);
  });

  test("a pin time outside the Date range hides the entry, so listings can format the rest", async () => {
    const scopeDir = projectDir();
    await pinToShelf({
      shelfRoot,
      scopeDir,
      relPath: "a.md",
      bytes: Buffer.from("a"),
      meta: meta("A"),
    });
    // What a restored backup can bring in: finite, but `new Date(1e100).toISOString()` throws.
    await pinToShelf({
      shelfRoot,
      scopeDir,
      relPath: "far.md",
      bytes: Buffer.from("far"),
      meta: meta("Far"),
    });
    const metaPath = path.join(scopeDir, "far.md", "meta.json");
    const stored = JSON.parse(await fs.readFile(metaPath, "utf-8")) as Record<string, unknown>;
    await fs.writeFile(metaPath, JSON.stringify({ ...stored, pinnedAtMs: 1e100 }));
    const entries = await listShelfScope(shelfRoot, scopeDir, "project");
    expect(entries.map((e) => e.name)).toEqual(["a.md"]);
    expect(entries.map((e) => new Date(e.pinnedAtMs).toISOString())).toHaveLength(1);
  });
});
