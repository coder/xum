import type { TestEnvironment } from "../setup";
import { cleanupTestEnvironment, createTestEnvironment } from "../setup";
import { DEFAULT_AUTO_MODEL_ROUTING_TIERS } from "@/common/types/autoModelRouting";
import {
  AUTO_MODEL_ROUTING_MAX_DESCRIPTION_CHARS,
  DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL,
} from "@/constants/autoModelRouting";

describe("config.updateAutoModelRouting", () => {
  let env: TestEnvironment;

  beforeAll(async () => {
    env = await createTestEnvironment();
  });

  afterAll(async () => {
    if (env) {
      await cleanupTestEnvironment(env);
    }
  });

  it("serves the default tiers and evaluation model when nothing is persisted", async () => {
    const cfg = await env.orpc.config.getConfig();
    expect(cfg.autoModelRouting.tiers).toEqual(DEFAULT_AUTO_MODEL_ROUTING_TIERS);
    expect(cfg.autoModelRouting.evaluationModel).toBe(DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL);
    expect(env.config.loadConfigOrDefault().autoModelRouting).toBeUndefined();
  });

  it("persists normalized tiers through update -> load -> getConfig", async () => {
    await env.orpc.config.updateAutoModelRouting({
      autoModelRouting: {
        tiers: [
          { id: "quick", label: "Quick", description: "Small asks", model: "openai:gpt-5.5-mini" },
          {
            id: "deep",
            label: "Deep",
            description: "Large asks",
            model: "anthropic:claude-opus-4-6",
            thinkingLevel: "high",
          },
          // Duplicate id: dropped, first occurrence wins.
          { id: "quick", label: "Dup", description: "Dup" },
        ],
        evaluationModel: "anthropic:claude-haiku-4-5",
      },
    });

    const expected = {
      evaluationModel: "anthropic:claude-haiku-4-5",
      tiers: [
        { id: "quick", label: "Quick", description: "Small asks", model: "openai:gpt-5.5-mini" },
        {
          id: "deep",
          label: "Deep",
          description: "Large asks",
          model: "anthropic:claude-opus-4-6",
          thinkingLevel: "high",
        },
      ],
    };
    expect(env.config.loadConfigOrDefault().autoModelRouting).toEqual(expected);
    const cfg = await env.orpc.config.getConfig();
    expect(cfg.autoModelRouting).toEqual(expected);
  });

  it("rejects malformed tiers at the IPC boundary and falls back to defaults on disk", async () => {
    await expect(
      env.orpc.config.updateAutoModelRouting({
        autoModelRouting: {
          tiers: [
            { id: "Bad Id", label: "x", description: "y" },
            { id: "ok", label: "x", description: "y", model: "not-a-model" },
          ],
        },
      })
    ).rejects.toThrow();

    // A hand-edited config with too few valid tiers normalizes to the default tiers
    // while keeping its valid evaluation model; an unsupported evaluation model
    // normalizes to the default evaluator independently.
    await env.config.editConfig((config) => ({
      ...config,
      autoModelRouting: {
        tiers: [{ id: "only", label: "Only", description: "one valid tier" }],
        evaluationModel: "google:gemini-3.5-flash-lite",
      },
    }));
    const cfg = await env.orpc.config.getConfig();
    expect(cfg.autoModelRouting.tiers).toEqual(DEFAULT_AUTO_MODEL_ROUTING_TIERS);
    expect(cfg.autoModelRouting.evaluationModel).toBe("google:gemini-3.5-flash-lite");

    await expect(
      env.orpc.config.updateAutoModelRouting({
        autoModelRouting: {
          tiers: [...DEFAULT_AUTO_MODEL_ROUTING_TIERS],
          evaluationModel: "coder:openai/gpt-5",
        },
      })
    ).rejects.toThrow();
    await env.config.editConfig((config) => ({
      ...config,
      autoModelRouting: {
        tiers: [...DEFAULT_AUTO_MODEL_ROUTING_TIERS],
        evaluationModel: "coder:openai/gpt-5",
      },
    }));
    expect((await env.orpc.config.getConfig()).autoModelRouting.evaluationModel).toBe(
      DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL
    );
  });

  it("drops a hand-edited tier whose description exceeds the cap", async () => {
    const oversized = "x".repeat(AUTO_MODEL_ROUTING_MAX_DESCRIPTION_CHARS + 1);
    await env.config.editConfig((config) => ({
      ...config,
      autoModelRouting: {
        tiers: [
          { id: "easy", label: "Easy", description: "short" },
          {
            id: "hard",
            label: "Hard",
            description: "x".repeat(AUTO_MODEL_ROUTING_MAX_DESCRIPTION_CHARS),
          },
          { id: "huge", label: "Huge", description: oversized },
        ],
        evaluationModel: DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL,
      },
    }));
    const cfg = await env.orpc.config.getConfig();
    expect(cfg.autoModelRouting.tiers.map((tier) => tier.id)).toEqual(["easy", "hard"]);
  });

  it("caps the tier list at eight", async () => {
    const tiers = Array.from({ length: 9 }, (_, index) => ({
      id: `t${index}`,
      label: `Tier ${index}`,
      description: `Tier ${index}`,
    }));
    await expect(
      env.orpc.config.updateAutoModelRouting({ autoModelRouting: { tiers } })
    ).rejects.toThrow();
  });
});
