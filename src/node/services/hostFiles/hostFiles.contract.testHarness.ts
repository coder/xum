/**
 * The behaviour of HostFiles and HostPaths that the moved callers rely on, as one suite that
 * every layer must pass (the Node layer and the memory layer). One case for each member and for
 * each error code a caller branches on.
 *
 * Each case builds the host again, so no two cases share state, and works in a fresh mkdtemp
 * folder under the host's own tmpDir().
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { HostFiles, HostPaths } from "./hostFiles";

export interface ContractHost {
  files: HostFiles;
  paths: HostPaths;
  /** Creates a symlink in the host's files; HostFiles itself has no symlink member. */
  symlink: (target: string, link: string) => Promise<void>;
}

async function errorCode(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
  return "no error";
}

export function describeHostFilesContract(name: string, build: () => ContractHost): void {
  describe(`HostFiles contract: ${name}`, () => {
    function it(
      title: string,
      body: (host: ContractHost, dir: string) => Promise<void>,
      options: { posixOnly?: boolean } = {}
    ): void {
      const run = options.posixOnly === true && process.platform === "win32" ? test.skip : test;
      run(title, async () => {
        const host = build();
        const dir = await host.files.promises.mkdtemp(
          path.join(host.paths.tmpDir(), "xum-host-files-")
        );
        try {
          await body(host, dir);
        } finally {
          await host.files.promises.rm(dir, { recursive: true, force: true });
        }
      });
    }

    it("writeFile then readFile give back the bytes, as text and as a Buffer", async ({
      files,
    }, dir) => {
      const file = path.join(dir, "SKILL.md");
      await files.promises.writeFile(file, "# skill\n");
      expect(await files.promises.readFile(file, "utf8")).toBe("# skill\n");
      expect(Buffer.from(await files.promises.readFile(file)).toString()).toBe("# skill\n");
    });

    it("readFile, access, stat and lstat of a missing path fail with ENOENT", async ({
      files,
    }, dir) => {
      const missing = path.join(dir, "missing");
      expect([
        await errorCode(() => files.promises.readFile(missing)),
        await errorCode(() => files.promises.access(missing)),
        await errorCode(() => files.promises.stat(missing)),
        await errorCode(() => files.promises.lstat(missing)),
      ]).toEqual(["ENOENT", "ENOENT", "ENOENT", "ENOENT"]);
      await files.promises.access(dir);
    });

    it("mkdir recursive makes every level, and mkdir of an existing dir fails with EEXIST", async ({
      files,
    }, dir) => {
      const nested = path.join(dir, "a", "b", "c");
      await files.promises.mkdir(nested, { recursive: true });
      expect((await files.promises.stat(nested)).isDirectory()).toBe(true);
      await files.promises.mkdir(nested, { recursive: true });
      expect(await errorCode(() => files.promises.mkdir(nested))).toBe("EEXIST");
    });

    it("readdir lists names, and with withFileTypes their kinds", async ({ files }, dir) => {
      await files.promises.mkdir(path.join(dir, "skills"));
      await files.promises.writeFile(path.join(dir, "AGENTS.md"), "x");
      expect((await files.promises.readdir(dir)).toSorted()).toEqual(["AGENTS.md", "skills"]);
      const entries = await files.promises.readdir(dir, { withFileTypes: true });
      expect(entries.map((entry) => [entry.name, entry.isDirectory()]).toSorted()).toEqual([
        ["AGENTS.md", false],
        ["skills", true],
      ]);
      expect(await errorCode(() => files.promises.readdir(path.join(dir, "AGENTS.md")))).toBe(
        "ENOTDIR"
      );
    });

    it(
      "stat and realpath follow a symlink, lstat does not",
      async (host, dir) => {
        const { files } = host;
        const target = path.join(dir, "target.md");
        const link = path.join(dir, "link.md");
        await files.promises.writeFile(target, "x");
        await host.symlink(target, link);
        expect((await files.promises.stat(link)).isFile()).toBe(true);
        expect((await files.promises.lstat(link)).isSymbolicLink()).toBe(true);
        expect(await files.promises.realpath(link)).toBe(await files.promises.realpath(target));
      },
      { posixOnly: true }
    );

    it(
      "open with O_NONBLOCK reads through the handle, and its bigint stat names the lstat inode",
      async ({ files }, dir) => {
        const file = path.join(dir, "hooks.js");
        await files.promises.writeFile(file, "export {};\n");
        const { O_RDONLY, O_NONBLOCK } = files.promises.constants;
        const handle = await files.promises.open(file, O_RDONLY | O_NONBLOCK);
        try {
          const stat = await handle.stat({ bigint: true });
          const linkStat = await files.promises.lstat(file, { bigint: true });
          expect([stat.dev === linkStat.dev, stat.ino === linkStat.ino, stat.size]).toEqual([
            true,
            true,
            11n,
          ]);
          const buffer = Buffer.alloc(11);
          const { bytesRead } = await handle.read(buffer, 0, 11, 0);
          expect([bytesRead, buffer.toString()]).toEqual([11, "export {};\n"]);
        } finally {
          await handle.close();
        }
        expect(await errorCode(() => files.promises.open(path.join(dir, "missing")))).toBe(
          "ENOENT"
        );
      },
      { posixOnly: true }
    );

    it("mkdtemp makes a new folder with the prefix on each call", async ({ files }, dir) => {
      const first = await files.promises.mkdtemp(path.join(dir, "clone-"));
      const second = await files.promises.mkdtemp(path.join(dir, "clone-"));
      expect(first).not.toBe(second);
      expect(path.basename(first).startsWith("clone-")).toBe(true);
      expect((await files.promises.stat(second)).isDirectory()).toBe(true);
    });

    it("rm recursive removes a tree, and rm of a missing path fails unless force", async ({
      files,
    }, dir) => {
      const tree = path.join(dir, "tree");
      await files.promises.mkdir(path.join(tree, "sub"), { recursive: true });
      await files.promises.writeFile(path.join(tree, "sub", "f"), "x");
      await files.promises.rm(tree, { recursive: true });
      expect(await errorCode(() => files.promises.stat(tree))).toBe("ENOENT");
      expect(await errorCode(() => files.promises.rm(tree))).toBe("ENOENT");
      await files.promises.rm(tree, { force: true });
    });

    it(
      "unlink removes a file, and unlink of a directory fails like the host",
      async ({ files }, dir) => {
        const file = path.join(dir, "f");
        await files.promises.writeFile(file, "x");
        await files.promises.unlink(file);
        expect(await errorCode(() => files.promises.stat(file))).toBe("ENOENT");
        const sub = path.join(dir, "sub");
        await files.promises.mkdir(sub);
        expect(await errorCode(() => files.promises.unlink(sub))).toBe(
          process.platform === "linux" ? "EISDIR" : "EPERM"
        );
      },
      { posixOnly: true }
    );

    it(
      "rename replaces a file, and rename onto a full directory fails with ENOTEMPTY",
      async ({ files }, dir) => {
        const from = path.join(dir, "new");
        const to = path.join(dir, "old");
        await files.promises.writeFile(from, "new");
        await files.promises.writeFile(to, "old");
        await files.promises.rename(from, to);
        expect(await files.promises.readFile(to, "utf8")).toBe("new");
        expect(await errorCode(() => files.promises.stat(from))).toBe("ENOENT");
        const a = path.join(dir, "a");
        const b = path.join(dir, "b");
        await files.promises.mkdir(a);
        await files.promises.mkdir(b);
        await files.promises.writeFile(path.join(b, "f"), "x");
        expect(await errorCode(() => files.promises.rename(a, b))).toBe("ENOTEMPTY");
      },
      { posixOnly: true }
    );

    it("writeFileAtomic replaces the bytes and leaves no temp file", async ({ files }, dir) => {
      const file = path.join(dir, "config.json");
      await files.promises.writeFile(file, "old");
      await files.writeFileAtomic(file, "new");
      expect(await files.promises.readFile(file, "utf8")).toBe("new");
      expect(await files.promises.readdir(dir)).toEqual(["config.json"]);
    });

    it("writeFileAtomicSync replaces the bytes, keeps the mode it gets and leaves no temp file", async ({
      files,
    }, dir) => {
      const file = path.join(dir, "providers.jsonc");
      files.writeFileAtomicSync(file, "new", { encoding: "utf-8", mode: 0o600 });
      expect(await files.promises.readFile(file, "utf8")).toBe("new");
      if (process.platform !== "win32")
        expect((await files.promises.stat(file)).mode & 0o777).toBe(0o600);
      expect(await files.promises.readdir(dir)).toEqual(["providers.jsonc"]);
    });

    test("HostPaths gives three absolute paths, and its tmpDir exists in HostFiles", async () => {
      const { files, paths } = build();
      for (const dir of [paths.xumHome(), paths.userHome(), paths.tmpDir()])
        expect(path.isAbsolute(dir)).toBe(true);
      expect((await files.promises.stat(paths.tmpDir())).isDirectory()).toBe(true);
    });
  });
}
