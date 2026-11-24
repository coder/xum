import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../tests/ui/dom";
import { getWorkspaceKeyPrefix, PERSISTED_KEY_REGISTRY } from "@/common/constants/storage";
import { removeDroppedCacheKeys } from "./legacyLocalStorageCleanup";

describe("removeDroppedCacheKeys", () => {
  let cleanupDom: () => void;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanupDom();
  });

  test("removes only keys with a dropped cache prefix", () => {
    const keptKeys = ["statusState:c", "input:d", "x-planContent:e", "notpostCompactionState:f"];
    // Adjacent dropped keys: removing while iterating by index would skip the second one.
    const droppedKeys = [
      "planContent:a",
      "planContent:a2",
      "postCompactionState:b",
      "experiment:programmatic-tool-calling",
      "agentId:0123456789",
      "agentId:__project__/repo",
      "workspaceAiSettingsByAgent:0123456789",
      "autoModelRouting:0123456789",
      "autoThinkingLevel:__project__/repo",
      "autoRoutingChoiceByAgent:0123456789",
      "model:__project__/repo",
      "thinkingLevel:model:openai:gpt-5.2",
      "reasoningMode:0123456789",
      "pinnedAgentId:0123456789",
      "autoCompaction:enabled:0123456789",
      "disableWorkspaceAgents:0123456789",
      "runtime:/repo",
    ];
    for (const key of [...droppedKeys, ...keptKeys]) {
      window.localStorage.setItem(key, JSON.stringify({ value: key }));
    }

    removeDroppedCacheKeys();

    const remaining = Array.from({ length: window.localStorage.length }, (_, index) =>
      window.localStorage.key(index)
    );
    expect(remaining.sort()).toEqual([...keptKeys].sort());
  });

  test("keeps every key the app still registers", () => {
    const registeredKeys = PERSISTED_KEY_REGISTRY.map((entry) =>
      entry.scope === "workspaceId"
        ? `${getWorkspaceKeyPrefix(entry.getKey)}0123456789`
        : entry.match === "prefix"
          ? `${entry.key}/repo`
          : entry.key
    );
    for (const key of registeredKeys) window.localStorage.setItem(key, "1");

    removeDroppedCacheKeys();

    expect(registeredKeys.filter((key) => window.localStorage.getItem(key) === null)).toEqual([]);
  });
});
