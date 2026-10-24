/**
 * RuntimeFactory for the in-memory loop: every member gives the one FakeRuntime of the memory
 * host, so tools and the loop read and write the same volume as HostFiles.
 */
import { Layer } from "effect";
import type { Runtime } from "@/node/runtime/Runtime";
import { resolveWorkspaceExecutionPath } from "@/node/runtime/runtimeHelpers";
import { RuntimeFactoryTag } from "@/node/services/di/tags";
import type { RuntimeFactory } from "./runtimeFactoryService";

export function fakeRuntimeFactory(runtime: Runtime): RuntimeFactory {
  return {
    createRuntime: () => runtime,
    createRuntimeForWorkspace: () => runtime,
    // The workspace path follows the fake's own path rules, as the Node builder follows each
    // runtime's.
    createRuntimeContextForWorkspace: (metadata) => ({
      runtime,
      workspacePath: resolveWorkspaceExecutionPath(metadata, runtime),
    }),
    createMultiProjectRuntime: () => runtime,
    createLocalRuntime: () => runtime,
  };
}

export function RuntimeFactoryFake(host: { runtime: Runtime }): Layer.Layer<RuntimeFactoryTag> {
  return Layer.succeed(RuntimeFactoryTag)(fakeRuntimeFactory(host.runtime));
}
