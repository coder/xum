/**
 * Shared steps for bug-bash repro tests (tests/bugbash/repros/*.e2e.ts).
 *
 * Repro tests use exact `screen`/`expect` steps only, so they run without a model key and give the
 * same result on every run. startApp.ts seeds one project (demo-app) and one workspace per run.
 */
import type { Browser } from "@e2e-dev/web";
import type { Locator, Screen } from "e2e";
import { expect } from "e2e";
import { TUTORIAL_STATE_KEY } from "../../../src/common/constants/storage";

export const WORKSPACE_TITLE = "Bug bash playground";

/**
 * Switches tutorials off from the next page load on (a fresh context would show one over the
 * workspace). Tutorial repros skip this helper.
 */
export async function disableTutorials(browser: Browser): Promise<void> {
  await browser.addInitScript(
    (key: string) => localStorage.setItem(key, JSON.stringify({ disabled: true, completed: {} })),
    TUTORIAL_STATE_KEY
  );
}

/**
 * Sends `text` from the composer and returns the Edit button of that message. Every repro in one
 * run shares the seeded workspace, so pick a text no other repro sends: other repros' messages
 * have Edit buttons too.
 */
/**
 * Sends a chat message with the Send button and waits until the composer has taken it. Pressing
 * Enter right after `fill` can arrive before the composer is ready (seen on the phone target).
 */
export async function sendMessage(screen: Screen, text: string): Promise<void> {
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill(text);
  await screen.getByRole("button", "Send message").tap();
  await expect(composer).toHaveValue("", { timeout: 15_000 });
}

export async function sendMessageForEdit(
  screen: Screen,
  browser: Browser,
  text: string
): Promise<Locator> {
  await sendMessage(screen, text);
  const edit = browser
    .locator("[data-message-block]")
    .filter({ hasText: text })
    .getByRole("button", "Edit");
  // The Edit action shows once the backend has accepted the send.
  await expect(edit).toBeVisible({ timeout: 20_000 });
  return edit;
}

/**
 * Selector of the notifications popover's content: the element that Radix registers as a
 * DismissableLayer.
 */
export const NOTIFICATIONS_POPOVER = "[data-radix-popper-content-wrapper] [role=dialog]";

interface LayerProbe {
  arm(selector: string): void;
  state(): string;
}

/**
 * Runs in the page before the app loads (`addInitScript`). It tells the tests when a Radix
 * DismissableLayer (popover, menu, dialog) is ready to take Escape.
 *
 * Why the tests need it: a layer ignores Escape for a short time after it opens. Radix 1.1
 * registers the layer in an effect (`context.layers.add(node)`), then sends
 * `dismissableLayer.update`. Every layer re-renders on that event (`force({})`) and only then
 * computes its true `index`. Its Escape listener reads the handler that the last committed render
 * created, and a passive effect (`useCallbackRef`) installs that handler. Until that re-render has
 * committed and its passive effects have run, `index` is -1 and Escape does nothing. CI's runner
 * sends Escape fast enough to land in that window. A person cannot.
 *
 * The probe proves each step instead of guessing a delay:
 * 1. `arm(selector)` is called before the open.
 * 2. On `dismissableLayer.update`, the probe checks that `context.layers` now holds the element
 *    and records the layer's force state (its second `useState`).
 * 3. React calls `onPostCommitFiberRoot` of the DevTools hook after a commit's passive effects
 *    have run. When the force state differs from the recorded one there, a render after the
 *    registration has committed and its handler is installed: the state is "ready".
 * The probe reads React internals (fiber, hook list) and checks their shape. If Radix or React
 * changes them, `state()` reports an error, and the test fails loudly instead of racing.
 */
