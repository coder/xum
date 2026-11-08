import "../../../../tests/ui/dom";

import { cleanup, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as vm from "node:vm";
import { installDom } from "../../../../tests/ui/dom";

// index.html's boot-load-failure script is the only code that can run when the app's module graph
// fails to load, so these tests run that very script against index.html's own boot screen markup.
// happy-dom does not run scripts it parses, so the test hands the script text a fresh window.

const VERIFY_XUM_SCRIPT = path.join(process.cwd(), ".xum/skills/verify-xum/scripts/verify-xum.sh");

// What the app's own screens render once React replaced the static boot screen: the classes of
// index.html's boot loader, and no id. LoadingScreen.tsx and StartupConnectionError.tsx are the
// sources of these two.
const LOADING_SCREEN_HTML =
  '<div class="boot-loader" role="status" aria-live="polite" aria-busy="true"><div class="boot-loader__inner"><p class="boot-loader__text">Loading<span class="boot-loader__dots"></span></p></div></div>';
const STARTUP_ERROR_HTML =
  '<div class="boot-loader" role="alert" aria-live="polite"><div class="boot-loader__inner"><p class="boot-loader__text">No backend</p></div></div>';

let cleanupDom: (() => void) | null = null;
let indexPage: Document;
let scriptSource: string;

beforeEach(async () => {
  cleanupDom = installDom();
  const html = await readFile(path.join(process.cwd(), "index.html"), "utf8");
  indexPage = new window.DOMParser().parseFromString(html, "text/html");
  const script = indexPage.getElementById("boot-load-failure-script");
  if (!script?.textContent) throw new Error("index.html has no boot-load-failure script");
  scriptSource = script.textContent;
});

afterEach(() => {
  cleanup();
  cleanupDom?.();
  cleanupDom = null;
});

/** What the browser has before the app runs: the boot screen and the failure template. */
function addBootScreen(): void {
  for (const id of ["root", "boot-load-failure"]) {
    const element = indexPage.getElementById(id);
    if (!element) throw new Error(`index.html has no #${id}`);
    document.body.append(document.importNode(element, true));
  }
}

function addBootScreenWithoutTemplate(): void {
  const root = indexPage.getElementById("root");
  if (!root) throw new Error("index.html has no #root");
  document.body.append(document.importNode(root, true));
}

function runBootScript(): void {
  // Like the browser, give the script the page's own window, document and location as globals.
  vm.runInNewContext(scriptSource, { window, document, location: window.location });
}

function bootPage(): void {
  addBootScreen();
  runBootScript();
}

function failedModuleScript(): Event {
  const script = document.createElement("script");
  script.type = "module";
  document.head.append(script);
  // A load error does not bubble: the browser fires it at the element, and only a capturing
  // listener on the window sees it.
  const event = new window.Event("error", { cancelable: true });
  script.dispatchEvent(event);
  return event;
}

/** The failure template alone: the page around it is up to the test. */
function addTemplate(): void {
  const template = indexPage.getElementById("boot-load-failure");
  if (!template) throw new Error("index.html has no #boot-load-failure");
  document.body.append(document.importNode(template, true));
}

/** Errors that the page's handlers raise while `action` runs, as the window reports them. */
function errorsRaisedBy(action: () => void): unknown[] {
  const raised: unknown[] = [];
  const listener = (event: Event) => raised.push((event as ErrorEvent).error ?? event.type);
  window.addEventListener("error", listener);
  try {
    action();
  } catch (error) {
    raised.push(error);
  } finally {
    window.removeEventListener("error", listener);
  }
  return raised;
}

describe("boot screen load failure", () => {
  test("replaces Loading Xum with a focused reload prompt when a module script fails to load", () => {
    bootPage();
    const reload = spyOn(window.location, "reload").mockImplementation(() => undefined);
    try {
      const screen = within(document.body);
      expect(screen.getByRole("status")).toBeTruthy();

      failedModuleScript();

      expect(screen.queryByRole("status")).toBeNull();
      // The user gets a title, an explanation and one named button, in one alert. The words are
      // not asserted: a rewrite of the prose is no change in behavior.
      const alert = screen.getByRole("alert");
      expect(within(alert).getByRole("heading", { level: 1 }).textContent?.trim()).toBeTruthy();
      expect(alert.querySelector("p")?.textContent?.trim()).toBeTruthy();
      const button = within(alert).getByRole("button");
      expect(button.textContent?.trim()).toBeTruthy();
      // Focus is what lets Enter reload: a native button runs its click on Enter.
      expect(document.activeElement).toBe(button);
      expect(reload).not.toHaveBeenCalled();
      button.click();
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      reload.mockRestore();
    }
  });

  test("keeps the logo and drops the loading text with its busy and polite live region marks", () => {
    bootPage();
    const logo = document.querySelector(".boot-loader__logo");
    expect(logo).not.toBeNull();
    // Before the failure the loader announces itself politely, and says it is busy.
    expect(document.querySelector("[aria-live=polite][aria-busy=true]")).not.toBeNull();

    failedModuleScript();

    expect(document.querySelector(".boot-loader__logo")).toBe(logo);
    expect(document.querySelector("[aria-busy]")).toBeNull();
    // A polite live region around the alert would announce the alert's text as a status update.
    expect(document.querySelector("[aria-live]")).toBeNull();
    expect(document.querySelector(".boot-loader__dots")).toBeNull();
  });

  test("reports a Vite preload error, which a built app raises when a dynamic import fails", () => {
    bootPage();

    window.dispatchEvent(new window.Event("vite:preloadError", { cancelable: true }));

    expect(within(document.body).getByRole("alert")).toBeTruthy();
  });

  // Vite's helper rethrows the original error unless a listener cancels vite:preloadError. A
  // canceled event makes the failed dynamic import resolve, which hides it from lazy boundaries.
  test("leaves a Vite preload error uncanceled, before and after the app mounts", () => {
    bootPage();
    const before = new window.Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(false);

    // React clears the root when it renders, which removes the static boot screen.
    document.getElementById("root")?.replaceChildren();
    const after = new window.Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  test("shows the prompt for a Vite preload error that came before the body", () => {
    runBootScript();
    window.dispatchEvent(new window.Event("vite:preloadError"));
    expect(within(document.body).queryByRole("alert")).toBeNull();

    addBootScreen();
    document.dispatchEvent(new window.Event("DOMContentLoaded"));

    expect(within(document.body).getByRole("alert")).toBeTruthy();
  });

  test("shows one prompt however many modules fail", () => {
    bootPage();

    failedModuleScript();
    failedModuleScript();
    window.dispatchEvent(new window.Event("vite:preloadError"));

    expect(within(document.body).getAllByRole("alert")).toHaveLength(1);
    expect(within(document.body).getAllByRole("button")).toHaveLength(1);
  });

  // The page can fail before its body is parsed (a module script in the head, an instant error).
  test("shows the prompt once the boot screen exists when a module fails before it does", () => {
    runBootScript();
    failedModuleScript();
    expect(within(document.body).queryByRole("alert")).toBeNull();

    addBootScreen();
    document.dispatchEvent(new window.Event("DOMContentLoaded"));

    expect(within(document.body).getByRole("alert")).toBeTruthy();
  });

  describe("does not report", () => {
    test("a runtime error, which is an error event on the window", () => {
      bootPage();

      const event = new window.ErrorEvent("error", { message: "boom", cancelable: true });
      window.dispatchEvent(event);

      expect(within(document.body).queryByRole("alert")).toBeNull();
      expect(within(document.body).getByRole("status")).toBeTruthy();
      // The script only listens: the browser and the app still see the error as before.
      expect(event.defaultPrevented).toBe(false);
    });

    // Only the module script element's own error says a module failed to load: a failed preload
    // hint is not that, and the script that needs the file then fails on its own.
    test("a script that is not a module, a stylesheet or a preload that fails to load", () => {
      bootPage();

      const classic = document.createElement("script");
      document.head.append(classic);
      classic.dispatchEvent(new window.Event("error"));
      const stylesheet = document.createElement("link");
      stylesheet.rel = "stylesheet";
      document.head.append(stylesheet);
      stylesheet.dispatchEvent(new window.Event("error"));
      const preload = document.createElement("link");
      preload.rel = "modulepreload";
      document.head.append(preload);
      preload.dispatchEvent(new window.Event("error"));

      expect(within(document.body).queryByRole("alert")).toBeNull();
    });

    // A link whose `type` says "module" is not a module script: only a script element is one.
    test("an element that is not a script but has the type module", () => {
      bootPage();

      const link = document.createElement("link");
      link.setAttribute("type", "module");
      document.head.append(link);
      link.dispatchEvent(new window.Event("error"));

      expect(within(document.body).queryByRole("alert")).toBeNull();
    });

    // React's LoadingScreen and StartupConnectionError use the boot loader's classes and no id, so
    // the script finds the static boot screen by its id and leaves these alone.
    test.each([
      ["LoadingScreen", LOADING_SCREEN_HTML],
      ["StartupConnectionError", STARTUP_ERROR_HTML],
    ])("the app's %s screen, which has the boot loader's classes and no id", (_name, html) => {
      runBootScript();
      addTemplate();
      const root = document.createElement("div");
      root.id = "root";
      root.innerHTML = html;
      document.body.append(root);
      const before = root.innerHTML;

      failedModuleScript();
      window.dispatchEvent(new window.Event("vite:preloadError"));

      expect(root.innerHTML).toBe(before);
      expect(document.activeElement).toBe(document.body);
    });

    test("the app's screen that replaced the boot screen while a failure waited for the body", () => {
      runBootScript();
      failedModuleScript();
      addTemplate();
      const root = document.createElement("div");
      root.id = "root";
      root.innerHTML = LOADING_SCREEN_HTML;
      document.body.append(root);
      const before = root.innerHTML;

      document.dispatchEvent(new window.Event("DOMContentLoaded"));

      expect(root.innerHTML).toBe(before);
    });

    test("a boot screen that has lost its loading text or its template, and no error from it", () => {
      bootPage();
      document.querySelector(".boot-loader__text")?.remove();
      expect(errorsRaisedBy(() => failedModuleScript())).toEqual([]);
      expect(document.querySelector("[data-load-failed]")).toBeNull();

      document.body.innerHTML = "";
      addBootScreenWithoutTemplate();
      expect(errorsRaisedBy(() => failedModuleScript())).toEqual([]);
      expect(document.querySelector("[data-load-failed]")).toBeNull();
    });

    test("a failure that waited for the body, when no boot screen came", () => {
      runBootScript();
      failedModuleScript();

      expect(
        errorsRaisedBy(() => document.dispatchEvent(new window.Event("DOMContentLoaded")))
      ).toEqual([]);
    });

    test("anything once the app has replaced the boot screen", () => {
      bootPage();
      // React clears the root's children when it renders, which removes the static boot screen.
      document.getElementById("root")?.replaceChildren();

      failedModuleScript();
      window.dispatchEvent(new window.Event("vite:preloadError"));

      expect(within(document.body).queryByRole("alert")).toBeNull();
    });
  });

  test("does not cancel the load error it reports", () => {
    bootPage();

    const event = failedModuleScript();

    expect(event.defaultPrevented).toBe(false);
  });
});

// verify-xum's `idle` and `webkit-capture` end a wait at once, with exit 3, when the page shows a
// failed module load. For the boot screen they read the mark that index.html's script sets, and
// the two live in different files, so these tests run verify-xum's own expression, as bash
// expands it, against the page that script leaves.
describe("verify-xum's check for a module that failed to load", () => {
  /** CHUNK_LOAD_FAILED_JS as bash expands it: the text verify-xum.sh hands to the browser. */
  function chunkLoadFailedExpression(): string {
    const assignment = readFileSync(VERIFY_XUM_SCRIPT, "utf8")
      .split("\n")
      .find((line) => line.startsWith("CHUNK_LOAD_FAILED_JS="));
    if (!assignment) throw new Error("verify-xum.sh has no CHUNK_LOAD_FAILED_JS assignment");
    const run = spawnSync("bash", ["-c", `${assignment}\nprintf %s "$CHUNK_LOAD_FAILED_JS"`], {
      encoding: "utf8",
    });
    if (run.status !== 0 || run.stdout === "")
      throw new Error(`bash could not read it: ${run.stderr}`);
    return run.stdout;
  }

  function pageShowsFailedLoad(): unknown {
    return vm.runInNewContext(chunkLoadFailedExpression(), { document });
  }

  test("says no while the boot screen loads", () => {
    bootPage();

    expect(pageShowsFailedLoad()).toBe(false);
  });

  test("says yes once the boot screen shows that a module failed to load", () => {
    bootPage();
    failedModuleScript();

    expect(pageShowsFailedLoad()).toBe(true);
  });

  test("says yes for a lazily loaded part that failed to load", () => {
    document.body.innerHTML = '<div role="alert"><p>Review failed to load.</p></div>';

    expect(pageShowsFailedLoad()).toBe(true);
  });
});
