import { LEGACY_REMOTE_MUX_HOME } from "@/common/compat/legacyMux";
import { isRemoteRuntime, type Runtime } from "./Runtime";
import type { RuntimeFactory } from "@/node/services/runtimeFactory/runtimeFactoryService";

/**
 * SSH runtimes retain the legacy remote home because local startup cannot safely migrate
 * arbitrary or offline hosts. Their global reads still resolve through the host's canonical
 * ~/.xum directory; Docker's separate /var/mux contract remains inside the container.
 */
function shouldUseHostGlobalXumFallback(runtime: Runtime): boolean {
  return isRemoteRuntime(runtime) && runtime.getXumHome() === LEGACY_REMOTE_MUX_HOME;
}

/**
 * True when resolveGlobalRuntime keeps a remote runtime, so global roots are read on it. Gives
 * the answer of `isRemoteRuntime(resolveGlobalRuntime(...))` without building the host runtime.
 */
export function readsGlobalRootsRemotely(runtime: Runtime): boolean {
  return isRemoteRuntime(runtime) && !shouldUseHostGlobalXumFallback(runtime);
}

/** Return the runtime used to read global xum agent and skill roots. */
export function resolveGlobalRuntime(
  runtime: Runtime,
  workspacePath: string,
  runtimeFactory: RuntimeFactory
): Runtime {
  return shouldUseHostGlobalXumFallback(runtime)
    ? runtimeFactory.createLocalRuntime(workspacePath)
    : runtime;
}
