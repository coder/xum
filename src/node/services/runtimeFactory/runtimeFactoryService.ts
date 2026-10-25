/**
 * Every runtime that agent-loop code builds, as one service (phase 5 of the agent-loop refactor),
 * so the in-memory loop can give its FakeRuntime instead of a concrete runtime. Each member has the
 * signature of today's function, and the Node layer (nodeRuntimeFactory.ts) calls it.
 *
 * Type-only imports keep this module free of runtime dependencies, so di/tags.ts can import it
 * without a cycle.
 */
import type { RuntimeConfig } from "@/common/types/runtime";
import type { Runtime } from "@/node/runtime/Runtime";
import type { HostFiles } from "@/node/services/hostFiles/hostFiles";
import type { createRuntime } from "@/node/runtime/runtimeFactory";
import type {
  createRuntimeContextForWorkspace,
  createRuntimeForWorkspace,
} from "@/node/runtime/runtimeHelpers";

/** The runtime of a multi-project workspace: one runtime per project in one container. */
export interface MultiProjectRuntimeInput {
  runtimeConfig: RuntimeConfig;
  /** The container root of the projects' checkouts. */
  srcBaseDir: string;
  workspaceName: string;
  projects: ReadonlyArray<{
    projectPath: string;
    projectName: string;
    /** The persisted checkout of an SSH project. */
    workspacePath?: string;
  }>;
}

export interface RuntimeFactory {
  createRuntime: typeof createRuntime;
  createRuntimeForWorkspace: typeof createRuntimeForWorkspace;
  createRuntimeContextForWorkspace: typeof createRuntimeContextForWorkspace;
  /** The multi-project branch of AIService.createWorkspaceRuntimeContext. */
  createMultiProjectRuntime(input: MultiProjectRuntimeInput): Runtime;
  /** Host-local I/O on a path: `new LocalRuntime(path)`. */
  createLocalRuntime(path: string): Runtime;
  /**
   * The host filesystem that the local runtimes see. The host-local reads beside a runtime
   * (plugin discovery, containment checks, skill and agent listings) go through it (phase 5).
   */
  readonly hostFiles: HostFiles;
}
