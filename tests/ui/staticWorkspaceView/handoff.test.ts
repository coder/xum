/**
 * The static workspace view's handoff (T3 #5971, C step 4): the live app removes #xum-pre-ws once
 * that workspace's chat view replaces it, and on every path where no chat view of it will come.
 */
import "../dom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";

let mockStatus = "connected";
let mockRoute: string | null = "ws1";
let mockMetadata = {
  workspaceMetadata: new Map([["ws1", {}]]),
  loading: false,
  loaded: true,
  loadError: null as string | null,
};
jest.mock("@/browser/contexts/API", () => ({
  ...jest.requireActual<typeof import("@/browser/contexts/API")>("@/browser/contexts/API"),
  useAPI: () => ({ status: mockStatus }),
}));
jest.mock("@/browser/contexts/RouterContext", () => ({
  ...jest.requireActual<typeof import("@/browser/contexts/RouterContext")>(
    "@/browser/contexts/RouterContext"
  ),
  useRouter: () => ({ currentWorkspaceId: mockRoute }),
}));
jest.mock("@/browser/contexts/WorkspaceContext", () => ({
  ...jest.requireActual<typeof import("@/browser/contexts/WorkspaceContext")>(
    "@/browser/contexts/WorkspaceContext"
  ),
  useWorkspaceMetadata: () => mockMetadata,
}));

import {
  WorkspaceViewGuard,
  useWorkspaceViewHandoff,
} from "@/browser/features/StaticWorkspaceView/workspaceViewHandoff";

const viewShown = () => document.getElementById("xum-pre-ws") != null;

beforeEach(() => {
  mockStatus = "connected";
  mockRoute = "ws1";
  mockMetadata = {
    workspaceMetadata: new Map([["ws1", {}]]),
    loading: false,
    loaded: true,
    loadError: null,
  };
  document.body.innerHTML = '<div id="xum-pre-ws" data-workspace-id="ws1"></div>';
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("the chat view's handoff", () => {
  function Pane(props: { workspaceId: string; loaded: boolean; replayFailed: boolean }) {
    useWorkspaceViewHandoff(props.workspaceId, props.loaded, props.replayFailed);
    return null;
  }
  test.each([
    ["still loading", "ws1", false, false, true],
    ["loaded", "ws1", true, false, false],
    ["its history read failed, so it never loads", "ws1", false, true, false],
    ["another workspace loaded", "ws2", true, false, true],
  ])(
    "%s (%s, loaded %s, read failed %s): the view stays %s",
    (_c, workspaceId, loaded, replayFailed, stays) => {
      render(React.createElement(Pane, { workspaceId, loaded, replayFailed }));
      expect(viewShown()).toBe(stays);
    }
  );

  test("the view goes when the chat view finishes loading", () => {
    const view = render(
      React.createElement(Pane, { workspaceId: "ws1", loaded: false, replayFailed: false })
    );
    expect(viewShown()).toBe(true);
    view.rerender(
      React.createElement(Pane, { workspaceId: "ws1", loaded: true, replayFailed: false })
    );
    expect(viewShown()).toBe(false);
  });
});

describe("the app's guard", () => {
  test.each([
    ["connecting", true],
    ["connected", true],
    ["auth_required", false],
    ["error", false],
    ["reconnecting", false],
  ])("with status %s, the view stays: %s", (status, stays) => {
    mockStatus = status;
    render(React.createElement(WorkspaceViewGuard));
    expect(viewShown()).toBe(stays);
  });

  test.each([
    ["the route shows another workspace", () => (mockRoute = "ws2")],
    ["the route shows another page", () => (mockRoute = null)],
    ["the workspace list loaded without it", () => mockMetadata.workspaceMetadata.clear()],
    ["the workspace list failed to load", () => (mockMetadata.loadError = "offline")],
  ])("the view goes when %s", (_case, arrange) => {
    arrange();
    render(React.createElement(WorkspaceViewGuard));
    expect(viewShown()).toBe(false);
  });

  test("the view stays while the workspace list loads", () => {
    mockMetadata = { workspaceMetadata: new Map(), loading: true, loaded: false, loadError: null };
    render(React.createElement(WorkspaceViewGuard));
    expect(viewShown()).toBe(true);
  });

  // The view is inert and does not scroll: a tap or a key would reach the hidden live UI.
  test.each([
    ["pointerdown", () => fireEvent.pointerDown(document.body)],
    ["keydown", () => fireEvent.keyDown(document.body, { key: "a" })],
  ])("the first %s removes the view", (_event, fire) => {
    render(React.createElement(WorkspaceViewGuard));
    expect(viewShown()).toBe(true);
    fire();
    expect(viewShown()).toBe(false);
  });

  test("without a view on the page, the guard does nothing", () => {
    document.body.innerHTML = '<div id="other"></div>';
    mockRoute = null;
    render(React.createElement(WorkspaceViewGuard));
    fireEvent.pointerDown(document.body);
    expect(document.getElementById("other")).not.toBeNull();
  });
});
