import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render as rtlRender } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { installDom } from "../../../../tests/ui/dom";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { CUSTOM_EVENTS, type CustomEventPayloads } from "@/common/constants/events";
import { EXPERIMENT_IDS, getExperimentKey } from "@/common/constants/experiments";
import { ChatHostContextProvider } from "@/browser/contexts/ChatHostContext";
import { CHAT_UI_FEATURE_IDS } from "@/common/constants/chatUiFeatures";
import { ArtifactToolCall } from "./ArtifactToolCall";
import { AttachFileToolCall } from "./AttachFileToolCall";
import { APIProvider } from "@/browser/contexts/API";
import { OpenAsArtifactButton } from "@/browser/features/RightSidebar/ArtifactsTab/OpenAsArtifactButton";
import { createTestApiClient } from "@/browser/testUtils";

/** StatusIndicator needs the app's tooltip provider. */
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: TooltipProvider });

type OpenDetail = CustomEventPayloads[typeof CUSTOM_EVENTS.OPEN_ARTIFACT];
const WS = "ws-card";

const published = {
  success: true,
  id: "art-1",
  version: 3,
  path: "cache-explorer.html",
  bytes: 1200,
  kind: "html",
  title: "interactive chart",
  pin: null,
} as const;

describe("artifact chat cards", () => {
  let cleanupDom: (() => void) | null = null;
  let opens: OpenDetail[] = [];
  const onOpen = (event: Event) => opens.push((event as CustomEvent<OpenDetail>).detail);

  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    opens = [];
    window.addEventListener(CUSTOM_EVENTS.OPEN_ARTIFACT, onOpen);
  });

  afterEach(() => {
    window.removeEventListener(CUSTOM_EVENTS.OPEN_ARTIFACT, onOpen);
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("clicking a published card opens the Artifacts tab at that version", () => {
    updatePersistedState(getExperimentKey(EXPERIMENT_IDS.ARTIFACTS), true);
    const view = render(
      <ArtifactToolCall
        toolName="artifact"
        args={{ path: "cache-explorer.html" }}
        result={published}
        status="completed"
        workspaceId={WS}
      />
    );
    fireEvent.click(view.getByRole("button", { name: /Open cache-explorer.html version 3/ }));
    expect(opens).toEqual([{ workspaceId: WS, path: "cache-explorer.html", versionId: 3 }]);
  });

  test("a failed publish renders as an error card, not a link", () => {
    const view = render(
      <ArtifactToolCall
        toolName="artifact"
        args={{ path: "missing.md" }}
        result={{ success: false, error: "File not found: missing.md" }}
        status="failed"
        workspaceId={WS}
      />
    );
    expect(view.getByText("File not found: missing.md")).toBeTruthy();
    expect(view.queryByRole("button", { name: /Open / })).toBeNull();
  });

  test("focus opens the tab once when the result arrives live, never on replay", () => {
    updatePersistedState(getExperimentKey(EXPERIMENT_IDS.ARTIFACTS), true);
    const live = render(
      <ArtifactToolCall
        toolName="artifact"
        args={{ path: "cache-explorer.html", focus: true }}
        status="executing"
        workspaceId={WS}
      />
    );
    expect(opens).toEqual([]);
    const completed = (
      <ArtifactToolCall
        toolName="artifact"
        args={{ path: "cache-explorer.html", focus: true }}
        result={published}
        status="completed"
        workspaceId={WS}
      />
    );
    live.rerender(completed);
    live.rerender(completed);
    expect(opens).toEqual([{ workspaceId: WS, path: "cache-explorer.html", versionId: 3 }]);
    live.unmount();

    // History replay: the card mounts with its result already present.
    render(completed);
    expect(opens).toHaveLength(1);
  });

  test("with the Artifacts experiment off, the card neither opens nor focuses the tab", () => {
    const card = (result?: typeof published) => (
      <ArtifactToolCall
        toolName="artifact"
        args={{ path: "cache-explorer.html", focus: true }}
        result={result}
        status={result ? "completed" : "executing"}
        workspaceId={WS}
      />
    );
    const view = render(card());
    view.rerender(card(published));
    // Same as a host without the panel: the card stays, clicking it dispatches nothing.
    fireEvent.click(view.getByRole("button", { name: /cache-explorer.html version 3/ }));
    expect(opens).toEqual([]);
  });

  test("hosts without an Artifacts surface render the card but never open it", () => {
    const uiSupport = Object.fromEntries(
      CHAT_UI_FEATURE_IDS.map((id) => [id, id === "artifactsPanel" ? "unsupported" : "supported"])
    ) as Parameters<typeof ChatHostContextProvider>[0]["value"]["uiSupport"];
    const card = (result?: typeof published) => (
      <ChatHostContextProvider value={{ uiSupport, actions: {} }}>
        <ArtifactToolCall
          toolName="artifact"
          args={{ path: "cache-explorer.html", focus: true }}
          result={result}
          status={result ? "completed" : "executing"}
          workspaceId={WS}
        />
      </ChatHostContextProvider>
    );
    const view = render(card());
    view.rerender(card(published));
    fireEvent.click(view.getByRole("button", { name: /cache-explorer.html version 3/ }));
    expect(opens).toEqual([]);
  });

  test("attach_file offers Open in Artifacts for a registered version", () => {
    const result = {
      type: "content",
      value: [{ type: "text", text: "[File shown to user: report.md]" }],
      ui_only: { artifact: { id: "art-report", version: 2, path: "report.md" } },
    };
    const card = (
      <AttachFileToolCall
        toolName="attach_file"
        args={{ path: "report.md" }}
        result={result}
        status="completed"
        workspaceId={WS}
      />
    );
    const hidden = render(card);
    // Gated on the artifacts experiment like every other entry point.
    expect(hidden.queryByRole("button", { name: /Open in Artifacts/ })).toBeNull();
    hidden.unmount();

    updatePersistedState(getExperimentKey(EXPERIMENT_IDS.ARTIFACTS), true);
    const view = render(card);
    fireEvent.click(view.getByRole("button", { name: /Open in Artifacts/ }));
    expect(opens).toEqual([{ workspaceId: WS, path: "report.md", versionId: 2 }]);
  });

  test("hosts without an Artifacts surface get no open buttons on attach_file or file cards", () => {
    updatePersistedState(getExperimentKey(EXPERIMENT_IDS.ARTIFACTS), true);
    const uiSupport = Object.fromEntries(
      CHAT_UI_FEATURE_IDS.map((id) => [id, id === "artifactsPanel" ? "unsupported" : "supported"])
    ) as Parameters<typeof ChatHostContextProvider>[0]["value"]["uiSupport"];
    const view = render(
      <APIProvider client={createTestApiClient({})}>
        <ChatHostContextProvider value={{ uiSupport, actions: {} }}>
          <AttachFileToolCall
            toolName="attach_file"
            args={{ path: "report.md" }}
            result={{
              type: "content",
              value: [{ type: "text", text: "[File shown to user: report.md]" }],
              ui_only: { artifact: { id: "art-report", version: 2, path: "report.md" } },
            }}
            status="completed"
            workspaceId={WS}
          />
          <OpenAsArtifactButton workspaceId={WS} path="src/a.ts" />
        </ChatHostContextProvider>
      </APIProvider>
    );
    expect(view.queryByRole("button", { name: /Open in Artifacts/ })).toBeNull();
    expect(view.queryByRole("button", { name: /as artifact/ })).toBeNull();
  });
});
