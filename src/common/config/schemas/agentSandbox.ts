import { z } from "zod";
import { DEFAULT_ALLOWED_HOSTS } from "@/common/constants/agentSandbox";

export const AgentSandboxNetworkSchema = z.enum(["allowlist", "open", "loopback"]);
export type AgentSandboxNetwork = z.infer<typeof AgentSandboxNetworkSchema>;

/** config.json `agentSandbox`, and `projects[].agentSandbox` for one project. */
export const AgentSandboxConfigSchema = z.object({
  /** Absent = off. */
  enabled: z.boolean().optional(),
  /** Absent = "allowlist". */
  network: AgentSandboxNetworkSchema.optional(),
  /** Absent = DEFAULT_ALLOWED_HOSTS. */
  allowedHosts: z.array(z.string()).optional(),
  /** Extra folders that sandboxed commands may write, for example ~/.gradle. */
  extraWritePaths: z.array(z.string()).optional(),
  /** Extra files and folders that sandboxed commands may read, for example ~/.npmrc. */
  extraReadPaths: z.array(z.string()).optional(),
});
export type AgentSandboxConfig = z.infer<typeof AgentSandboxConfigSchema>;

/** One command's sandbox setting after the project override is merged into the global one. */
export interface ResolvedAgentSandboxSettings {
  enabled: boolean;
  network: AgentSandboxNetwork;
  allowedHosts: string[];
  extraWritePaths: string[];
  extraReadPaths: string[];
}

const AGENT_SANDBOX_FIELDS = AgentSandboxConfigSchema.keyof().options;

/**
 * The valid fields of a stored `agentSandbox` value, or undefined when it has none. Fail closed:
 * an invalid field is dropped on its own, so a typo elsewhere never turns an enabled sandbox off.
 */
export function salvageAgentSandbox(value: unknown): AgentSandboxConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const salvaged: Record<string, unknown> = {};
  for (const field of AGENT_SANDBOX_FIELDS) {
    if (record[field] === undefined) continue;
    const parsed = AgentSandboxConfigSchema.shape[field].safeParse(record[field]);
    if (parsed.success) salvaged[field] = parsed.data;
  }
  // A malformed `enabled` that still reads as true keeps the sandbox on.
  if (salvaged.enabled === undefined && record.enabled === true) salvaged.enabled = true;
  const result = AgentSandboxConfigSchema.parse(salvaged);
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Each field the project sets overrides that global field. */
export function resolveAgentSandboxSettings(
  global: AgentSandboxConfig | undefined,
  project: AgentSandboxConfig | undefined
): ResolvedAgentSandboxSettings {
  const pick = <K extends keyof AgentSandboxConfig>(key: K): AgentSandboxConfig[K] =>
    project?.[key] ?? global?.[key];
  return {
    enabled: pick("enabled") === true,
    network: pick("network") ?? "allowlist",
    allowedHosts: [...(pick("allowedHosts") ?? DEFAULT_ALLOWED_HOSTS)],
    extraWritePaths: [...(pick("extraWritePaths") ?? [])],
    extraReadPaths: [...(pick("extraReadPaths") ?? [])],
  };
}
