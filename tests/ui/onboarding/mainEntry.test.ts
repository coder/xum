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
async function loadEntry() {
  document.body.innerHTML = '<div id="root"></div>';
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
