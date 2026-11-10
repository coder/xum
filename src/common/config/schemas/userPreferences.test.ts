import { describe, expect, test } from "bun:test";

import { MEMORY_DREAM_EDIT_LIMIT_MAX } from "@/common/constants/memory";
import { DEFAULT_TERMINAL_BADGE_CONFIG } from "@/common/constants/storage";
import {
  UserPreferencesSchema,
  normalizeUserPreferences,
  pruneUserPreferences,
} from "./userPreferences";

describe("UserPreferencesSchema", () => {
  test("accepts the semantic preference shape", () => {
    const result = UserPreferencesSchema.safeParse({
      appearance: {
        theme: "flexoki-dark",
        transcriptDensity: "hyper",
        bashCollapsedSummaryMode: "intent",
        terminalFontConfig: { fontFamily: "Geist Mono", fontSize: 14 },
        editorConfig: { editor: "cursor" },
        vimEnabled: true,
      },
      navigation: {
        launchBehavior: "last-workspace",
        projectOrder: ["/repo/a", "/repo/b"],
      },
      ai: {
        globalDefaults: { agentId: "exec", thinkingLevel: "high" },
        projectDefaults: {
          "/repo/a": { agentId: "plan", model: "openai:gpt-4.1", thinkingLevel: "medium" },
        },
        providerOptions: {
          anthropic: { disableBetaFeatures: true },
          google: { thinkingConfig: { includeThoughts: true } },
        },
        autoCompactionThresholdByModel: { "openai:gpt-4.1": 70 },
      },
      workspaceCreation: {
        byProject: {
          "/repo/a": {
            trunkBranch: "origin/main",
            lastRuntimeConfig: { ssh: { host: "devbox" } },
            notifyOnResponseAutoEnable: true,
          },
        },
      },
      notifications: {
        notifyOnResponseByWorkspace: { "ws-1": true },
      },
      review: { includeUncommitted: true, defaultBaseByProject: { "/repo/a": "origin/main" } },
    });

    expect(result.success).toBe(true);
  });

  test("normalizes invalid nested values without dropping valid siblings", () => {
    expect(
      normalizeUserPreferences({
        appearance: {
          theme: "legacy-dark",
          transcriptDensity: "wide",
          vimEnabled: true,
        },
        ai: {
          projectDefaults: {
            "/repo": {
              agentId: " Exec ",
              model: "openai:",
              thinkingLevel: "xhigh",
            },
          },
          autoCompactionThresholdByModel: {
            "openai:gpt-4.1": 75,
            bad: 101,
          },
        },
        review: "not-an-object",
      })
    ).toEqual({
      appearance: {
        vimEnabled: true,
      },
      ai: {
        projectDefaults: {
          "/repo": {
            agentId: "exec",
            thinkingLevel: "xhigh",
          },
        },
        autoCompactionThresholdByModel: {
          "openai:gpt-4.1": 75,
        },
      },
    });
  });

  test("repairs stored values the way clients read them", () => {
    const badge = { enabled: true, template: "{ws}", position: "top-left" as const, fontSize: 20 };
    expect(
      normalizeUserPreferences({
        appearance: {
          terminalBadgeConfig: { ...badge, opacity: 0 },
          terminalFontConfig: { fontFamily: " ", fontSize: "16" },
          editorConfig: { editor: "custom", customCommand: "" },
        },
        navigation: { projectOrder: ["/repo/a", null, " /repo/b ", "/repo/a"] },
        ai: {
          globalDefaults: { agentId: " Plan ", thinkingLevel: "med" },
          projectDefaults: {
            "/a": { agentId: "exec", model: "openai:" },
            "/b": { model: " openai:gpt-4.1 ", thinkingLevel: "med" },
          },
        },
        workspaceCreation: {
          byProject: { "/a": { trunkBranch: " main " }, "/b": { trunkBranch: " " } },
        },
        review: { defaultBaseByProject: { "/a": " origin/main ", "/b": " " } },
      })
    ).toEqual({
      appearance: {
        terminalBadgeConfig: { ...badge, opacity: DEFAULT_TERMINAL_BADGE_CONFIG.opacity },
        terminalFontConfig: { fontSize: 16 },
        editorConfig: { editor: "custom" },
      },
      navigation: { projectOrder: ["/repo/a", "/repo/b"] },
      ai: {
        globalDefaults: { agentId: "plan", thinkingLevel: "medium" },
        projectDefaults: {
          "/a": { agentId: "exec" },
          "/b": { model: "openai:gpt-4.1", thinkingLevel: "medium" },
        },
      },
      workspaceCreation: { byProject: { "/a": { trunkBranch: "main" } } },
      review: { defaultBaseByProject: { "/a": "origin/main" } },
    });
  });

  test("keeps a valid dream cost ceiling and reads an invalid one as no ceiling", () => {
    expect(normalizeUserPreferences({ memory: { dreamCostCeilingUsd: 2.5 } })).toEqual({
      memory: { dreamCostCeilingUsd: 2.5 },
    });
    expect(normalizeUserPreferences({ memory: { dreamCostCeilingUsd: 100_000 } })).toEqual({
      memory: { dreamCostCeilingUsd: 100_000 },
    });
    // A hand-edited value below the smallest ceiling (or not a number) must not stop every
    // run, and must not take other preferences down with it.
    // Nor may one past the largest ceiling: `String()` would show a huge one in exponent notation.
    for (const stored of [0, -1, 0.001, 100_000.01, 1e21, "5", null]) {
      expect(
        normalizeUserPreferences({
          memory: { dreamCostCeilingUsd: stored },
          appearance: { vimEnabled: true },
        })
      ).toEqual({ appearance: { vimEnabled: true } });
    }
  });

  test("keeps a whole dream edit limit, 0 included, and reads an invalid one as no limit saved", () => {
    // 0 is the user's "unlimited"; it must survive the load, or an emptied field reads as 8.
    for (const stored of [0, 1, 24, MEMORY_DREAM_EDIT_LIMIT_MAX]) {
      expect(normalizeUserPreferences({ memory: { dreamEditLimit: stored } })).toEqual({
        memory: { dreamEditLimit: stored },
      });
    }
    // A whole limit over the safety cap (an older build saved it, or a hand edit) loads as the
    // cap: dropping it would run at the default 8, far under what the user asked for.
    for (const stored of [
      MEMORY_DREAM_EDIT_LIMIT_MAX + 1,
      1000,
      Number.MAX_SAFE_INTEGER,
      2 ** 60,
    ]) {
      expect(normalizeUserPreferences({ memory: { dreamEditLimit: stored } })).toEqual({
        memory: { dreamEditLimit: MEMORY_DREAM_EDIT_LIMIT_MAX },
      });
    }
    // A save over the cap is refused, so only the load repairs one.
    expect(
      UserPreferencesSchema.safeParse({
        memory: { dreamEditLimit: MEMORY_DREAM_EDIT_LIMIT_MAX + 1 },
      }).success
    ).toBe(false);
    // A hand-edited value that is not a whole, non-negative number drops only itself, so the run
    // uses the default and the other preferences stay.
    for (const stored of [-1, 2.5, "8", null]) {
      expect(
        normalizeUserPreferences({
          memory: { dreamEditLimit: stored, dreamCostCeilingUsd: 2 },
          appearance: { vimEnabled: true },
        })
      ).toEqual({ memory: { dreamCostCeilingUsd: 2 }, appearance: { vimEnabled: true } });
    }
  });

  test("prunes empty nested preference groups", () => {
    expect(
      pruneUserPreferences({
        appearance: {},
        ai: { projectDefaults: { "/removed": {} } },
        navigation: { projectOrder: [] },
      })
    ).toBeUndefined();
  });
});
