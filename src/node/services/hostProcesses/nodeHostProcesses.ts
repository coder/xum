/**
 * The Node layer of HostProcesses: execFileAsync (utils/disposableExec.ts) and the global fetch.
 *
 * Each member reads its binding when it is called, not when this module loads.
 * skillsCatalogFetch.test.ts and gitNoHooksEnv.discovery.test.ts spy on the disposableExec
 * namespace, and skillsCatalogFetch.test.ts spies on globalThis.fetch. Bun applies a namespace
 * spy by replacing the binding, so a member that captured the function at load time would bypass
 * the spy.
 */
import { Layer } from "effect";
import { HostProcessesTag } from "@/node/services/di/tags";
import * as disposableExec from "@/node/utils/disposableExec";
import type { HostProcesses } from "./hostProcesses";

export const nodeHostProcesses: HostProcesses = {
  execFile: (file, args, options) => disposableExec.execFileAsync(file, args, options),
  fetchUrl: (url, init) => globalThis.fetch(url, init),
};

/** The app's HostProcesses. */
export const HostProcessesNode = Layer.succeed(HostProcessesTag)(nodeHostProcesses);
