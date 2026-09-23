import { describe, expect, test } from "bun:test";
import { SUPPORTED_PROVIDERS } from "@/common/constants/providers";
import { TYPESAFE_PROVIDER_KEY } from "@/constants/autoModelRouting";
import { isValidCustomProviderId } from "@/common/utils/providers/customProviders";
import { EffectivePolicySchema, PolicyFileSchema } from "./policy";

function policyFileWithProvider(id: string): unknown {
  return {
    policy_format_version: "0.1",
    provider_access: [{ id }],
  };
}

describe("policy provider ids", () => {
  test("parses custom provider ids in provider_access", () => {
    for (const id of ["local-vllm", "llama_cpp"]) {
      expect(PolicyFileSchema.safeParse(policyFileWithProvider(id)).success).toBe(true);
    }
  });

  test("rejects invalid provider ids in provider_access", () => {
    for (const id of ["BAD.id", "__proto__", "with space", "with:colon", ""]) {
      expect(PolicyFileSchema.safeParse(policyFileWithProvider(id)).success).toBe(false);
    }
  });

  test("accepts the auto-routing classifier id even though it is not a custom provider", () => {
    // An enforced provider_access must be able to authorize the classifier, while the id
    // stays unavailable for custom provider creation.
    expect(isValidCustomProviderId(TYPESAFE_PROVIDER_KEY)).toBe(false);
    expect(PolicyFileSchema.safeParse(policyFileWithProvider(TYPESAFE_PROVIDER_KEY)).success).toBe(
      true
    );
  });

  test("continues to parse built-in provider ids", () => {
    for (const id of SUPPORTED_PROVIDERS) {
      expect(PolicyFileSchema.safeParse(policyFileWithProvider(id)).success).toBe(true);
    }
  });

  test("parses custom provider ids in effective policy provider access", () => {
    const parsed = EffectivePolicySchema.safeParse({
      policyFormatVersion: "0.1",
      providerAccess: [
        {
          id: "local-vllm",
          forcedBaseUrl: "http://localhost:8000/v1",
          allowedModels: ["llama-3"],
        },
      ],
      mcp: { allowUserDefined: { stdio: true, remote: true } },
      runtimes: null,
    });

    expect(parsed.success).toBe(true);
  });
});
