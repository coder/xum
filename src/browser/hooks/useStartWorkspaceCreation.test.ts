import { describe, expect, test } from "bun:test";
import {
  persistWorkspaceCreationPrefill,
  type StartWorkspaceCreationDetail,
} from "./useStartWorkspaceCreation";
import {
  getAutoModelRoutingKey,
  getInputKey,
  getModelKey,
  getPendingScopeId,
  getProjectScopeId,
  getTrunkBranchKey,
} from "@/common/constants/storage";
import type { updatePersistedState } from "@/browser/hooks/usePersistedState";

type PersistFn = typeof updatePersistedState;
type PersistCall = [string, unknown, unknown?];

describe("persistWorkspaceCreationPrefill", () => {
  const projectPath = "/tmp/project";

  function createPersistSpy() {
    const calls: PersistCall[] = [];
    const persist: PersistFn = ((...args: PersistCall) => {
      calls.push(args);
    }) as PersistFn;

    return { persist, calls };
  }

  test("writes provided values and normalizes whitespace", () => {
    const detail: StartWorkspaceCreationDetail = {
      projectPath,
      startMessage: "Ship it",
      model: "provider/model",
      trunkBranch: " main ",
      runtime: " ssh dev ", // runtime is NOT persisted - it's a one-time override
    };
    const { persist, calls } = createPersistSpy();

    persistWorkspaceCreationPrefill(projectPath, detail, persist);

    const callMap = new Map<string, unknown>();
    for (const [key, value] of calls) {
      callMap.set(key, value);
    }

    expect(callMap.get(getInputKey(getPendingScopeId(projectPath)))).toBe("Ship it");
    expect(callMap.get(getModelKey(getProjectScopeId(projectPath)))).toBe("provider/model");
    expect(callMap.get(getTrunkBranchKey(projectPath))).toBe("main");
    expect(callMap.get(getAutoModelRoutingKey(getProjectScopeId(projectPath)))).toBe(false);
    // runtime is intentionally not persisted - default can only be changed via icon selector
    expect(calls.length).toBe(4);
  });

  test("a prefilled model is an explicit pick and leaves the project's Auto routing", () => {
    const { persist, calls } = createPersistSpy();

    persistWorkspaceCreationPrefill(projectPath, { projectPath, model: "provider/model" }, persist);

    const callMap = new Map<string, unknown>(calls.map(([key, value]) => [key, value]));
    expect(callMap.get(getModelKey(getProjectScopeId(projectPath)))).toBe("provider/model");
    expect(callMap.get(getAutoModelRoutingKey(getProjectScopeId(projectPath)))).toBe(false);
  });

  test("clears persisted values when empty strings are provided", () => {
    const detail: StartWorkspaceCreationDetail = {
      projectPath,
      trunkBranch: "   ",
    };
    const { persist, calls } = createPersistSpy();

    persistWorkspaceCreationPrefill(projectPath, detail, persist);

    const callMap = new Map<string, unknown>();
    for (const [key, value] of calls) {
      callMap.set(key, value);
    }

    expect(callMap.get(getTrunkBranchKey(projectPath))).toBeUndefined();
  });

  test("no-op when detail is undefined", () => {
    const { persist, calls } = createPersistSpy();
    persistWorkspaceCreationPrefill(projectPath, undefined, persist);
    expect(calls).toHaveLength(0);
  });
});
