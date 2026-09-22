import type { ProviderName } from "@/common/constants/providers";

// Discovery is interactive and read-only; bound the entire catalog, not each page.
export const MODEL_DISCOVERY_LIMITS = {
  timeoutMs: 10_000,
  pages: 10,
  pageSize: 1000,
  items: 10_000,
  bytes: 2 * 1024 * 1024,
} as const;

// Match the inference adapters; compatible APIs do not share a universal /v1 prefix.
export const MODEL_DISCOVERY_BASE_URLS: Partial<Record<ProviderName, string>> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  xai: "https://api.x.ai/v1",
  deepseek: "https://api.deepseek.com",
  moonshotai: "https://api.moonshot.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://127.0.0.1:11434/api",
  zai: "https://api.z.ai/api/paas/v4",
  "github-copilot": "https://api.githubcopilot.com",
  "mux-gateway": "https://gateway.mux.coder.com/api/v1/ai-gateway/v1/ai",
};

export const COPILOT_MODEL_DISCOVERY_INTENT = "conversation-edits";
export const GATEWAY_MODEL_DISCOVERY_HEADERS = {
  "ai-gateway-protocol-version": "0.0.1",
  "ai-gateway-auth-method": "api-key",
} as const;
