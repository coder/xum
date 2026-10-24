/**
 * RuntimeFactory for the in-memory loop: every member gives the one FakeRuntime of the memory
 * host, so tools and the loop read and write the same volume as HostFiles. Its hostFiles is the
 * host's HostFiles.
 */
import { Layer } from "effect";
import type { Runtime } from "@/node/runtime/Runtime";
import { resolveWorkspaceExecutionPath } from "@/node/runtime/runtimeHelpers";
import { RuntimeFactoryTag } from "@/node/services/di/tags";
import type { HostFiles } from "@/node/services/hostFiles/hostFiles";
import type { RuntimeFactory } from "./runtimeFactoryService";

export function fakeRuntimeFactory(host: { runtime: Runtime; files: HostFiles }): RuntimeFactory {
  const runtime = host.runtime;
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
    hostFiles: host.files,
  };
}

export function RuntimeFactoryFake(host: {
  runtime: Runtime;
  files: HostFiles;
}): Layer.Layer<RuntimeFactoryTag> {
  return Layer.succeed(RuntimeFactoryTag)(fakeRuntimeFactory(host));
}
