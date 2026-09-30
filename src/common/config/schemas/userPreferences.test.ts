import { describe, expect, test } from "bun:test";

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
              model: "mux-gateway:openai",
              thinkingLevel: "xhigh",
            },
          },
          autoCompactionThresholdByModel: {
            "openai:gpt-4.1": 75,
            bad: 101,
          },
        },
      })
    ).toEqual({
      appearance: {
        theme: "dark",
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
