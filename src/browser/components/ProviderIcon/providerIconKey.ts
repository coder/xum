import type { ProviderName } from "@/common/constants/providers";
import type { ProviderConfigInfo } from "@/common/orpc/types";
import { isBuiltInProvider } from "@/common/utils/providers/customProviders";

export type LocalRuntimeIconKey = "omlx" | "ollama" | "lmstudio" | "llamacpp" | "vllm";
export type BrandIconKey = ProviderName | LocalRuntimeIconKey;
/** "local": an unrecognized endpoint on this machine or its network; "custom": anything else. */
export type ProviderIconKey = BrandIconKey | "local" | "custom";
export type ProviderIconConfig = Pick<
  ProviderConfigInfo,
  "displayName" | "baseUrl" | "baseUrlResolved"
>;

// Ordered: "ollama" must win before the llama.cpp patterns so "ollama-server" stays Ollama.
const RUNTIME_NAME_PATTERNS: ReadonlyArray<readonly [RegExp, LocalRuntimeIconKey]> = [
  [/omlx/, "omlx"],
  [/ollama/, "ollama"],
  [/lm[\s._-]?studio/, "lmstudio"],
  [/llama[\s._-]?cpp|llama[\s_-]?server/, "llamacpp"],
  [/(?:^|[^a-z0-9])vllm/, "vllm"],
];

// Only ports unique to one runtime: oMLX and vLLM both default to 8000, and llama.cpp
// shares 8080 with many servers, so those are recognized by name only.
const RUNTIME_DEFAULT_PORTS = new Map<string, LocalRuntimeIconKey>([
  ["11434", "ollama"],
  ["1234", "lmstudio"],
]);

const LOCAL_HOST_SUFFIXES = [".localhost", ".local", ".lan", ".internal", ".home.arpa", ".ts.net"];

function isPrivateIPv4(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(hostname);
  if (match == null) {
    return false;
  }
  const a = Number(match[1]);
  const b = Number(match[2]);
  return (
    a === 127 ||
    a === 10 ||
    hostname === "0.0.0.0" ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isLocalNetworkHost(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || LOCAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return true;
  }
  if (hostname.includes(":")) {
    return hostname === "::1" || /^f[cd]/.test(hostname) || /^fe[89ab]/.test(hostname);
  }
  if (isPrivateIPv4(hostname)) {
    return true;
  }
  // Dotless names resolve only on the local network (docker compose services, LAN machines).
  return hostname.length > 0 && !hostname.includes(".");
}

function parseBaseUrl(config: ProviderIconConfig | null | undefined): URL | null {
  const raw = config?.baseUrlResolved ?? config?.baseUrl;
  if (raw == null || raw.length === 0) {
    return null;
  }
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * Picks the icon for a provider. Built-ins keep their own icon; custom providers are matched
 * to a known local runtime by id, display name, base URL hostname, then default port.
 */
export function resolveProviderIconKey(
  provider: string,
  config?: ProviderIconConfig | null
): ProviderIconKey {
  if (isBuiltInProvider(provider)) {
    return provider;
  }

  const url = parseBaseUrl(config);
  const names = [provider, config?.displayName].filter(Boolean).join(" ").toLowerCase();
  const haystack = [names, url?.hostname.toLowerCase()].filter(Boolean).join(" ");

  for (const [pattern, key] of RUNTIME_NAME_PATTERNS) {
    if (pattern.test(haystack)) {
      return key;
    }
  }

  const portKey = url != null ? RUNTIME_DEFAULT_PORTS.get(url.port) : undefined;
  if (portKey != null) {
    return portKey;
  }

  if ((url != null && isLocalNetworkHost(url.hostname)) || names.includes("local")) {
    return "local";
  }
  return "custom";
}

export function isBrandIconKey(key: ProviderIconKey): key is BrandIconKey {
  return key !== "local" && key !== "custom";
}
