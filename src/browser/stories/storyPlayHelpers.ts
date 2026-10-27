import { userEvent, waitFor, within } from "storybook/test";

/**
 * Open (or show) the New tab of the right sidebar pane inside `scope` with the "+" button after
 * its tabs.
 */
export async function openSidebarNewTab(scope: HTMLElement): Promise<void> {
  await userEvent.click(await within(scope).findByRole("button", { name: "New tab" }));
}

/**
 * Open Settings from the titlebar button and return the Settings dialog. The page behind the
 * modal stays mounted, so plays should query within the dialog rather than the whole canvas.
 */
export async function openSettingsDialog(canvasElement: HTMLElement): Promise<HTMLElement> {
  await openLeftSidebar(canvasElement);
  await userEvent.click(within(canvasElement).getByTestId("settings-button"));
  return findSettingsDialog(canvasElement.ownerDocument);
}

/**
 * Open the left sidebar when it is collapsed, so plays can reach its controls (the titlebar's
 * settings button, project rows). At phone widths (Pixel's phone and tablet variants) the sidebar
 * is a drawer that starts closed each time a story mounts, whatever `expandLeftSidebar()` saved.
 */
export async function openLeftSidebar(canvasElement: HTMLElement): Promise<void> {
  const canvas = within(canvasElement);
  const openToggle = () => canvas.queryByRole("button", { name: "Open sidebar menu" });
  await waitFor(
    () => {
      if (!canvas.queryByTestId("settings-button") && !openToggle()) {
        throw new Error("Neither the sidebar nor its open toggle rendered yet");
      }
    },
    { timeout: 10000 }
  );
  const toggle = canvas.queryByTestId("settings-button") ? null : openToggle();
  if (toggle) {
    // A native click: userEvent's synthetic hover could leave the toggle's tooltip in a snapshot.
    toggle.click();
    await canvas.findByTestId("settings-button", {}, { timeout: 10000 });
  }
}

/**
 * Find the open Settings dialog once it takes clicks. Settings is lazy-loaded, so its first open
 * commits when the chunk arrives, not inside the opening event. Radix's modal layer then sets
 * `pointer-events: none` on the body in an effect and sets `auto` on the dialog one render later,
 * so a click right after the dialog appears can hit `pointer-events: none`.
 */
export async function findSettingsDialog(doc: Document = document): Promise<HTMLElement> {
  const dialog = await within(doc.body).findByRole(
    "dialog",
    { name: "Settings" },
    { timeout: 10000 }
  );
  return waitForModalLayer(dialog);
}

/**
 * Wait until a Radix modal layer (Dialog, AlertDialog) is registered and on top, then return it.
 * A new layer renders with `pointer-events: none` and an unknown stack index. Its effect then
 * registers it, and only the re-render after that sets inline `auto`, Radix's own signal. Before
 * it, clicks fail with "pointer-events: none" and Escape is ignored (#7648).
 */
export async function waitForModalLayer(dialog: HTMLElement): Promise<HTMLElement> {
  await waitFor(
    () => {
      if (dialog.style.pointerEvents !== "auto") {
        throw new Error("Modal layer does not take pointer events yet");
      }
    },
    { timeout: 5000 }
  );
  return dialog;
}

/**
 * Close a non-modal Radix layer (a Popover) with Escape and wait until it is gone. Radix ignores
 * Escape until the layer's re-render after its mount effect registers it on top
 * (react-dismissable-layer `index.mjs` :40 index, :60 isHighestLayer, :94 re-render), and a
 * non-modal layer shows no DOM signal for that re-render (#7650). So this presses Escape again
 * while the layer is still open. Trade-off: a play using it proves that Escape closes the
 * layer, not that the FIRST Escape does. An accepted Escape sets `data-state="closed"` in the
 * same event, so no Escape is pressed after the layer took one.
 */
export async function closeWithEscape(layer: HTMLElement): Promise<void> {
  await waitFor(
    async () => {
      if (layer.getAttribute("data-state") === "open") {
        await userEvent.keyboard("{Escape}");
      }
      if (layer.isConnected) {
        throw new Error("Layer is still open");
      }
    },
    { timeout: 5000 }
  );
}

