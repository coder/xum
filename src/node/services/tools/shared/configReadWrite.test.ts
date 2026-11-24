import * as hostFs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";
import * as jsonc from "jsonc-parser";

import type { HostFiles } from "@/node/services/hostFiles/hostFiles";
import { createMemoryHost } from "@/node/services/hostFiles/memoryHostFiles.testHarness";
import { nodeHostFiles } from "@/node/services/hostFiles/nodeHostFiles";
import { TestTempDir } from "../testHelpers";
import { readConfigDocumentUnvalidated, writeConfigDocument } from "./configReadWrite";

interface ConfigHost extends Disposable {
  files: HostFiles;
  /** A Xum home that does not exist yet: writes must create it. */
  xumHome: string;
  symlink: (target: string, link: string) => Promise<void>;
}

// The config tools must read, write and refuse symlinks the same way on both HostFiles layers.
const LAYERS: Array<[string, () => ConfigHost]> = [
  [
    "node",
    () => {
      const dir = new TestTempDir("config-read-write");
      return {
        files: nodeHostFiles,
        xumHome: path.join(dir.path, "xum"),
        symlink: (target, link) => hostFs.symlink(target, link),
        [Symbol.dispose]: () => dir[Symbol.dispose](),
      };
    },
  ],
  [
    "memory",
    () => {
      const host = createMemoryHost();
      return {
        files: host.files,
        xumHome: path.join(host.paths.tmpDir(), "xum"),
        symlink: host.symlink,
        [Symbol.dispose]: () => undefined,
      };
    },
  ],
];

describe.each(LAYERS)("configReadWrite on the %s layer", (_name, createHost) => {
  test("a missing file reads as an empty document", async () => {
    using host = createHost();
    expect(await readConfigDocumentUnvalidated(host.xumHome, "providers", host.files)).toEqual({});
  });

  test("a written config.json reads back with a fresh write stamp", async () => {
    using host = createHost();
    const written = await writeConfigDocument(
      host.xumHome,
      "config",
      { projects: [], writeId: "previous" },
      host.files
    );
    const read = (await readConfigDocumentUnvalidated(host.xumHome, "config", host.files)) as {
      writeId?: unknown;
    };
    expect(read).toEqual(written);
    expect(typeof read.writeId).toBe("string");
    expect(read.writeId).not.toBe("previous");
  });

  test("a written providers.jsonc keeps its comment header and reads back", async () => {
    using host = createHost();
    const document = { anthropic: { apiKey: "sk-ant-test" } };
    await writeConfigDocument(host.xumHome, "providers", document, host.files);
    const raw = await host.files.promises.readFile(
      path.join(host.xumHome, "providers.jsonc"),
      "utf-8"
    );
    expect(raw.startsWith("//")).toBe(true);
    expect(jsonc.parse(raw)).toEqual(document);
    expect(await readConfigDocumentUnvalidated(host.xumHome, "providers", host.files)).toEqual(
      document
    );
  });

  test("a write refuses a symlinked target and leaves the link's target unchanged", async () => {
    using host = createHost();
    await host.files.promises.mkdir(host.xumHome, { recursive: true });
    const outside = path.join(path.dirname(host.xumHome), "outside.json");
    await host.files.promises.writeFile(outside, "{}", "utf-8");
    await host.symlink(outside, path.join(host.xumHome, "config.json"));

    let refusal: unknown;
    try {
      await writeConfigDocument(host.xumHome, "config", { projects: [] }, host.files);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("symlinked");
    expect(await host.files.promises.readFile(outside, "utf-8")).toBe("{}");
  });
});
