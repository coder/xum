/**
 * The Node layer of SessionFiles: node:fs itself.
 *
 * Each member reads its binding when it is called, not when this module loads. Tests across the
 * repo spy on the node:fs/promises and node:fs namespaces (and on the CommonJS fs object that
 * writeFileAtomic uses), and Bun applies such a spy by replacing the namespace binding. A member
 * that captured the function at load time would bypass the spy.
 */
import { Layer } from "effect";
import * as nodeFs from "node:fs";
import * as nodeFsPromises from "node:fs/promises";
import { SessionFilesTag } from "@/node/services/di/tags";
import { ensurePrivateDir } from "@/node/utils/fs";
import writeFileAtomic, { fsyncParentDirectory } from "@/node/utils/writeFileAtomic";
import type { SessionFiles } from "./sessionFiles";

export const nodeSessionFiles: SessionFiles = {
  // The namespace object itself: a member access on it reads the current binding.
  promises: nodeFsPromises,
  constants: nodeFs.constants,
  get fsyncSync() {
    return nodeFs.fsyncSync;
  },
  get renameSync() {
    return nodeFs.renameSync;
  },
  get rmdirSync() {
    return nodeFs.rmdirSync;
  },
  get rmSync() {
    return nodeFs.rmSync;
  },
  get unlinkSync() {
    return nodeFs.unlinkSync;
  },
  get writeSync() {
    return nodeFs.writeSync;
  },
  writeFileAtomic: (path, data, options) => writeFileAtomic(path, data, options),
  fsyncParentDirectory: (target) => fsyncParentDirectory(target),
  ensurePrivateDir: (dirPath) => ensurePrivateDir(dirPath),
};

/** The app's SessionFiles (StoresLive provides it). */
export const SessionFilesNode = Layer.succeed(SessionFilesTag)(nodeSessionFiles);
