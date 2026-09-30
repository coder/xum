import { electronTest as test, electronExpect as expect } from "../electronTest";
import { MOCK_LIST_PROGRAMMING_LANGUAGES } from "../mockAiPrompts";

// Real-browser gate for the chat-send "layout flash" fix. happy-dom cannot evaluate
// native CSS scroll anchoring, sticky positioning, or per-frame layout geometry, so
// the architecture's core invariants are proven here:
//
//   Pillar D — the composer dock is in-flow scroll content (sticky to the
//   scrollport bottom), so growing/collapsing it (the send-time root cause) NEVER
//   changes the transcript scrollport's clientHeight, and the clearance for the
//   last message is reserved by flow layout in the same pass as the height change.
//   Pillar A — the bottom sentinel + native anchoring keep the transcript pinned to
//   the bottom with the last message clear of the composer dock.
//
// clientHeight is a stable per-frame layout property (not a transient paint), so
// sampling it across the send is deterministic rather than flaky.
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

const MESSAGE_WINDOW = '[data-testid="message-window"]';
const COMPOSER_DOCK = '[data-testid="chat-composer-dock"]';
const SENTINEL = '[data-testid="transcript-bottom-sentinel"]';

const TALL_DRAFT = Array.from({ length: 8 }, (_, i) => `draft line ${i + 1}`).join("\n");

test("composer height changes never resize the transcript viewport, and the bottom stays pinned", async ({
  page,
  ui,
}) => {
  await ui.projects.openFirstWorkspace();

  // Seed a transcript so the scrollport is scrollable and a real "last message" exists.
  await ui.chat.sendMessage(MOCK_LIST_PROGRAMMING_LANGUAGES);
  await ui.chat.expectTranscriptContains("Python");

  const input = page.getByRole("textbox", { name: /Message Claude|Edit your last message/ });
  await expect(input).toBeVisible();

  // Baseline: scrollport clientHeight with the composer at its minimum height.
  const baseline = await page.evaluate(
    (sel) => document.querySelector<HTMLElement>(sel)!.clientHeight,
    MESSAGE_WINDOW
  );
  expect(baseline).toBeGreaterThan(0);

  // Pillar D (grow): a tall multi-line draft must enlarge the composer WITHOUT
  // shrinking the scrollport, and flow layout must keep the last message clear of
  // the taller dock (re-pinned by anchoring/ResizeObserver before paint).
  await input.fill(TALL_DRAFT);
  const grown = await page.evaluate(
    ({ win, dock }) => {
      const sp = document.querySelector<HTMLElement>(win)!;
      const composer = document.querySelector<HTMLElement>(dock)!;
      return {
        clientHeight: sp.clientHeight,
        composerHeight: Math.round(composer.getBoundingClientRect().height),
      };
    },
    { win: MESSAGE_WINDOW, dock: COMPOSER_DOCK }
  );
  expect(grown.composerHeight).toBeGreaterThan(0);
  // The headline invariant: a taller composer does not steal scrollport height.
  expect(grown.clientHeight).toBe(baseline);
  // The in-flow dock reserves its own clearance: the transcript stays pinned with
  // the last message above the grown dock.
  await expect
    .poll(() =>
      page.evaluate(
        ({ win, dock }) => {
          const sp = document.querySelector<HTMLElement>(win)!;
          const composer = document.querySelector<HTMLElement>(dock)!;
          const rows = sp.querySelectorAll<HTMLElement>("[data-message-id]");
          const last = rows[rows.length - 1];
          if (!last) return false;
          const pinnedToBottom = sp.scrollHeight - sp.clientHeight - sp.scrollTop <= 4;
          const lastClearsComposer =
            last.getBoundingClientRect().bottom <= composer.getBoundingClientRect().top + 2;
          return pinnedToBottom && lastClearsComposer;
        },
        { win: MESSAGE_WINDOW, dock: COMPOSER_DOCK }
      )
    )
    .toBe(true);

  // Pillar D (collapse): clearing the draft collapses the composer; still no resize.
  await input.fill("");
  await expect
    .poll(() =>
      page.evaluate(
        (dock) =>
          Math.round(document.querySelector<HTMLElement>(dock)!.getBoundingClientRect().height),
        COMPOSER_DOCK
      )
    )
    .toBeLessThan(grown.composerHeight);
  const collapsed = await page.evaluate(
    (sel) => document.querySelector<HTMLElement>(sel)!.clientHeight,
    MESSAGE_WINDOW
  );
  expect(collapsed).toBe(baseline);

  // Sample the scrollport clientHeight repeatedly across the next send. A flash from
  // the composer resizing the viewport (the historical bug) would show up as any
  // sample diverging from the baseline. Sampling is driven from Playwright (not an
  // in-page rAF loop) because requestAnimationFrame is throttled under headless xvfb.
  await input.fill(MOCK_LIST_PROGRAMMING_LANGUAGES);
  const samplingDone = (async () => {
    const samples: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      samples.push(
        await page.evaluate(
          (sel) => document.querySelector<HTMLElement>(sel)!.clientHeight,
          MESSAGE_WINDOW
        )
      );
      await page.waitForTimeout(40);
    }
    return samples;
  })();
  await page.keyboard.press("Enter");
  await ui.chat.expectTranscriptContains("JavaScript");
  const samples = await samplingDone;

  expect(samples.length).toBeGreaterThan(10);
  // Every sample spanning send -> composer collapse -> barrier mount -> user echo ->
  // stream kept the viewport height fixed.
  for (const sample of samples) {
    expect(sample).toBe(baseline);
  }

  // Pillar A: after settling, the transcript is pinned to the bottom, the dock is
  // the last child with the sentinel directly above it, and the last message clears
  // the composer dock — all while the viewport height is still the baseline.
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ win, dock, sentinel, baselineHeight }) => {
            const sp = document.querySelector<HTMLElement>(win)!;
            const composer = document.querySelector<HTMLElement>(dock)!;
            const sentinelEl = document.querySelector<HTMLElement>(sentinel)!;
            const rows = sp.querySelectorAll<HTMLElement>("[data-message-id]");
            const last = rows[rows.length - 1];
            if (!last) return false;
            const pinnedToBottom = sp.scrollHeight - sp.clientHeight - sp.scrollTop <= 4;
            const dockIsLast = sp.lastElementChild === composer;
            const sentinelAboveDock = sentinelEl.nextElementSibling === composer;
            const lastClearsComposer =
              last.getBoundingClientRect().bottom <= composer.getBoundingClientRect().top + 2;
            return (
              sp.clientHeight === baselineHeight &&
              pinnedToBottom &&
              dockIsLast &&
              sentinelAboveDock &&
              lastClearsComposer
            );
          },
          { win: MESSAGE_WINDOW, dock: COMPOSER_DOCK, sentinel: SENTINEL, baselineHeight: baseline }
        ),
      { timeout: 10_000 }
    )
    .toBe(true);
});
