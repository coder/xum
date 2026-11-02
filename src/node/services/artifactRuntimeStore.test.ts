import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "child_process";
import { constants as fsConstants } from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { ExecOptions } from "@/node/runtime/Runtime";
import {
  listArtifactsOnRuntime,
  parseArtifactListOutput,
  readArtifactBytesOnRuntime,
  readArtifactOnRuntime,
  writeArtifactOnRuntime,
} from "./artifactRuntimeStore";
import {
  MAX_ARTIFACT_LIST_DEPTH,
  MAX_ARTIFACT_LIST_ENTRIES,
  MAX_ARTIFACT_LIST_VISITS,
  listArtifactsInDir,
  readArtifactFromDir,
  writeArtifactToDir,
  type ArtifactWriteOptions,
} from "./artifactStore";

// A LocalRuntime over a temp dir stands in for SSH/Docker: the same scripts run through
// Runtime.exec, so these tests exercise the real shell code paths.
describe("artifactRuntimeStore", () => {
  let tempDir: string;
  let artifactsDir: string;
  let runtime: LocalRuntime;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "artifact-runtime-")));
    artifactsDir = path.join(tempDir, "scratch", "artifacts");
    await fs.mkdir(artifactsDir, { recursive: true });
    runtime = new LocalRuntime(tempDir);
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

  describe("listing", () => {
    test("matches the host listing, odd names included", async () => {
      await write("old.md", "# old", 1_000);
      await write("data/new.json", "{}", 3_000);
      await write("with space.txt", "a b", 2_000);
      await write("line\nbreak.md", "nl", 2_500);
      await write("-dash.csv", "a,b", 500);
      await write(".hidden.md", "x", 4_000);
      await write(".git/config", "x", 4_000);
      await fs.writeFile(path.join(tempDir, "secret.txt"), "secret");
      await fs.symlink(path.join(tempDir, "secret.txt"), path.join(artifactsDir, "link.txt"));
      await fs.symlink(tempDir, path.join(artifactsDir, "linked-dir"));
      await fs.mkdir(path.join(artifactsDir, "empty"));

      const remote = await listArtifactsOnRuntime(runtime, artifactsDir);
      const host = await listArtifactsInDir(artifactsDir);

      expect(remote.dir).toBe(artifactsDir);
      expect(remote.truncated).toBe(false);
      expect(remote.entries).toEqual(host.entries);
      expect(remote.entries.map((entry) => entry.path)).toEqual([
        "data/new.json",
        "line\nbreak.md",
        "with space.txt",
        "old.md",
        "-dash.csv",
      ]);
    });

    test("reports nothing for a missing or symlinked artifacts folder", async () => {
      expect(await listArtifactsOnRuntime(runtime, path.join(tempDir, "missing"))).toEqual({
        dir: path.join(tempDir, "missing"),
        entries: [],
        truncated: false,
      });
      const linked = path.join(tempDir, "linked-artifacts");
      await fs.symlink(artifactsDir, linked);
      await write("a.md", "a");
      expect((await listArtifactsOnRuntime(runtime, linked)).entries).toEqual([]);
    });

    test("stops at the depth limit and reports truncation", async () => {
      const deep = Array.from({ length: MAX_ARTIFACT_LIST_DEPTH + 1 }, (_, i) => `d${i}`).join("/");
      await write(`${deep}/too-deep.md`, "x");
      await write("top.md", "x");

      const result = await listArtifactsOnRuntime(runtime, artifactsDir);

      expect(result.entries.map((entry) => entry.path)).toEqual(["top.md"]);
      expect(result.truncated).toBe(true);
    });

    test("stops at the entry limit and reports truncation", async () => {
      execFileSync("bash", [
        "-c",
        `cd "$1" && for i in $(seq 1 ${MAX_ARTIFACT_LIST_ENTRIES + 5}); do : > "f$i.txt"; done`,
        "_",
        artifactsDir,
      ]);

      const result = await listArtifactsOnRuntime(runtime, artifactsDir);

      expect(result.entries).toHaveLength(MAX_ARTIFACT_LIST_ENTRIES);
      expect(result.truncated).toBe(true);
    });

    test("keeps the newest files when over the cap, even when their names sort last", async () => {
      execFileSync("bash", [
        "-c",
        `cd "$1" && for i in $(seq 1 ${MAX_ARTIFACT_LIST_ENTRIES}); do : > "a$i.txt"; done && touch -d @1000 a*.txt`,
        "_",
        artifactsDir,
      ]);
      await write("zzz-newest.md", "new", 5_000);

      const result = await listArtifactsOnRuntime(runtime, artifactsDir);

      expect(result.entries).toHaveLength(MAX_ARTIFACT_LIST_ENTRIES);
      expect(result.entries[0]?.path).toBe("zzz-newest.md");
      expect(result.truncated).toBe(true);
    });

    test("bounds the walk by entries visited, empty folders included", async () => {
      execFileSync("bash", [
        "-c",
        `cd "$1" && seq -w 1 ${MAX_ARTIFACT_LIST_VISITS} | sed 's/^/d/' | xargs mkdir`,
        "_",
        artifactsDir,
      ]);
      await write("zzz.md", "past the budget");

      const result = await listArtifactsOnRuntime(runtime, artifactsDir);

      expect(result.entries).toEqual([]);
      expect(result.truncated).toBe(true);
    });
  });

  describe("parseArtifactListOutput", () => {
    test("skips a shell banner before the header and refuses cut-off or malformed output", () => {
      const body = "XUMARTIFACTS1\0/s/artifacts\0F\0a b\nc.md\0" + "3 7\0END\0" + "0\0";
      expect(parseArtifactListOutput(`Welcome!\n${body}`)).toEqual({
        dir: "/s/artifacts",
        entries: [{ path: "a b\nc.md", kind: "markdown", size: 3, modifiedMs: 7000 }],
        truncated: false,
      });
      expect(() => parseArtifactListOutput(body.slice(0, body.indexOf("END")))).toThrow();
      expect(() => parseArtifactListOutput("no header")).toThrow();
      expect(() => parseArtifactListOutput(body.replace("END", "BAD"))).toThrow();
    });

    test("keeps a file whose mtime is before 1970", () => {
      // stat prints a negative %Y for such files; the listing must not drop them.
      const output = "XUMARTIFACTS1\0/s\0F\0old.md\0" + "5 -86400\0END\0" + "0\0";
      expect(parseArtifactListOutput(output)).toEqual({
        dir: "/s",
        entries: [{ path: "old.md", kind: "markdown", size: 5, modifiedMs: -86_400_000 }],
        truncated: false,
      });
    });

    test("drops entries the read route would refuse", () => {
      const output =
        "XUMARTIFACTS1\0/s\0F\0../escape.md\0" + "1 1\0F\0ok.md\0" + "x y\0END\0" + "1\0";
      expect(parseArtifactListOutput(output)).toEqual({ dir: "/s", entries: [], truncated: true });
    });
  });

  describe("reading", () => {
    const CAP = 1024;

    test("returns the same results as the host read", async () => {
      await write("notes/report.md", "# Report");
      await write("pic.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
      await write("blob.txt", Buffer.from([0x61, 0, 0x62]));
      await write("exact.txt", "x".repeat(CAP));
      await write("big.txt", "x".repeat(CAP + 1));
      await write("name with\nnewline.md", "odd");

      for (const relPath of [
        "notes/report.md",
        "pic.png",
        "blob.txt",
        "exact.txt",
        "big.txt",
        "name with\nnewline.md",
      ]) {
        const remote = await readArtifactOnRuntime(runtime, artifactsDir, relPath, CAP);
        const host = await readArtifactFromDir(artifactsDir, relPath, CAP);
        // The runtime path reports mtimes at second granularity (portable stat).
        const normalize = (outcome: typeof host) =>
          outcome.success
            ? {
                ...outcome,
                data: { ...outcome.data, modifiedMs: Math.floor(outcome.data.modifiedMs / 1000) },
              }
            : outcome;
        expect(normalize(remote)).toEqual(normalize(host));
      }
      const statuses = await Promise.all(
        ["pic.png", "blob.txt", "big.txt"].map(async (relPath) => {
          const outcome = await readArtifactOnRuntime(runtime, artifactsDir, relPath, CAP);
          return outcome.success ? outcome.data.status : "error";
        })
      );
      expect(statuses).toEqual(["ok", "binary", "too_large"]);
    });

    test("refuses symlinked files and folders, traversal, directories and missing files", async () => {
      await fs.mkdir(path.join(tempDir, "outside"));
      await fs.writeFile(path.join(tempDir, "outside", "secret.md"), "secret");
      await write("inside.md", "inside");
      await fs.symlink(path.join(artifactsDir, "inside.md"), path.join(artifactsDir, "link.md"));
      await fs.symlink(path.join(tempDir, "outside"), path.join(artifactsDir, "out"));
      await fs.mkdir(path.join(artifactsDir, "folder"));

      for (const relPath of ["link.md", "out/secret.md", "folder", "missing.md"]) {
        expect(await readArtifactOnRuntime(runtime, artifactsDir, relPath, CAP)).toEqual({
          success: false,
          error: `Artifact not found: ${relPath}`,
          missing: true,
        });
      }
      for (const relPath of ["../outside/secret.md", "/etc/passwd", ".hidden", "a//b"]) {
        const outcome = await readArtifactOnRuntime(runtime, artifactsDir, relPath, CAP);
        expect(outcome.success).toBe(false);
      }
    });

    test("refuses a symlinked artifacts folder", async () => {
      await write("a.md", "a");
      const linked = path.join(tempDir, "linked");
      await fs.symlink(artifactsDir, linked);
      expect(await readArtifactOnRuntime(runtime, linked, "a.md", CAP)).toEqual({
        success: false,
        error: "Artifact not found: a.md",
        missing: true,
      });
    });

    test("refuses an artifacts folder swapped for a symlink between its check and cd", async () => {
      await fs.mkdir(path.join(tempDir, "outside"));
      await fs.writeFile(path.join(tempDir, "outside", "secret.md"), "secret");
      await write("secret.md", "inside");
      const rootCheck = `if [ -L "$d" ] || [ ! -d "$d" ]; then xum_missing; fi\n`;
      // Runs the swap right after the script's own root check, as a racing writer would.
      class SwappingRuntime extends LocalRuntime {
        override exec(command: string, options: Parameters<LocalRuntime["exec"]>[1]) {
          expect(command).toContain(rootCheck);
          const swap = `mv -- "$d" "$d.moved" && ln -s -- ${JSON.stringify(path.join(tempDir, "outside"))} "$d"\n`;
          return super.exec(command.replace(rootCheck, rootCheck + swap), options);
        }
      }
      const swapping = new SwappingRuntime(tempDir);
      expect(await readArtifactOnRuntime(swapping, artifactsDir, "secret.md", CAP)).toEqual({
        success: false,
        error: "Artifact not found: secret.md",
        missing: true,
      });
    });

    test("reads a pinned checkout file only when the artifacts name check is off", async () => {
      const checkout = path.join(tempDir, "checkout");
      await fs.mkdir(path.join(checkout, ".config"), { recursive: true });
      await fs.writeFile(path.join(checkout, ".config", "a.txt"), "pinned");
      const options = { allowHidden: true };

      const asArtifacts = await readArtifactBytesOnRuntime(
        runtime,
        checkout,
        ".config/a.txt",
        CAP,
        undefined,
        options
      );
      expect(asArtifacts).toEqual({ status: "missing" });

      const pinned = await readArtifactBytesOnRuntime(
        runtime,
        checkout,
        ".config/a.txt",
        CAP,
        undefined,
        {
          ...options,
          requireArtifactsBasename: false,
        }
      );
      expect(pinned).toMatchObject({ status: "ok", bytes: Buffer.from("pinned") });

      // The checkout root is still pinned: a symlinked root is refused.
      const linked = path.join(tempDir, "linked-checkout");
      await fs.symlink(checkout, linked);
      expect(
        await readArtifactBytesOnRuntime(runtime, linked, ".config/a.txt", CAP, undefined, {
          ...options,
          requireArtifactsBasename: false,
        })
      ).toEqual({ status: "missing" });
    });

    test("skips a login banner before the header and throws on cut-off output", async () => {
      await write("pic.png", Buffer.from([0x89, 0x50, 0x4e]));
      // An SSH login banner (motd) reaches stdout before the script's own output.
      class BannerRuntime extends LocalRuntime {
        override exec(command: string, options: Parameters<LocalRuntime["exec"]>[1]) {
          return super.exec(`printf 'motd\\n'\n${command}`, options);
        }
      }
      expect(
        await readArtifactBytesOnRuntime(new BannerRuntime(tempDir), artifactsDir, "pic.png", CAP)
      ).toMatchObject({ status: "ok", bytes: Buffer.from([0x89, 0x50, 0x4e]) });

      // A connection that drops mid-header leaves the size field unterminated.
      class CutOffRuntime extends LocalRuntime {
        override exec(_command: string, options: Parameters<LocalRuntime["exec"]>[1]) {
          return super.exec(String.raw`printf 'XUMREAD1\000ok\000'; printf 3`, options);
        }
      }
      const cutOff = await readArtifactBytesOnRuntime(
        new CutOffRuntime(tempDir),
        artifactsDir,
        "pic.png",
        CAP
      ).then(
        () => null,
        (error: unknown) => error
      );
      expect(cutOff).toMatchObject({ message: "Artifact read output is cut off" });
    });

    test("refuses a FIFO without blocking", async () => {
      execFileSync("mkfifo", [path.join(artifactsDir, "pipe.txt")]);
      expect(await readArtifactOnRuntime(runtime, artifactsDir, "pipe.txt", CAP)).toEqual({
        success: false,
        error: "Artifact not found: pipe.txt",
        missing: true,
      });
    });
  });

  // Host and runtime writers share one contract, so every case runs against both.
  const writers = {
    host: (dir: string, relPath: string, content: string, options?: ArtifactWriteOptions) =>
      writeArtifactToDir(dir, relPath, content, options),
    runtime: (dir: string, relPath: string, content: string, options?: ArtifactWriteOptions) =>
      writeArtifactOnRuntime(runtime, dir, relPath, content, options),
  };

  const outcome = (write: Promise<void>) =>
    write.then(
      () => "written",
      () => "refused"
    );

  /** Runs the host writer's `write` with each fs.open it makes going through `open`. */
  const withHostOpen = async (
    open: (realOpen: typeof fs.open, ...args: Parameters<typeof fs.open>) => Promise<fs.FileHandle>,
    write: () => Promise<void>
  ) => {
    const realOpen = fs.open;
    const spy = spyOn(fs, "open").mockImplementation((...args) => open(realOpen, ...args));
    try {
      await write();
    } finally {
      spy.mockRestore();
    }
  };

  /** The runtime with `script` as its `cat`, ahead of the real one on PATH. */
  const runtimeWithCat = async (script: string): Promise<LocalRuntime> => {
    const bin = await fs.mkdtemp(path.join(tempDir, "bin-"));
    await fs.writeFile(path.join(bin, "cat"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return Object.create(runtime, {
      exec: {
        value: (command: string, execOptions: ExecOptions) =>
          runtime.exec(command, {
            ...execOptions,
            env: { ...execOptions.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
          }),
      },
    }) as LocalRuntime;
  };

  type Writer = typeof writers.host;
  // The same writers, failing after part of the content is on disk (a full disk, say).
  const partlyFailingWriters: Record<keyof typeof writers, Writer> = {
    host: (dir, relPath, content, options) =>
      withHostOpen(
        async (realOpen, ...args) => {
          const handle = await realOpen(...args);
          Object.defineProperty(handle, "writeFile", {
            value: async () => {
              await handle.write(content.slice(0, 3));
              throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
            },
          });
          return handle;
        },
        () => writeArtifactToDir(dir, relPath, content, options)
      ),
    runtime: async (dir, relPath, content, options) =>
      writeArtifactOnRuntime(
        await runtimeWithCat("head -c 3; exit 1"),
        dir,
        relPath,
        content,
        options
      ),
  };
  // The same writers, with the agent writing the file while they write it.
  const racedWriters: Record<keyof typeof writers, Writer> = {
    host: (dir, relPath, content, options) =>
      withHostOpen(
        async (realOpen, ...args) => {
          const [, flags] = args;
          if (typeof flags === "number" && (flags & fsConstants.O_CREAT) !== 0) {
            await fs.writeFile(path.join(dir, relPath), "agent page");
          }
          return realOpen(...args);
        },
        () => writeArtifactToDir(dir, relPath, content, options)
      ),
    runtime: async (dir, relPath, content, options) => {
      const realCat = execFileSync("sh", ["-c", "command -v cat"]).toString().trim();
      // The script runs in the leaf's folder.
      const cat = `${realCat}; printf 'agent page' > ${path.basename(relPath)}`;
      await writeArtifactOnRuntime(await runtimeWithCat(cat), dir, relPath, content, options);
    },
  };

  describe.each(Object.entries(writers))("writing (%s)", (name, writeArtifact) => {
    test("a createOnly write that fails part way leaves nothing, so the next one writes", async () => {
      const failPartWay = partlyFailingWriters[name as keyof typeof writers];
      expect(
        await outcome(failPartWay(artifactsDir, "status.html", "starter", { createOnly: true }))
      ).toBe("refused");
      // No partial page, which every later createOnly write would keep, and no temp file.
      expect(await fs.readdir(artifactsDir)).toEqual([]);
      await writeArtifact(artifactsDir, "status.html", "starter", { createOnly: true });
      expect(await fs.readFile(path.join(artifactsDir, "status.html"), "utf8")).toBe("starter");
    });

    test("createOnly keeps a file that the agent writes while it writes", async () => {
      const raced = racedWriters[name as keyof typeof writers];
      expect(
        await outcome(raced(artifactsDir, "status.html", "starter", { createOnly: true }))
      ).toBe("written");
      expect(await fs.readFile(path.join(artifactsDir, "status.html"), "utf8")).toBe("agent page");
      expect(await fs.readdir(artifactsDir)).toEqual(["status.html"]);
    });

    test("creates missing folders and replaces the file in place", async () => {
      // The scratch dir exists; the artifacts folder and nested folders are created.
      await fs.mkdir(path.join(tempDir, "fresh"));
      const dir = path.join(tempDir, "fresh", "artifacts");
      await writeArtifact(dir, "board.html", "one");
      await writeArtifact(dir, "board.html", "two");
      await writeArtifact(dir, "nested/x.md", "x");
      expect(await fs.readFile(path.join(dir, "board.html"), "utf8")).toBe("two");
      expect(await fs.readFile(path.join(dir, "nested", "x.md"), "utf8")).toBe("x");
      // No temp files left behind.
      expect((await fs.readdir(dir)).sort()).toEqual(["board.html", "nested"]);
    });

    test("never recreates a deleted workspace session or scratch dir", async () => {
      // Workspace removal deleted <session>/scratch; a late board refresh must not bring it back.
      const session = path.join(tempDir, "removed-session");
      const dir = path.join(session, "scratch", "artifacts");
      expect(await outcome(writeArtifact(dir, "board.html", "x"))).toBe("refused");
      expect(
        await fs.access(session).then(
          () => true,
          () => false
        )
      ).toBe(false);
    });

    test("createOnly writes a missing file and leaves an existing one as it is", async () => {
      await writeArtifact(artifactsDir, "status.html", "seed", { createOnly: true });
      expect(await fs.readFile(path.join(artifactsDir, "status.html"), "utf8")).toBe("seed");
      await fs.writeFile(path.join(artifactsDir, "status.html"), "agent page");
      expect(
        await outcome(writeArtifact(artifactsDir, "status.html", "seed", { createOnly: true }))
      ).toBe("written");
      expect(await fs.readFile(path.join(artifactsDir, "status.html"), "utf8")).toBe("agent page");
      expect(await fs.readdir(artifactsDir)).toEqual(["status.html"]);

      const outside = path.join(tempDir, "outside.txt");
      await fs.writeFile(outside, "keep");
      await fs.symlink(outside, path.join(artifactsDir, "leaf.html"));
      await fs.symlink(path.join(tempDir, "missing.txt"), path.join(artifactsDir, "dangling.html"));
      for (const leaf of ["leaf.html", "dangling.html"]) {
        expect(await outcome(writeArtifact(artifactsDir, leaf, "x", { createOnly: true }))).toBe(
          "refused"
        );
      }
      expect(await fs.readFile(outside, "utf8")).toBe("keep");
      expect(await fs.readdir(tempDir)).not.toContain("missing.txt");
    });

    test("never writes through symlinks or outside the dir", async () => {
      const outside = path.join(tempDir, "outside.txt");
      await fs.writeFile(outside, "keep");
      await fs.symlink(outside, path.join(artifactsDir, "leaf.html"));
      await fs.symlink(tempDir, path.join(artifactsDir, "up"));
      const linkedRoot = path.join(tempDir, "linked-artifacts");
      await fs.symlink(tempDir, linkedRoot);

      expect(await outcome(writeArtifact(artifactsDir, "leaf.html", "x"))).toBe("refused");
      expect(await outcome(writeArtifact(artifactsDir, "up/outside.txt", "x"))).toBe("refused");
      expect(await outcome(writeArtifact(linkedRoot, "outside.txt", "x"))).toBe("refused");
      expect(await outcome(writeArtifact(artifactsDir, "../outside.txt", "x"))).toBe("refused");
      expect(await fs.readFile(outside, "utf8")).toBe("keep");
    });
  });
});
