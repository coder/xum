import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import {
  buildAutoSelectedTemplateConfig,
  useCoderWorkspace,
  type CoderInfoRefreshPolicy,
} from "./useCoderWorkspace";
import type { CoderInfo, CoderTemplate } from "@/common/orpc/schemas/coder";
import type { CoderWorkspaceConfig } from "@/common/types/runtime";

const makeTemplate = (name: string, org = "default-org"): CoderTemplate => ({
  name,
  displayName: name,
  organizationName: org,
});

const getInfoMock = mock<() => Promise<CoderInfo>>(() =>
  Promise.resolve({ state: "available", version: "2.0.0" })
);
const listTemplatesMock = mock(() => Promise.resolve({ ok: true as const, templates: [] }));
const listPresetsMock = mock(() => Promise.resolve({ ok: true as const, presets: [] }));
const listWorkspacesMock = mock(() => Promise.resolve({ ok: true as const, workspaces: [] }));

const coderApiMock = {
  getInfo: getInfoMock,
  listTemplates: listTemplatesMock,
  listPresets: listPresetsMock,
  listWorkspaces: listWorkspacesMock,
};

const apiMock = {
  coder: coderApiMock,
} as unknown as APIClient;

// Inject the client through the real provider; mocking the API module leaks process-wide
// into later suites. (This file is .ts, so build the wrapper without JSX.)
function APIWrapper(props: { children: ReactNode }) {
  return createElement(
    APIProvider,
    { client: apiMock } as ComponentProps<typeof APIProvider>,
    props.children
  );
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const noopCoderConfigChange = (_config: CoderWorkspaceConfig | null) => undefined;

function renderUseCoderWorkspace(options: {
  coderInfoRefreshPolicy: CoderInfoRefreshPolicy;
  coderConfig?: CoderWorkspaceConfig | null;
  onCoderConfigChange?: (config: CoderWorkspaceConfig | null) => void;
}) {
  return renderHook(
    () =>
      useCoderWorkspace({
        coderConfig: options.coderConfig ?? null,
        onCoderConfigChange: options.onCoderConfigChange ?? noopCoderConfigChange,
        coderInfoRefreshPolicy: options.coderInfoRefreshPolicy,
      }),
    { wrapper: APIWrapper }
  );
}

describe("buildAutoSelectedTemplateConfig", () => {
  test("preserves preset when auto-selecting first template", () => {
    const currentConfig = { preset: "my-preset" };
    const templates = [makeTemplate("template-a")];

    const result = buildAutoSelectedTemplateConfig(currentConfig, templates);

    expect(result).toEqual({
      preset: "my-preset",
      existingWorkspace: false,
      template: "template-a",
      templateOrg: "default-org",
    });
  });

  test("sets templateOrg when first template name is duplicated across orgs", () => {
    const templates = [makeTemplate("shared-name", "org-1"), makeTemplate("shared-name", "org-2")];

    const result = buildAutoSelectedTemplateConfig(null, templates);

    expect(result).toEqual({
      existingWorkspace: false,
      template: "shared-name",
      templateOrg: "org-1",
    });
  });

  test("returns null when template is already selected", () => {
    const currentConfig = { template: "existing-template" };
    const templates = [makeTemplate("template-a")];

    expect(buildAutoSelectedTemplateConfig(currentConfig, templates)).toBeNull();
  });

  test("returns null when existingWorkspace is true", () => {
    const currentConfig = { existingWorkspace: true };
    const templates = [makeTemplate("template-a")];

    expect(buildAutoSelectedTemplateConfig(currentConfig, templates)).toBeNull();
  });

  test("returns null when templates array is empty", () => {
    expect(buildAutoSelectedTemplateConfig(null, [])).toBeNull();
  });
});

describe("useCoderWorkspace coder auth refresh", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    getInfoMock.mockReset();
    getInfoMock.mockImplementation(() => Promise.resolve({ state: "available", version: "2.0.0" }));
    listTemplatesMock.mockReset();
    listTemplatesMock.mockImplementation(() =>
      Promise.resolve({ ok: true as const, templates: [] })
    );
    listPresetsMock.mockReset();
    listPresetsMock.mockImplementation(() => Promise.resolve({ ok: true as const, presets: [] }));
    listWorkspacesMock.mockReset();
    listWorkspacesMock.mockImplementation(() =>
      Promise.resolve({ ok: true as const, workspaces: [] })
    );
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("mount-only policy does not refetch on focus", async () => {
    renderUseCoderWorkspace({ coderInfoRefreshPolicy: "mount-only" });
    await flushAsyncWork();

    expect(getInfoMock).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new window.Event("focus"));
    });
    await flushAsyncWork();

    expect(getInfoMock).toHaveBeenCalledTimes(1);
  });

  test("mount-and-focus policy refetches on focus", async () => {
    renderUseCoderWorkspace({ coderInfoRefreshPolicy: "mount-and-focus" });
    await flushAsyncWork();

    expect(getInfoMock).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new window.Event("focus"));
    });
    await flushAsyncWork();

    expect(getInfoMock).toHaveBeenCalledTimes(2);
  });

  test("latest-wins race ignores stale auth failure", async () => {
    const first = deferred<CoderInfo>();
    const second = deferred<CoderInfo>();
    getInfoMock.mockReset();
    getInfoMock.mockImplementationOnce(() => first.promise);
    getInfoMock.mockImplementationOnce(() => second.promise);

    const onCoderConfigChange =
      mock<(config: CoderWorkspaceConfig | null) => void>(noopCoderConfigChange);

    const { result } = renderUseCoderWorkspace({
      coderInfoRefreshPolicy: "mount-and-focus",
      coderConfig: { existingWorkspace: true, workspaceName: "existing-workspace" },
      onCoderConfigChange,
    });
    await flushAsyncWork();

    act(() => {
      window.dispatchEvent(new window.Event("focus"));
    });
    await flushAsyncWork();

    expect(getInfoMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve({ state: "available", version: "2.0.0" });
      await second.promise;
      await Promise.resolve();
    });

    await act(async () => {
      first.reject(new Error("stale failure"));
      try {
        await first.promise;
      } catch {
        // Expected rejection from stale request.
      }
      await Promise.resolve();
    });

    expect(result.current.coderInfo?.state).toBe("available");
    expect(onCoderConfigChange).not.toHaveBeenCalledWith(null);
  });
});
