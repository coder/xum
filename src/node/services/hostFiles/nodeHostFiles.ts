/**
 * The Node layers of HostFiles and HostPaths: node:fs/promises, writeFileAtomic, getXumHome and
 * node:os themselves.
 *
 * Each member reads its binding when it is called, not when this module loads. Tests spy on the
 * node:fs/promises and node:os namespaces (skillsCatalogFetch.test.ts spies on fsPromises,
 * systemMessage.test.ts and agent_skill_read.test.ts on os.homedir), and Bun applies such a spy
 * by replacing the namespace binding. A member that captured the function at load time would
 * bypass the spy. This is also why it reads the namespace, not fs.promises or
 * require("fs/promises"): a spy on the namespace misses both.
 */
import { Layer } from "effect";
import * as nodeFsPromises from "node:fs/promises";
import * as os from "node:os";
import { getXumHome } from "@/common/constants/paths";
import { HostFilesTag, HostPathsTag } from "@/node/services/di/tags";
import writeFileAtomic, { sync as writeFileAtomicSync } from "@/node/utils/writeFileAtomic";
import type { HostFiles, HostPaths } from "./hostFiles";

export const nodeHostFiles: HostFiles = {
  // The namespace object itself: a member access on it reads the current binding.
  promises: nodeFsPromises,
  writeFileAtomic: (path, data, options) => writeFileAtomic(path, data, options),
  writeFileAtomicSync: (path, data, options) => writeFileAtomicSync(path, data, options),
};

export const nodeHostPaths: HostPaths = {
  xumHome: () => getXumHome(),
  userHome: () => os.homedir(),
  tmpDir: () => os.tmpdir(),
};

/** The app's HostFiles and HostPaths. */
export const HostFilesNode = Layer.succeed(HostFilesTag)(nodeHostFiles);
export const HostPathsNode = Layer.succeed(HostPathsTag)(nodeHostPaths);