function layerProbeInit(): void {
  interface Hook {
    memoizedState: unknown;
    next: Hook | null;
  }
  interface Fiber {
    type: { displayName?: string } | null;
    return: Fiber | null;
    alternate: Fiber | null;
    memoizedState: Hook | null;
    dependencies: { firstContext: { memoizedValue: unknown } | null } | null;
  }
  interface Armed {
    selector: string;
    // Force state at registration. `undefined` until the layer has registered.
    registeredForceState?: unknown;
    ready: boolean;
    error?: string;
  }
  let armed: Armed | null = null;

  const fiberOf = (el: Element): Fiber | null => {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    return key ? ((el as unknown as Record<string, Fiber>)[key] ?? null) : null;
  };
  const layerFiberOf = (el: Element): Fiber | null => {
    let fiber = fiberOf(el);
    while (fiber && fiber.type?.displayName !== "DismissableLayer") fiber = fiber.return;
    return fiber;
  };
  const forceState = (fiber: Fiber | null): unknown => fiber?.memoizedState?.next?.memoizedState;

  document.addEventListener("dismissableLayer.update", () => {
    if (!armed || armed.ready || armed.error || armed.registeredForceState !== undefined) return;
    const el = document.querySelector(armed.selector);
    if (!el) return;
    const found = layerFiberOf(el);
    if (!found) {
      armed.error = "probe: no DismissableLayer fiber above the element (Radix changed?)";
      return;
    }
    // React keeps two fibers per component. Hook 1 is `node`: the fiber that has rendered with
    // `node` set to this element is the newer one. Before that render the layer cannot have
    // registered, so an update event then comes from another layer.
    const fiber = [found, found.alternate].find((f) => f?.memoizedState?.memoizedState === el);
    if (!fiber) return;
    const context = fiber.dependencies?.firstContext?.memoizedValue as
      | { layers?: unknown }
      | undefined;
    // Hook 2 is the force state, an object.
    const force = forceState(fiber);
    if (!(context?.layers instanceof Set) || typeof force !== "object" || force === null) {
      armed.error = "probe: DismissableLayer context or force state changed shape (Radix changed?)";
      return;
    }
    // This event can come from another layer; only this element's registration counts.
    if (!context.layers.has(el)) return;
    armed.registeredForceState = force;
  });

  (
    window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }
  ).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    checkDCE: () => undefined,
    onScheduleFiberRoot: () => undefined,
    onCommitFiberRoot: () => undefined,
    onCommitFiberUnmount: () => undefined,
    onPostCommitFiberRoot: () => {
      if (!armed || armed.ready || armed.registeredForceState === undefined) return;
      const el = document.querySelector(armed.selector);
      const fiber = el ? layerFiberOf(el) : null;
      if (!fiber) return;
      // React keeps two fibers per component, and only one is committed. The other still holds
      // the older state, so a change on either one means a newer render committed.
      const before = armed.registeredForceState;
      if (forceState(fiber) !== before || forceState(fiber.alternate) !== before) {
        armed.ready = true;
      }
    },
  };

  const probe: LayerProbe = {
    arm: (selector) => {
      armed = { selector, ready: false };
    },
    state: () => {
      if (!armed) return "not armed: call armLayerProbe before the open";
      if (armed.error) return armed.error;
      if (armed.ready) return "ready";
      return armed.registeredForceState === undefined ? "not registered" : "registered";
    },
  };
  (window as unknown as { __layerProbe: LayerProbe }).__layerProbe = probe;
}

/** Call before the next open of the layer that `selector` matches. */
export async function armLayerProbe(browser: Browser, selector: string): Promise<void> {
  await browser.evaluate((s: string) => {
    (window as unknown as { __layerProbe: LayerProbe }).__layerProbe.arm(s);
    return null;
  }, selector);
}

/**
 * Waits until the armed layer takes Escape (see layerProbeInit). The caller then presses Escape
 * once, as a person does.
 */
export async function waitForLayerEscapeReady(browser: Browser): Promise<void> {
  await expect
    .poll(() =>
      browser.evaluate(() =>
        (window as unknown as { __layerProbe: LayerProbe }).__layerProbe.state()
      )
    )
    .toBe("ready");
}

/** Opens the app with tutorials off and selects the seeded workspace. */
export async function openPlayground(
  app: { open(path?: string): Promise<void> },
  screen: Screen,
  browser: Browser
): Promise<void> {
  await disableTutorials(browser);
  await browser.addInitScript(layerProbeInit);
  await app.open();
  // A fresh context starts with the project collapsed in the sidebar.
  const expand = screen.getByRole("button", "Expand project demo-app");
  await expect(screen.getByText("demo-app").first()).toBeVisible({ timeout: 15_000 });
  // The phone layout hides the sidebar behind a menu button.
  const sidebarMenu = screen.getByRole("button", "Open sidebar menu");
  if (await sidebarMenu.isVisible()) {
    await sidebarMenu.tap();
    await expect(screen.getByRole("navigation", "Projects").getByText("demo-app")).toBeVisible();
  }
  if (await expand.isVisible()) await expand.tap();
  await screen.getByText(WORKSPACE_TITLE).first().tap();
  await expect(screen.getByRole("button", "Notifications")).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Asserts the "Notify on all responses" setting: opens the bell's settings popover, reads the
 * checkbox, and closes it with Escape. A click on the bell only opens the popover (#5691).
 */
export async function expectNotifyOnAllResponses(
  screen: Screen,
  browser: Browser,
  checked: boolean
): Promise<void> {
  await armLayerProbe(browser, NOTIFICATIONS_POPOVER);
  await screen.getByRole("button", "Notifications").tap();
  const setting = screen.getByRole("checkbox", /^Notify on all responses/);
  await expect(setting).toBeVisible();
  if (checked) {
    await expect(setting).toBeChecked();
  } else {
    await expect(setting).not.toBeChecked();
  }
  await waitForLayerEscapeReady(browser);
  await browser.keyboard.press("Escape");
  await expect(setting).toBeHidden();
}
