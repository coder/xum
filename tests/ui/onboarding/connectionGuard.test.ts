/**
 * AppLoader's first-run view guard (T3 #5971, C step 2): the static first-run view, and the static
 * workspace view (C step 4), must never cover the token prompt, a startup error or the reconnect
 * screen, and stay while the app connects. App, with the workspace view's own guard, is not
 * mounted yet in those states.
 */
import "../dom";
import React from "react";
import { cleanup, render } from "@testing-library/react";

let mockStatus = "connecting";
jest.mock("@/browser/contexts/API", () => ({
  ...jest.requireActual<typeof import("@/browser/contexts/API")>("@/browser/contexts/API"),
  useAPI: () => ({ status: mockStatus }),
}));

import { FirstRunViewConnectionGuard } from "@/browser/components/AppLoader/AppLoader";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

test.each([
  ["connecting", true],
  ["connected", true],
  ["degraded", true],
  ["auth_required", false],
  ["error", false],
  ["reconnecting", false],
])("with status %s, the static view stays: %s", (status, stays) => {
  document.body.innerHTML = '<div id="xum-pre"></div><div id="xum-pre-ws"></div>';
  mockStatus = status;
  render(React.createElement(FirstRunViewConnectionGuard));
  expect(document.getElementById("xum-pre") != null).toBe(stays);
  expect(document.getElementById("xum-pre-ws") != null).toBe(stays);
});
