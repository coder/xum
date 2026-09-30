import { z } from "zod";

export const AgentIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/);

export const RuntimeEnablementIdSchema = z.enum([
  "local",
  "worktree",
  "ssh",
  "coder",
  "docker",
  "devcontainer",
]);
