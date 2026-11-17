import { z } from "zod";
import {
  AgentSandboxConfigSchema,
  AgentSandboxPatchSchema,
} from "@/common/config/schemas/agentSandbox";

/**
 * Whether the backend can sandbox agent commands. The browser can run on another OS than the
 * backend, so only the backend can tell.
 */
export const AgentSandboxSupportSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("supported") }),
  z.object({
    state: z.literal("unsupported"),
    reason: z.string(),
    /**
     * True on a Mac without sandbox-exec: a setting that is on makes commands fail rather
     * than run without the sandbox. Elsewhere the sandbox does not apply and they run.
     */
    failsClosed: z.boolean(),
  }),
]);
export type AgentSandboxSupport = z.infer<typeof AgentSandboxSupportSchema>;

const AgentSandboxStateSchema = z.object({
  /** The global setting as saved; an absent field takes its default. */
  global: AgentSandboxConfigSchema,
  /** The override of each project that has one, keyed by project path. */
  projects: z.record(z.string(), AgentSandboxConfigSchema),
  support: AgentSandboxSupportSchema,
});
export type AgentSandboxState = z.infer<typeof AgentSandboxStateSchema>;

export const agentSandbox = {
  get: {
    input: z.void(),
    output: AgentSandboxStateSchema,
  },
  /** Saves fields of the global setting over the latest saved value. */
  set: {
    input: AgentSandboxPatchSchema,
    output: AgentSandboxStateSchema,
  },
  /** Saves fields of one project's override; a removed field follows the global setting. */
  setProject: {
    input: z.object({ projectPath: z.string(), sandbox: AgentSandboxPatchSchema }),
    output: AgentSandboxStateSchema,
  },
};
