import { Layer } from "effect";
import { ContainerManager } from "@/node/multiProject/containerManager";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { MultiProjectRuntime } from "@/node/runtime/multiProjectRuntime";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import {
  createRuntimeContextForWorkspace,
  createRuntimeForWorkspace,
} from "@/node/runtime/runtimeHelpers";
import { RuntimeFactoryTag } from "@/node/services/di/tags";
import type { RuntimeFactory } from "./runtimeFactoryService";

/**
 * The real runtimes: today's builders themselves. The arrow functions read each import at call
 * time, so spies on the runtime modules still reach the call.
 */
export const nodeRuntimeFactory: RuntimeFactory = {
  createRuntime: (config, options) => createRuntime(config, options),
  createRuntimeForWorkspace: (metadata) => createRuntimeForWorkspace(metadata),
  createRuntimeContextForWorkspace: (metadata) => createRuntimeContextForWorkspace(metadata),
  createMultiProjectRuntime: (input) =>
    new MultiProjectRuntime(
      new ContainerManager(input.srcBaseDir),
      input.projects.map((project) => ({
        projectPath: project.projectPath,
        projectName: project.projectName,
        runtime: createRuntime(input.runtimeConfig, {
          projectPath: project.projectPath,
          workspaceName: input.workspaceName,
          workspacePath: project.workspacePath,
        }),
      })),
      input.workspaceName
    ),
  createLocalRuntime: (path) => new LocalRuntime(path),
};

/**
 * A tool config's runtime builders: the session's (ToolConfiguration.runtimeFactory), or this
 * Node layer for configs that tests build by hand.
 */
export function toolRuntimeFactory(config: { runtimeFactory?: RuntimeFactory }): RuntimeFactory {
  // mutation-equivalent: runtimeFactory is a RuntimeFactory object or undefined, so ?? and || agree
  return config.runtimeFactory ?? nodeRuntimeFactory;
}

/** StoresLive provides it, so the app always gets the Node layer. */
export const RuntimeFactoryNode = Layer.succeed(RuntimeFactoryTag)(nodeRuntimeFactory);
