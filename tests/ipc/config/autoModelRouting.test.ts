import type { TestEnvironment } from "../setup";
import { cleanupTestEnvironment, createTestEnvironment } from "../setup";
import { DEFAULT_AUTO_MODEL_ROUTING_TIERS } from "@/common/types/autoModelRouting";

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

  it("serves the default tiers when nothing is persisted", async () => {
    const cfg = await env.orpc.config.getConfig();
    expect(cfg.autoModelRouting.tiers).toEqual(DEFAULT_AUTO_MODEL_ROUTING_TIERS);
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
      },
    });

    const expected = {
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

    // A hand-edited config with too few valid tiers normalizes to the defaults.
    await env.config.editConfig((config) => ({
      ...config,
      autoModelRouting: {
        tiers: [{ id: "only", label: "Only", description: "one valid tier" }],
      },
    }));
    const cfg = await env.orpc.config.getConfig();
    expect(cfg.autoModelRouting.tiers).toEqual(DEFAULT_AUTO_MODEL_ROUTING_TIERS);
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
