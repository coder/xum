import { describe, expect, it } from "bun:test";

import { CODER_GATEWAY_DEFAULT_PROVIDER_NAMES } from "@/common/constants/coderOAuth";
import type { CoderGatewayProvider } from "@/common/constants/coderOAuth";
import {
  catalogRefreshFailureMessage,
  probeCoderGatewayProviders,
  readPriorCoderCatalog,
  reconcileProviderCatalog,
  type PriorCoderCatalog,
} from "./coderGatewayCatalogMerge";

const anthropic: CoderGatewayProvider = { name: "anthropic", type: "anthropic" };
const custom: CoderGatewayProvider = { name: "corp", type: "openai" };

function prior(overrides: Partial<PriorCoderCatalog> = {}): PriorCoderCatalog {
  return { known: true, discovered: [], stale: [], providers: [], ...overrides };
}

describe("probeCoderGatewayProviders", () => {
  it("probes the default names when nothing is stored", () => {
    const probed = probeCoderGatewayProviders(undefined);
    expect(probed.map((provider) => provider.name)).toEqual([
      ...CODER_GATEWAY_DEFAULT_PROVIDER_NAMES,
    ]);
    expect(probed.every((provider) => provider.type === provider.name)).toBe(true);
  });

  it("lets stored discovery replace a default and additionalProviders replace both", () => {
    const probed = probeCoderGatewayProviders({
      discoveredProviders: [
        { name: "anthropic", type: "openai-compat" },
        { name: "corp", type: "anthropic" },
      ],
      additionalProviders: [custom, { name: 3 }],
    });
    const byName = new Map(probed.map((provider) => [provider.name, provider.type]));
    expect(byName.get("anthropic")).toBe("openai-compat");
    expect(byName.get("corp")).toBe("openai");
    // One entry per name: overrides replace, never duplicate.
    expect(probed.length).toBe(new Set(probed.map((provider) => provider.name)).size);
  });
});

describe("readPriorCoderCatalog", () => {
  it("reads the catalog markers and keeps only string IDs", () => {
    expect(
      readPriorCoderCatalog({
        discoveredModels: ["anthropic/a", 7, null, "openai/b"],
        staleDiscoveredModels: ["corp/c", { id: "x" }],
        discoveredProviders: [custom, { name: 3 }],
      })
    ).toEqual({
      known: true,
      discovered: ["anthropic/a", "openai/b"],
      stale: ["corp/c"],
      providers: [custom],
    });
  });

  it("treats a missing or non-array catalog as unknown", () => {
    expect(readPriorCoderCatalog(undefined)).toEqual({
      known: false,
      discovered: [],
      stale: [],
      providers: [],
    });
    expect(readPriorCoderCatalog({ discoveredModels: "anthropic/a" }).known).toBe(false);
  });

  it("knows an empty catalog: an empty list is an authoritative answer", () => {
    expect(readPriorCoderCatalog({ discoveredModels: [] }).known).toBe(true);
  });
});

