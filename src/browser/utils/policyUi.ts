import { SUPPORTED_PROVIDERS, type ProviderName } from "@/common/constants/providers";
import { RUNTIME_MODE, type ParsedRuntime, type RuntimeMode } from "@/common/types/runtime";
import type { EffectivePolicy, PolicyRuntimeId } from "@/common/orpc/types";
import {
  getCustomProviderIds,
  type ProvidersConfigWithProviderType,
} from "@/common/utils/providers/customProviders";

// Model-string/policy predicates moved to @/common so the selectable-models
// pipeline (shared with the backend models_list tool) can use them; re-exported
// here to keep existing browser importers unchanged.
export {
  isGatewayModelAccessibleForUi,
  isModelAllowedByPolicy,
  parseModelString,
} from "@/common/utils/policy/modelPolicy";

export function getAllowedProvidersForUi(policy: EffectivePolicy | null): ProviderName[];
export function getAllowedProvidersForUi(
  policy: EffectivePolicy | null,
  providersConfig: ProvidersConfigWithProviderType | null | undefined
): string[];
export function getAllowedProvidersForUi(
  policy: EffectivePolicy | null,
  providersConfig?: ProvidersConfigWithProviderType | null
): string[] {
  const customProviders = providersConfig ? getCustomProviderIds(providersConfig) : [];
  const access = policy?.providerAccess;
  if (access == null) {
    return Array.from(new Set([...SUPPORTED_PROVIDERS, ...customProviders]));
  }

  const allowed = new Set(access.map((p) => p.id));
  return Array.from(
    new Set([
      ...SUPPORTED_PROVIDERS.filter((p) => allowed.has(p)),
      ...customProviders.filter((p) => allowed.has(p)),
    ])
  );
}

export function getPolicyRuntimeIdFromParsedRuntime(runtime: ParsedRuntime): PolicyRuntimeId {
  if (runtime.mode === RUNTIME_MODE.SSH) {
    return runtime.coder ? "ssh+coder" : "ssh";
  }

  return runtime.mode;
}

export function isParsedRuntimeAllowedByPolicy(
  policy: EffectivePolicy | null,
  runtime: ParsedRuntime
): boolean {
  const allowedRuntimes = policy?.runtimes;
  if (allowedRuntimes == null) {
    return true;
  }

  return allowedRuntimes.includes(getPolicyRuntimeIdFromParsedRuntime(runtime));
}

export function getAllowedRuntimeModesForUi(policy: EffectivePolicy | null): {
  /** null means "allow all modes" */
  allowedModes: RuntimeMode[] | null;
  /** true when policy allows plain host SSH */
  allowSshHost: boolean;
  /** true when policy allows SSH backed by a Coder workspace */
  allowSshCoder: boolean;
} {
  const allowedRuntimes = policy?.runtimes;
  if (allowedRuntimes == null) {
    return { allowedModes: null, allowSshHost: true, allowSshCoder: true };
  }

  const allowSshHost = allowedRuntimes.includes("ssh");
  const allowSshCoder = allowedRuntimes.includes("ssh+coder");

  const allowedModes: RuntimeMode[] = [];
  if (allowedRuntimes.includes("local")) {
    allowedModes.push(RUNTIME_MODE.LOCAL);
  }
  if (allowedRuntimes.includes("worktree")) {
    allowedModes.push(RUNTIME_MODE.WORKTREE);
  }
  if (allowSshHost || allowSshCoder) {
    allowedModes.push(RUNTIME_MODE.SSH);
  }
  if (allowedRuntimes.includes("docker")) {
    allowedModes.push(RUNTIME_MODE.DOCKER);
  }
  if (allowedRuntimes.includes("devcontainer")) {
    allowedModes.push(RUNTIME_MODE.DEVCONTAINER);
  }

  return { allowedModes, allowSshHost, allowSshCoder };
}
