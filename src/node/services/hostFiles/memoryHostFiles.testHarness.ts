/**
 * HostFiles and HostPaths on one memfs volume, for tests that must not touch the host.
 *
 * The volume has the three fixes of SessionFilesMemory (createFixedMemfs), so unlink of a
 * directory, rename onto a full directory and the stat stamps behave as on the host. Each call
 * builds a fresh volume: two hosts share no file. The three paths of HostPaths exist in it.
 */
import { Layer } from "effect";
import type * as nodeFsPromises from "node:fs/promises";
import { HostFilesTag, HostPathsTag } from "@/node/services/di/tags";
import { createFixedMemfs } from "@/node/services/sessionFiles/memorySessionFiles.testHarness";
import writeFileAtomic, {
  sync as writeFileAtomicSync,
  type WriteFileAtomicFs,
} from "@/node/utils/writeFileAtomic";
import type { HostFiles, HostPaths } from "./hostFiles";

export const MEMORY_USER_HOME = "/home/u";
export const MEMORY_XUM_HOME = "/home/u/.xum";
export const MEMORY_TMP_DIR = "/tmp";

export interface MemoryHost {
  files: HostFiles;
  paths: HostPaths;
  /** Creates a symlink in the volume; HostFiles itself has no symlink member. */
  symlink: (target: string, link: string) => Promise<void>;
  /** Both services, for a test graph. */
  layer: Layer.Layer<HostFilesTag | HostPathsTag>;
}

export function createMemoryHost(): MemoryHost {
  const fs = createFixedMemfs();
  for (const dir of [MEMORY_XUM_HOME, MEMORY_TMP_DIR]) {
    // eslint-disable-next-line local/no-sync-fs-methods -- builds the in-memory volume, no disk
    fs.mkdirSync(dir, { recursive: true });
  }
  // memfs declares its own types for the same node:fs signatures.
  const atomicFs = fs as unknown as WriteFileAtomicFs;
  const files: HostFiles = {
    promises: fs.promises as unknown as HostFiles["promises"],
    writeFileAtomic: (target, data, options) =>
      writeFileAtomic(target, data, { ...options, fs: atomicFs }),
    writeFileAtomicSync: (target, data, options) =>
      writeFileAtomicSync(target, data, { ...options, fs: atomicFs }),
  };
  const paths: HostPaths = {
    xumHome: () => MEMORY_XUM_HOME,
    userHome: () => MEMORY_USER_HOME,
    tmpDir: () => MEMORY_TMP_DIR,
  };
  const promises = fs.promises as unknown as Pick<typeof nodeFsPromises, "symlink">;
  return {
    files,
    paths,
    symlink: (target, link) => promises.symlink(target, link),
    layer: Layer.mergeAll(Layer.succeed(HostFilesTag)(files), Layer.succeed(HostPathsTag)(paths)),
  };
}