describe("reconcileProviderCatalog", () => {
  describe("ok", () => {
    it("replaces the provider's entries and persists no metadata under a listing", () => {
      expect(
        reconcileProviderCatalog(
          anthropic,
          { kind: "ok", ids: ["anthropic/new"] },
          prior({ discovered: ["anthropic/old"] }),
          true
        )
      ).toEqual({ ids: ["anthropic/new"], providers: [], inconclusive: false });
    });

    it("on the probe path persists the stored metadata over the probe default", () => {
      const stored = { name: "corp", type: "anthropic" };
      const probed = { name: "corp", type: "corp" };
      expect(
        reconcileProviderCatalog(
          probed,
          { kind: "ok", ids: ["corp/m"] },
          prior({ providers: [stored] }),
          false
        ).providers
      ).toEqual([stored]);
      expect(
        reconcileProviderCatalog(probed, { kind: "ok", ids: [] }, prior(), false).providers
      ).toEqual([probed]);
    });
  });

  describe("error", () => {
    it("carries prior entries under the provider prefix forward", () => {
      expect(
        reconcileProviderCatalog(
          anthropic,
          { kind: "error", reason: "HTTP 502" },
          prior({ discovered: ["anthropic/a", "openai/b", "anthropicx/c"] }),
          true
        )
      ).toEqual({ ids: ["anthropic/a"], providers: [], inconclusive: false });
    });

    it("counts stored metadata as prior state even without prior entries", () => {
      expect(
        reconcileProviderCatalog(
          custom,
          { kind: "error", reason: "HTTP 502" },
          prior({ providers: [custom] }),
          true
        )
      ).toEqual({ ids: [], providers: [], inconclusive: false });
    });

    it("keeps the stored metadata on the probe path", () => {
      expect(
        reconcileProviderCatalog(
          custom,
          { kind: "error", reason: "HTTP 502" },
          prior({ providers: [custom], discovered: ["corp/m"] }),
          false
        )
      ).toEqual({ ids: ["corp/m"], providers: [custom], inconclusive: false });
    });

    it("makes the catalog inconclusive without prior state and keeps stale entries", () => {
      expect(
        reconcileProviderCatalog(
          anthropic,
          { kind: "error", reason: "HTTP 502" },
          prior({ known: false, stale: ["anthropic/s", "openai/t"] }),
          true
        )
      ).toEqual({ ids: ["anthropic/s"], providers: [], inconclusive: true });
    });

    it("is inconclusive for a provider the prior catalog never named", () => {
      expect(
        reconcileProviderCatalog(
          anthropic,
          { kind: "error", reason: "HTTP 502" },
          prior({ discovered: ["openai/b"] }),
          true
        )
      ).toEqual({ ids: [], providers: [], inconclusive: true });
    });

    it("drops entries of a provider whose type changed under a listing", () => {
      const retyped = { name: "corp", type: "anthropic" };
      expect(
        reconcileProviderCatalog(
          retyped,
          { kind: "error", reason: "HTTP 502" },
          prior({ providers: [custom], discovered: ["corp/m"], stale: ["corp/s"] }),
          true
        )
      ).toEqual({ ids: [], providers: [], inconclusive: true });
    });

    it("treats a name without stored metadata as its own type", () => {
      // No stored metadata: the effective prior type is the name, so a listed
      // instance named "anthropic" of another type has no carry-forward state.
      expect(
        reconcileProviderCatalog(
          { name: "anthropic", type: "openai" },
          { kind: "error", reason: "HTTP 502" },
          prior({ discovered: ["anthropic/a"] }),
          true
        )
      ).toEqual({ ids: [], providers: [], inconclusive: true });
    });
  });

  describe("unavailable", () => {
    it("drops the provider under an authoritative listing", () => {
      expect(
        reconcileProviderCatalog(
          custom,
          { kind: "unavailable" },
          prior({ providers: [custom], discovered: ["corp/m"] }),
          true
        )
      ).toEqual({ ids: [], providers: [], inconclusive: false });
    });

    it("drops a probe-default name without stored metadata", () => {
      expect(
        reconcileProviderCatalog(
          anthropic,
          { kind: "unavailable" },
          prior({ discovered: ["anthropic/a"] }),
          false
        )
      ).toEqual({ ids: [], providers: [], inconclusive: false });
    });

    it("keeps a recorded instance and its prior entries on the probe path", () => {
      expect(
        reconcileProviderCatalog(
          custom,
          { kind: "unavailable" },
          prior({ providers: [custom], discovered: ["corp/m", "openai/x"] }),
          false
        )
      ).toEqual({ ids: ["corp/m"], providers: [custom], inconclusive: false });
    });

    it("keeps only stale entries, inconclusively, when the prior catalog is unknown", () => {
      expect(
        reconcileProviderCatalog(
          custom,
          { kind: "unavailable" },
          prior({ known: false, providers: [custom], stale: ["corp/s"] }),
          false
        )
      ).toEqual({ ids: ["corp/s"], providers: [custom], inconclusive: true });
    });
  });
});

describe("catalogRefreshFailureMessage", () => {
  // #5659: name each failing provider and its last failure.
  it("names the failing providers and their status", () => {
    const results = [
      { provider: anthropic, result: { kind: "error", reason: "HTTP 502" } as const },
      { provider: custom, result: { kind: "ok", ids: [] } as const },
    ];
    expect(catalogRefreshFailureMessage(results, false)).toBe(
      "Model discovery failed for AI Gateway providers: anthropic (HTTP 502); try refreshing again"
    );
  });

  // A refresh can be inconclusive without a failed fetch: no empty list in the message.
  it("keeps the generic message when no fetch failed", () => {
    const results = [{ provider: custom, result: { kind: "unavailable" } as const }];
    expect(catalogRefreshFailureMessage(results, false)).toBe(
      "Model discovery failed for at least one AI Gateway provider; try refreshing again"
    );
  });
});
