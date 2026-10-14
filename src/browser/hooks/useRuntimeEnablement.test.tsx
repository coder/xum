import "../../../tests/ui/dom";

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";
import { APIContext } from "@/browser/contexts/API";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { DEFAULT_RUNTIME_ENABLEMENT } from "@/common/types/runtime";
import { useRuntimeEnablement } from "./useRuntimeEnablement";

function DisconnectedAPI(props: { children: ReactNode }) {
  return (
    <APIContext.Provider
      value={{
        api: null,
        status: "reconnecting",
        error: null,
        attempt: 1,
        authenticate: () => undefined,
        retry: () => undefined,
      }}
    >
      {props.children}
    </APIContext.Provider>
  );
}

describe("useRuntimeEnablement", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    getAppConfigStore().updateOptimistically({
      runtimeEnablement: DEFAULT_RUNTIME_ENABLEMENT,
      defaultRuntime: "local",
    });
  });

  afterEach(() => {
    cleanup();
    getAppConfigStore().clearCachedState();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("refuses runtime changes visibly while disconnected", () => {
    const alert = spyOn(window, "alert").mockImplementation(() => undefined);
    const { result } = renderHook(() => useRuntimeEnablement(), { wrapper: DisconnectedAPI });

    act(() => {
      result.current.setRuntimeEnabled("ssh", false);
      result.current.setDefaultRuntime("worktree");
    });

    expect(getAppConfigStore().getSnapshot()?.runtimeEnablement).toEqual(
      DEFAULT_RUNTIME_ENABLEMENT
    );
    expect(getAppConfigStore().getSnapshot()?.defaultRuntime).toBe("local");
    expect(alert).toHaveBeenCalledTimes(2);
    alert.mockRestore();
  });
});
