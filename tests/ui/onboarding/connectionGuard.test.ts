/**
 * AppLoader's first-run view guard (T3 #5971, C step 2): the static first-run view must never cover
 * the token prompt, a startup error or the reconnect screen, and stays while the app connects.
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
  document.body.innerHTML = '<div id="xum-pre"></div>';
  mockStatus = status;
  render(React.createElement(FirstRunViewConnectionGuard));
  expect(document.getElementById("xum-pre") != null).toBe(stays);
});