/**
 * Click `element` once it takes pointer events. Use it for a control in a modal layer that just
 * opened or just came back on top (a nested confirm closed), when the play does not hold that
 * layer's element; with the element, use waitForModalLayer.
 */
export async function clickWhenReady(element: HTMLElement): Promise<void> {
  await waitFor(
    () => {
      if (getComputedStyle(element).pointerEvents === "none") {
        throw new Error("Element does not take pointer events yet");
      }
    },
    { timeout: 5000 }
  );
  await userEvent.click(element);
}

export function getSettingsDialog(): HTMLElement {
  return within(document.body).getByRole("dialog", { name: "Settings" });
}

/**
 * Wait until AppLoader's fade-in has committed. Motion cancels the finished WAAPI fade a frame
 * before it writes the final opacity, so for that frame the app shell reads opacity 0 and a
 * direct toBeVisible on any element inside it fails.
 */
export async function waitForAppFadeInDone(element: Element): Promise<void> {
  await waitFor(
    () => {
      for (let node: Element | null = element; node; node = node.parentElement) {
        if (getComputedStyle(node).opacity !== "1" || node.getAnimations().length > 0) {
          throw new Error("App shell is still fading in");
        }
      }
    },
    { timeout: 5000 }
  );
}

/**
 * Wait for chat messages to finish loading.
 *
 * Waits for data-loaded="true" on the message window, then one RAF
 * to let any pending coalesced scroll from useAutoScroll complete.
 */
export async function waitForChatMessagesLoaded(canvasElement: HTMLElement): Promise<void> {
  // Use 25s timeout to handle CI cold-start scenarios where large dependencies
  // (Shiki, Mermaid) are still being loaded/initialized on busy runners
  await waitFor(
    () => {
      const messageWindow = canvasElement.querySelector('[data-testid="message-window"]');
      if (messageWindow?.getAttribute("data-loaded") !== "true") {
        throw new Error("Messages not loaded yet");
      }
    },
    { timeout: 25000 }
  );

  // One RAF to let any pending coalesced scroll complete
  await new Promise((r) => requestAnimationFrame(r));
}

export async function waitForChatInputAutofocusDone(canvasElement: HTMLElement): Promise<void> {
  await waitFor(
    () => {
      const state = canvasElement
        .querySelector('[data-component="ChatInputSection"]')
        ?.getAttribute("data-autofocus-state");
      if (state !== "done") {
        throw new Error("ChatInput auto-focus not finished");
      }
    },
    { timeout: 5000 }
  );
}

export function blurActiveElement(): void {
  (document.activeElement as HTMLElement | null)?.blur?.();
}

/**
 * Wait for chat messages to load and async rendering (markdown, etc.) to settle.
 *
 * Use this for stories with MarkdownRenderer content that changes element heights
 * after rendering, triggering ResizeObserver scroll. Waits for messages to load
 * plus double-RAF for coalesced scroll to fire and layout to settle.
 */
export async function waitForScrollStabilization(canvasElement: HTMLElement): Promise<void> {
  await waitForChatMessagesLoaded(canvasElement);

  // Wait 2 RAFs: one for coalesced scroll to fire, one for layout to settle
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

/**
 * Opens the panel of a chip in the composer's live line (TODO, sub-agents, background bashes,
 * reviews), which starts closed. `dataComponent` names the decoration that renders the chip.
 */
export async function openChatActivityPanel(
  root: HTMLElement,
  dataComponent: string
): Promise<HTMLElement> {
  const chip = await waitFor(
    () => {
      const found = root.querySelector<HTMLElement>(
        `[data-component="${dataComponent}"] [data-activity-chip]`
      );
      if (found === null) throw new Error(`${dataComponent} chip not found`);
      return found;
    },
    { timeout: 10_000 }
  );
  if (chip.getAttribute("aria-expanded") !== "true") {
    await userEvent.click(chip);
  }
  return chip;
}

/**
 * The live line's open panel. Phone viewports open it in the activity sheet, which portals to the
 * body, so this looks in the whole document rather than in the line.
 */
export async function findChatActivityPanel(): Promise<HTMLElement> {
  return waitFor(() => {
    const found = document.querySelector<HTMLElement>("[data-activity-panel]");
    if (found === null) throw new Error("No live-line panel is open");
    return found;
  });
}
