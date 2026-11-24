import { z } from "zod";

/**
 * Isolation is split into two axes that compose:
 * - Project isolation: where the project's code lives and commands run (this machine, an SSH host,
 *   or a Coder workspace reached over SSH).
 * - Workspace isolation: how each workspace is separated from its siblings on that machine.
 *
 * These replace the single flat "runtime" choice in the UX and in config (`defaultIsolation`
 * supersedes `defaultRuntime`; see src/common/types/isolation.ts for the mapping).
 */
export const ProjectIsolationSchema = z.enum(["local", "ssh", "coder"]);

export const WorkspaceIsolationSchema = z.enum(["none", "worktree", "docker", "devcontainer"]);

export const IsolationChoiceSchema = z.object({
  project: ProjectIsolationSchema,
  workspace: WorkspaceIsolationSchema,
});
