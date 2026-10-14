/**
 * The renderer entry (src/browser/main.tsx) and the static first-run view (T3 #5971, C step 2).
 * C step 2 starts the app JS only after the static view paints, so the entry can run after `load`.
 */
import "../dom";
import { act } from "@testing-library/react";

let mockAppLoaderThrows = false;
jest.mock("@/browser/components/AppLoader/AppLoader", () => ({
  AppLoader: () => {
    if (mockAppLoaderThrows) throw new Error("render failed");
    return null;
  },
}));

const register = jest.fn(() => Promise.resolve({}));

/** Evaluates a fresh copy of the entry, as the browser would on one page load. */
async function loadEntry(options: { keepBody?: boolean } = {}) {
  if (!options.keepBody) document.body.innerHTML = "";
  document.body.insertAdjacentHTML("beforeend", '<div id="root"></div>');
  Object.defineProperty(window.navigator, "serviceWorker", {
    configurable: true,
    value: { register },
  });
  await act(async () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh entry per test
      require("@/browser/main");
    });
    await Promise.resolve();
  });
}

/** Lets the registration promise settle, so its log lands inside the test. */
const settle = () => act(async () => await Promise.resolve());

beforeEach(() => {
  register.mockClear();
  mockAppLoaderThrows = false;
});

afterEach(() => {
  jest.restoreAllMocks();
});

test("registers the service worker on the window load event", async () => {
  jest.spyOn(document, "readyState", "get").mockReturnValue("loading");
  await loadEntry();
  expect(register).not.toHaveBeenCalled();
  window.dispatchEvent(new Event("load"));
  await settle();
  expect(register).toHaveBeenCalled();
});

test("registers the service worker at once when the entry runs after load", async () => {
  jest.spyOn(document, "readyState", "get").mockReturnValue("complete");
  await loadEntry();
  await settle();
  expect(register).toHaveBeenCalled();
});

test("an uncaught render error removes the static first-run view and leaves the root empty", async () => {
  jest.spyOn(console, "error").mockImplementation(() => undefined); // React logs the caught error
  const reportError = jest.fn();
  window.reportError = reportError;
  mockAppLoaderThrows = true;
  document.body.innerHTML = '<div id="xum-pre"></div>';
  await loadEntry({ keepBody: true });
  expect(document.getElementById("xum-pre")).toBeNull();
  expect(document.getElementById("root")?.childNodes.length).toBe(0);
  expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: "render failed" }));
});
