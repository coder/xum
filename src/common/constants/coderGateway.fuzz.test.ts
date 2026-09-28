/**
 * Fuzz tests for Coder AI Gateway catalog parsing and model-ID mapping.
 *
 * The provider list comes from a remote deployment (or hand-edited config),
 * and gateway model IDs come from catalogs — all attacker-influenceable.
 * Parsers must be total (never throw), and identity mappers must be
 * consistent: to→from roundtrips must not corrupt model identity.
 */
import { describe, test, expect } from "bun:test";
import {
  parseCoderGatewayProviders,
  resolveCoderGatewayProvider,
  resolveCoderWireCanonicalModel,
  resolveCoderMetadataCanonicalModel,
  coderGatewayWireProtocol,
  bedrockOpenAIModelId,
} from "./coderOAuth";
import { PROVIDER_DEFINITIONS, type ProviderName } from "./providers";
import {
  mulberry32,
  randomFragmentString,
  randomHostileValue,
  pick,
} from "@/common/utils/testing/fuzzHelpers";

const SEED = 0xc0de4;
const ITERATIONS = 3000;

describe("coder gateway fuzz", () => {
  test(`catalog parsing and wire resolution are total (seed=${SEED})`, () => {
    const rng = mulberry32(SEED);
    for (let i = 0; i < ITERATIONS; i++) {
      const providers = parseCoderGatewayProviders(randomHostileValue(rng));
      for (const provider of providers) {
        expect(typeof provider.name).toBe("string");
        expect(provider.name.length).toBeGreaterThan(0);
        expect(typeof provider.type).toBe("string");
      }

      const name = randomFragmentString(rng, 3);
      const resolved = resolveCoderGatewayProvider(name, providers, providers);
      if (resolved) {
        expect(typeof resolved.type).toBe("string");
      }

      const wire = coderGatewayWireProtocol(randomFragmentString(rng, 2));
      expect([null, "anthropic", "openai-responses", "openai-chat"]).toContain(wire);

      const metadata = {
        discoveredProviders: randomHostileValue(rng),
        additionalProviders: randomHostileValue(rng),
      };
      const gatewayModelId = randomFragmentString(rng);
      const wireCanonical = resolveCoderWireCanonicalModel(gatewayModelId, metadata);
      if (wireCanonical) {
        expect(["anthropic", "openai"]).toContain(wireCanonical.origin);
        expect(wireCanonical.modelId.length).toBeGreaterThan(0);
      }
      const metadataCanonical = resolveCoderMetadataCanonicalModel(gatewayModelId, metadata);
      if (metadataCanonical !== null) {
        // Catalog identities must be well-formed provider:model strings.
        const colonIndex = metadataCanonical.indexOf(":");
        expect(colonIndex).toBeGreaterThan(0);
        expect(colonIndex).toBeLessThan(metadataCanonical.length - 1);
      }

      // Bedrock is the only model-dependent wire: the wire and metadata
      // identities of a bedrock-typed instance must agree on whether the
      // model is OpenAI-namespaced.
      const bedrockModelId =
        pick(rng, ["", "global.", "us.", "eu-west-1."]) +
        pick(rng, ["openai.", "anthropic.", "amazon.", ""]) +
        randomFragmentString(rng, 2);
      const bedrockGatewayModelId = `mantle/${bedrockModelId}`;
      const bedrockMetadata = { additionalProviders: [{ name: "mantle", type: "bedrock" }] };
      const bedrockWire = resolveCoderWireCanonicalModel(bedrockGatewayModelId, bedrockMetadata);
      const bedrockCanonical = resolveCoderMetadataCanonicalModel(
        bedrockGatewayModelId,
        bedrockMetadata
      );
      const openaiModelId = bedrockModelId ? bedrockOpenAIModelId(bedrockModelId) : null;
      if (openaiModelId != null) {
        expect(coderGatewayWireProtocol("bedrock", bedrockModelId)).toBe("openai-responses");
        expect(bedrockWire).toEqual({
          origin: "openai",
          modelId: bedrockModelId,
          providerType: "bedrock",
        });
        expect(bedrockCanonical).toBe(`openai:${openaiModelId}`);
      } else if (bedrockModelId) {
        expect(coderGatewayWireProtocol("bedrock", bedrockModelId)).toBe("anthropic");
        expect(bedrockWire?.origin).toBe("anthropic");
        expect(bedrockCanonical).toBe(`bedrock:${bedrockModelId}`);
      }
    }
  });

  test.each([
    // Bedrock Mantle serves OpenAI models over /v1/responses and Anthropic
    // models over /v1/messages on the same instance.
    {
      gatewayModelId: "bedrock-mantle-us-east-1/openai.gpt-5.6-sol",
      wire: "openai-responses",
      origin: "openai",
      metadata: "openai:gpt-5.6-sol",
    },
    {
      gatewayModelId: "bedrock-mantle-us-east-1/global.openai.gpt-5.6-sol",
      wire: "openai-responses",
      origin: "openai",
      metadata: "openai:gpt-5.6-sol",
    },
    {
      gatewayModelId: "bedrock-mantle-us-east-1/anthropic.claude-sonnet-5",
      wire: "anthropic",
      origin: "anthropic",
      metadata: "bedrock:anthropic.claude-sonnet-5",
    },
    {
      gatewayModelId: "bedrock-mantle-us-east-1/us.anthropic.claude-opus-5",
      wire: "anthropic",
      origin: "anthropic",
      metadata: "bedrock:us.anthropic.claude-opus-5",
    },
  ] as const)(
    "routes bedrock-typed instance models by namespace: $gatewayModelId",
    ({ gatewayModelId, wire, origin, metadata }) => {
      const providers = {
        additionalProviders: [{ name: "bedrock-mantle-us-east-1", type: "bedrock" }],
      };
      const modelId = gatewayModelId.slice(gatewayModelId.indexOf("/") + 1);
      expect(coderGatewayWireProtocol("bedrock", modelId)).toBe(wire);
      expect(resolveCoderWireCanonicalModel(gatewayModelId, providers)).toEqual({
        origin,
        modelId,
        providerType: "bedrock",
      });
      expect(resolveCoderMetadataCanonicalModel(gatewayModelId, providers)).toBe(metadata);
    }
  );

  test("only bedrock-typed instances route by model namespace", () => {
    // The catalog probe has no model: bedrock keeps its Anthropic default.
    expect(coderGatewayWireProtocol("bedrock")).toBe("anthropic");
    // An OpenAI-namespaced ID on any other type follows the type as before.
    expect(coderGatewayWireProtocol("anthropic", "openai.gpt-5.6-sol")).toBe("anthropic");
    expect(coderGatewayWireProtocol("openai-compat", "openai.gpt-5.6-sol")).toBe("openai-chat");
    const providers = { additionalProviders: [{ name: "claude", type: "anthropic" }] };
    expect(resolveCoderWireCanonicalModel("claude/openai.gpt-5.6-sol", providers)?.origin).toBe(
      "anthropic"
    );
    expect(resolveCoderMetadataCanonicalModel("claude/openai.gpt-5.6-sol", providers)).toBe(
      "anthropic:openai.gpt-5.6-sol"
    );
  });

  test(`gateway model-id mappers roundtrip canonical identities (seed=${SEED})`, () => {
    const rng = mulberry32(SEED + 1);
    const gatewayNames = (Object.keys(PROVIDER_DEFINITIONS) as ProviderName[]).filter(
      (name) => PROVIDER_DEFINITIONS[name].kind === "gateway"
    );
    for (let i = 0; i < ITERATIONS; i++) {
      for (const gateway of gatewayNames) {
        const def = PROVIDER_DEFINITIONS[gateway];
        const from = "fromGatewayModelId" in def ? def.fromGatewayModelId : undefined;
        const to = "toGatewayModelId" in def ? def.toGatewayModelId : undefined;

        // Parsing arbitrary catalog IDs must never throw, and parsed results
        // must have non-empty origins and model ids (empty parts would
        // produce invalid ":model" / "origin:" canonical strings downstream).
        const junkId = randomFragmentString(rng);
        if (from) {
          const parsed = from(junkId);
          if (parsed) {
            expect(parsed.origin.length).toBeGreaterThan(0);
            expect(parsed.modelId.length).toBeGreaterThan(0);
          }
        }

        // Roundtrip: a slash/dot-free origin+model pair must survive to→from
        // whenever the gateway can parse its own encoding.
        if (to && from) {
          const origin = pick(rng, ["anthropic", "openai", "google", "xai"]);
          const modelId = `m${i % 50}-${randomFragmentString(rng, 2).replace(/[/.]/g, "") || "x"}`;
          const encoded = to(origin, modelId);
          const roundtripped = from(encoded);
          if (roundtripped) {
            expect(roundtripped.origin).toBe(origin);
            expect(roundtripped.modelId).toBe(modelId);
          }
        }
      }
    }
  });
});
