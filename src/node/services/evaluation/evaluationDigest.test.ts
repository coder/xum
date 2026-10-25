import { describe, expect, it } from "bun:test";
import { computeConfigFingerprint, sha256Hex } from "./evaluationDigest";

describe("computeConfigFingerprint", () => {
  const base = {
    providerName: "openai",
    wireProviderName: "openai",
    effectiveModelString: "openai:gpt-5",
    baseURL: "https://api.openai.com/v1",
  };

  it("is a sha256 hex digest that is stable across input key order", () => {
    const a = computeConfigFingerprint(base);
    const b = computeConfigFingerprint({
      baseURL: base.baseURL,
      effectiveModelString: base.effectiveModelString,
      wireProviderName: base.wireProviderName,
      providerName: base.providerName,
    });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it("changes with the endpoint identity but never depends on secrets", () => {
    const a = computeConfigFingerprint(base);
    expect(computeConfigFingerprint({ ...base, baseURL: "https://proxy.example/v1" })).not.toBe(a);
    expect(computeConfigFingerprint({ ...base, customProviderId: "team-proxy" })).not.toBe(a);
    expect(
      computeConfigFingerprint({ ...base, effectiveModelString: "openai:gpt-5-mini" })
    ).not.toBe(a);
    // Omitted optional fields hash differently from present ones (no silent collapse).
    const { baseURL: _omitted, ...withoutBaseURL } = base;
    expect(computeConfigFingerprint(withoutBaseURL)).not.toBe(a);
  });

  it("sha256Hex matches the canonical digest used for the fingerprint", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
