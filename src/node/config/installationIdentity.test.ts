import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  INSTALLATION_ID_FILE,
  InstallationIdentityError,
  loadOrCreateInstallationId,
} from "./installationIdentity";

describe("installation identity (#5174)", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "xum-installation-id-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("backends racing to create it on one root all end with the same identity", async () => {
    // Separate processes, as two backends sharing one data root are: no shared in-memory cache.
    const script = `
      const { loadOrCreateInstallationId } = await import(${JSON.stringify(
        path.join(import.meta.dir, "installationIdentity.ts")
      )});
      process.stdout.write(await loadOrCreateInstallationId(${JSON.stringify(root)}));
    `;
    const runBackend = () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ["-e", script], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0
            ? resolve(stdout)
            : reject(new Error(`backend exited ${String(code)}: ${stderr}`))
        );
      });

    const ids = await Promise.all(Array.from({ length: 6 }, runBackend));

    expect(new Set(ids).size).toBe(1);
    expect((await fs.readFile(path.join(root, INSTALLATION_ID_FILE), "utf-8")).trim()).toBe(ids[0]);
    // No temp file is left behind by the losers.
    expect(await fs.readdir(root)).toEqual([INSTALLATION_ID_FILE]);
  });

  test("a deleted identity file takes effect at once instead of a cached identity", async () => {
    const first = await loadOrCreateInstallationId(root);
    await fs.rm(path.join(root, INSTALLATION_ID_FILE));

    const second = await loadOrCreateInstallationId(root);

    expect(second).not.toBe(first);
    expect((await fs.readFile(path.join(root, INSTALLATION_ID_FILE), "utf-8")).trim()).toBe(second);
  });

  test("two data roots are two installations", async () => {
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xum-installation-id-"));
    try {
      expect(await loadOrCreateInstallationId(root)).not.toBe(
        await loadOrCreateInstallationId(otherRoot)
      );
    } finally {
      await fs.rm(otherRoot, { recursive: true, force: true });
    }
  });

  test("a corrupt identity file fails closed and is never replaced", async () => {
    const filePath = path.join(root, INSTALLATION_ID_FILE);
    await fs.writeFile(filePath, "not-a-uuid\n");

    const error: unknown = await loadOrCreateInstallationId(root).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InstallationIdentityError);
    expect((error as Error).message).toContain(filePath);
    expect(await fs.readFile(filePath, "utf-8")).toBe("not-a-uuid\n");
  });

  test("an unreadable identity path fails closed instead of minting a new identity", async () => {
    // A directory where the file belongs: reading it fails with something other than ENOENT.
    await fs.mkdir(path.join(root, INSTALLATION_ID_FILE));

    const error: unknown = await loadOrCreateInstallationId(root).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstallationIdentityError);
  });
});

describe("installation identity creation failures (#5620)", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "xum-installation-id-"));
  });

  afterEach(async () => {
    mock.restore();
    await fs.rm(root, { recursive: true, force: true });
  });

  test("a failed write of the new identity leaves no temp file in the data root", async () => {
    // A full disk: the temp file is created, then its write fails.
    const realOpen = fs.open;
    spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      handle.writeFile = () =>
        Promise.reject(Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" }));
      return handle;
    });

    const error: unknown = await loadOrCreateInstallationId(root).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(await fs.readdir(root)).toEqual([]);
  });
});
