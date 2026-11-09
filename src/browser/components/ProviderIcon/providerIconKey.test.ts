import { describe, expect, test } from "bun:test";
import { hasProviderIcon } from "./ProviderIcon";
import {
  resolveProviderIconKey,
  type ProviderIconConfig,
  type ProviderIconKey,
} from "./providerIconKey";

const cases: Array<[string, string, ProviderIconConfig | null, ProviderIconKey]> = [
  [
    "built-in keeps its icon on a local URL",
    "openai",
    { baseUrl: "http://localhost:11434/v1" },
    "openai",
  ],
  ["id omlx", "omlx", { baseUrl: "http://127.0.0.1:8000/v1" }, "omlx"],
  ["id containing ollama", "my-ollama", { baseUrl: "https://api.example.com/v1" }, "ollama"],
  ["ollama-server is ollama, not llama.cpp", "ollama-server", null, "ollama"],
  ["id lm-studio", "lm-studio", null, "lmstudio"],
  ["displayName LM Studio", "desk", { displayName: "LM Studio" }, "lmstudio"],
  ["id llama_cpp", "llama_cpp", null, "llamacpp"],
  ["id llama-server", "llama-server", null, "llamacpp"],
  ["id vllm", "vllm", null, "vllm"],
  ["id local-vllm", "local-vllm", { baseUrl: "http://localhost:8001/v1" }, "vllm"],
  ["hostname match", "box", { baseUrl: "http://omlx.example.com/v1" }, "omlx"],
  ["devllm is not vllm", "devllm", { baseUrl: "https://api.example.com/v1" }, "custom"],
  ["ollama port on any host", "remote", { baseUrl: "https://api.example.com:11434/v1" }, "ollama"],
  ["lm studio port", "desk", { baseUrl: "http://localhost:1234/v1" }, "lmstudio"],
  ["8000 on loopback is only local", "box", { baseUrl: "http://127.0.0.1:8000/v1" }, "local"],
  ["localhost", "box", { baseUrl: "http://localhost:8080" }, "local"],
  ["ipv6 loopback", "box", { baseUrl: "http://[::1]:8080" }, "local"],
  ["ipv6 unique local", "box", { baseUrl: "http://[fd00::1]:8080" }, "local"],
  ["public ipv6", "box", { baseUrl: "http://[2001:db8::1]:8080" }, "custom"],
  ["0.0.0.0", "box", { baseUrl: "http://0.0.0.0:8000/v1" }, "local"],
  ["192.168", "box", { baseUrl: "http://192.168.1.20:8000" }, "local"],
  ["10/8", "box", { baseUrl: "http://10.0.0.5:8000" }, "local"],
  ["172.16/12", "box", { baseUrl: "http://172.20.0.2:8000" }, "local"],
  ["tailscale CGNAT", "box", { baseUrl: "http://100.100.1.2:8000" }, "local"],
  ["mdns .local", "box", { baseUrl: "http://box.local:8000" }, "local"],
  ["docker internal", "box", { baseUrl: "http://host.docker.internal:8000" }, "local"],
  ["tailnet name", "box", { baseUrl: "https://gpu.tail1234.ts.net/v1" }, "local"],
  ["single-label host", "box", { baseUrl: "http://gpu-box:8000/v1" }, "local"],
  ["public host", "proxy", { baseUrl: "https://api.example.com/v1" }, "custom"],
  ["172.32 is public", "box", { baseUrl: "http://172.32.0.1:8000" }, "custom"],
  ["localllm id on public host", "localllm", { baseUrl: "https://api.example.com/v1" }, "local"],
  [
    "hostname alone does not trigger the name rule",
    "box",
    { baseUrl: "https://localhub.example.com" },
    "custom",
  ],
  [
    "baseUrlResolved wins over baseUrl",
    "box",
    { baseUrl: "https://api.example.com/v1", baseUrlResolved: "http://127.0.0.1:1234/v1" },
    "lmstudio",
  ],
  ["invalid URL falls back to names", "my-ollama", { baseUrl: "not a url" }, "ollama"],
];

describe("resolveProviderIconKey", () => {
  test.each(cases)("%s", (_name, provider, config, expected) => {
    expect(resolveProviderIconKey(provider, config)).toBe(expected);
  });
});

describe("hasProviderIcon", () => {
  // ConfiguredProvidersBar shows the provider's name instead when this is false.
  test.each<[string, string, ProviderIconConfig | null, boolean]>([
    ["recognized runtime", "lm-studio", null, true],
    ["generic local endpoint", "box", { baseUrl: "http://127.0.0.1:8000/v1" }, false],
    ["generic custom endpoint", "proxy", { baseUrl: "https://api.example.com/v1" }, false],
  ])("%s", (_name, provider, config, expected) => {
    expect(hasProviderIcon(provider, config)).toBe(expected);
  });
});
