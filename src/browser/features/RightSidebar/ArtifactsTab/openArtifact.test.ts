import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../../../tests/ui/dom";
import { createTestApiClient } from "@/browser/testUtils";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { CUSTOM_EVENTS, type CustomEventPayloads } from "@/common/constants/events";
import {
  ARTIFACTS_SELECTION_KEY,
  ARTIFACTS_SELECTION_MAX_WORKSPACES,
} from "@/common/constants/storage";
import { readArtifactSelection, writeArtifactSelection } from "./artifactSelection";
import { openArtifact, pinAndOpenArtifact } from "./openArtifact";

type OpenDetail = CustomEventPayloads[typeof CUSTOM_EVENTS.OPEN_ARTIFACT];
const WS = "ws-open";

/** Records each OPEN_ARTIFACT with the selection persisted at dispatch time. */
function recordOpens() {
  const opens: Array<{ detail: OpenDetail; persisted: unknown[] }> = [];
  const toasts: string[] = [];
  const onOpen = (event: Event) => {
    opens.push({
      detail: (event as CustomEvent<OpenDetail>).detail,
      persisted: (({ scope, path, version }) => [scope, path, version])(readArtifactSelection(WS)),
    });
  };
  const onToast = (event: Event) => {
    toasts.push((event as CustomEvent<{ message: string }>).detail.message);
  };
  window.addEventListener(CUSTOM_EVENTS.OPEN_ARTIFACT, onOpen);
  window.addEventListener(CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST, onToast);
  return {
    opens,
    toasts,
    stop: () => {
      window.removeEventListener(CUSTOM_EVENTS.OPEN_ARTIFACT, onOpen);
      window.removeEventListener(CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST, onToast);
    },
  };
}

describe("openArtifact", () => {
  let cleanupDom: (() => void) | null = null;
  let recorder: ReturnType<typeof recordOpens> | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    recorder = recordOpens();
  });

  afterEach(() => {
    recorder?.stop();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("persists the selection before asking for the tab", () => {
    openArtifact({ workspaceId: WS, path: "charts/q3.html", versionId: 3 });
    expect(recorder?.opens).toEqual([
      {
        detail: { workspaceId: WS, path: "charts/q3.html", versionId: 3 },
        persisted: ["artifact", "charts/q3.html", 3],
      },
    ]);
  });

  test("a pinned file always opens live, dropping a previously selected version", () => {
    writeArtifactSelection(WS, { version: 7 });
    openArtifact({ workspaceId: WS, path: "src/app.ts", versionId: 2, pinned: true });
    expect(recorder?.opens).toEqual([
      {
        detail: { workspaceId: WS, path: "src/app.ts", pinned: true },
        persisted: ["pinned", "src/app.ts", null],
      },
    ]);
  });

  test("pinAndOpenArtifact opens the checkout-relative path the backend stored", async () => {
    const api = createTestApiClient({
      artifacts: {
        pinFile: () => Promise.resolve({ success: true as const, data: { path: "docs/a.md" } }),
      },
    });
    await pinAndOpenArtifact(api, WS, "/home/me/repo/docs/a.md");
    expect(recorder?.opens.map((open) => open.detail)).toEqual([
      { workspaceId: WS, path: "docs/a.md", pinned: true },
    ]);
    expect(recorder?.toasts).toEqual([]);
  });

  test("pinAndOpenArtifact reports a refused pin instead of opening", async () => {
    const api = createTestApiClient({
      artifacts: {
        pinFile: () =>
          Promise.resolve({ success: false as const, error: "Path is outside the checkout" }),
      },
    });
    await pinAndOpenArtifact(api, WS, "/etc/passwd");
    expect(recorder?.opens).toEqual([]);
    expect(recorder?.toasts).toEqual(["Path is outside the checkout"]);
  });

  test("pinAndOpenArtifact: only the latest request in a workspace opens", async () => {
    const resolvers = new Map<string, (path: string) => void>();
    const api = createTestApiClient({
      artifacts: {
        pinFile: (input: { workspaceId: string; path: string }) =>
          new Promise<{ success: true; data: { path: string } }>((resolve) => {
            resolvers.set(input.path, (path) => resolve({ success: true, data: { path } }));
          }),
      },
    });
    const first = pinAndOpenArtifact(api, WS, "first.md");
    const second = pinAndOpenArtifact(api, WS, "second.md");
    resolvers.get("second.md")?.("second.md");
    await second;
    resolvers.get("first.md")?.("first.md");
    await first;
    expect(recorder?.opens.map((open) => open.detail.path)).toEqual(["second.md"]);
    expect(readArtifactSelection(WS).path).toBe("second.md");
  });
});

describe("artifact selection storage", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanupDom?.();
    cleanupDom = null;
  });

  test("keeps only the most recently used workspaces", () => {
    const total = ARTIFACTS_SELECTION_MAX_WORKSPACES + 2;
    for (let i = 0; i < total; i++) writeArtifactSelection(`ws-${i}`, { path: `f${i}.md` });
    expect(readArtifactSelection("ws-0").path).toBeNull();
    expect(readArtifactSelection("ws-1").path).toBeNull();
    // Touching ws-2 again makes it the newest, so the next new workspace drops ws-3 instead.
    writeArtifactSelection("ws-2", { version: 4 });
    writeArtifactSelection("ws-new", { path: "n.md" });
    const map = readPersistedState<Record<string, unknown>>(ARTIFACTS_SELECTION_KEY, {});
    expect(Object.keys(map)).toHaveLength(ARTIFACTS_SELECTION_MAX_WORKSPACES);
    expect(Object.keys(map).slice(-2)).toEqual(["ws-2", "ws-new"]);
    expect(readArtifactSelection("ws-3").path).toBeNull();
    expect(readArtifactSelection("ws-2")).toEqual({ scope: "artifact", path: "f2.md", version: 4 });
  });

  test("malformed stored values read as the default selection", () => {
    window.localStorage.setItem(
      ARTIFACTS_SELECTION_KEY,
      JSON.stringify({ [WS]: { scope: "evil", path: 3, version: -1 } })
    );
    expect(readArtifactSelection(WS)).toEqual({ scope: "artifact", path: null, version: null });
  });
});
