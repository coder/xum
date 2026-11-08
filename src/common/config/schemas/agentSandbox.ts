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
  const result = AgentSandboxConfigSchema.parse(salvaged);
  return Object.keys(result).length > 0 ? result : undefined;
}

const field = AgentSandboxConfigSchema.shape;

/**
 * A save of some `agentSandbox` fields: a value sets its field, null removes it (so it takes its
 * default), and an absent field keeps its saved value. Settings sends only the field it changes,
 * so two windows, or a window and a hand edit, that change different fields keep both changes.
 */
export const AgentSandboxPatchSchema = z.object({
  enabled: field.enabled.unwrap().nullish(),
  network: field.network.unwrap().nullish(),
  allowedHosts: field.allowedHosts.unwrap().nullish(),
  extraWritePaths: field.extraWritePaths.unwrap().nullish(),
  extraReadPaths: field.extraReadPaths.unwrap().nullish(),
});
export type AgentSandboxPatch = z.infer<typeof AgentSandboxPatchSchema>;

/** The saved value `current` with `patch` applied, or undefined when no field is left. */
export function patchAgentSandbox(
  current: AgentSandboxConfig | undefined,
  patch: AgentSandboxPatch
): AgentSandboxConfig | undefined {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return salvageAgentSandbox(next);
}

/** Each field the project sets overrides that global field. */
export function resolveAgentSandboxSettings(
  global: AgentSandboxConfig | undefined,
  project: AgentSandboxConfig | undefined
): ResolvedAgentSandboxSettings {
  const pick = <K extends keyof AgentSandboxConfig>(
    key: K,
    fallback: NonNullable<AgentSandboxConfig[K]>
  ): NonNullable<AgentSandboxConfig[K]> =>
    // mutation-equivalent: the only falsy set value is `enabled: false`, whose fallback is false
    project?.[key] ?? global?.[key] ?? fallback;
  return {
    enabled: pick("enabled", false),
    network: pick("network", "allowlist"),
    allowedHosts: [...pick("allowedHosts", [...DEFAULT_ALLOWED_HOSTS])],
    extraWritePaths: [...pick("extraWritePaths", [])],
    extraReadPaths: [...pick("extraReadPaths", [])],
  };
}
