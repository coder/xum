import { cleanup, act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import type { ReviewNoteDataForDisplay } from "@/common/types/message";

import * as RealTooltipModule from "@/browser/components/Tooltip/Tooltip";
import * as RealDiffRendererModule from "@/browser/features/Shared/DiffRenderer";
import { ReviewBlockFromData } from "./ReviewBlock";

restoreModulesAfterSuite([
  ["@/browser/components/Tooltip/Tooltip", { ...RealTooltipModule }],
  ["@/browser/features/Shared/DiffRenderer", { ...RealDiffRendererModule }],
]);
// The card's action buttons are each wrapped in a Tooltip and the snippet goes through the syntax
// highlighter, both of which need ThemeProvider. What matters here is the text handed to each sink,
// so both become plain renders.
void mock.module("@/browser/components/Tooltip/Tooltip", () => ({
  ...RealTooltipModule,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
void mock.module("@/browser/features/Shared/DiffRenderer", () => ({
  ...RealDiffRendererModule,
  DiffRenderer: ({ content }: { content: string }) => <pre>{content}</pre>,
}));

/** Tag characters (U+E0020-U+E007F) carry ASCII one-to-one, so a run of them spells hidden text. */
const tags = (ascii: string) =>
  [...ascii].map((char) => String.fromCodePoint(0xe0000 + char.charCodeAt(0))).join("");

const MARKS = "<U+E0069><U+E006E><U+E0076><U+E0061>";
const TAGGED_NOTE = `check this${tags("inva")}`;

function reviewData(overrides: Partial<ReviewNoteDataForDisplay> = {}): ReviewNoteDataForDisplay {
  return {
    filePath: "src/payments.ts",
    lineRange: "-12",
    // Embedded line numbers keep the snippet on the plain <pre> path instead of the diff renderer.
    selectedCode: `12 ${tags("inva")}de auth`,
    selectedDiff: undefined,
    userNote: TAGGED_NOTE,
    ...overrides,
  };
}

describe("ReviewBlockFromData invisible-tag handling", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  const card = (props: {
    data: ReviewNoteDataForDisplay;
    onEditComment?: (note: string) => void;
  }) => <ReviewBlockFromData {...props} />;

  test("reveals the payload in the note and the snippet", () => {
    const view = render(card({ data: reviewData() }));

    expect(view.container.textContent).toContain(`check this${MARKS}`);
    expect(view.container.textContent).toContain(`12 ${MARKS}de auth`);
    expect(view.container.textContent).not.toContain(tags("inva"));
  });

  test("reveals the payload in the file header", () => {
    const view = render(card({ data: reviewData({ filePath: `src/${tags("evil")}payments.ts` }) }));

    expect(view.container.textContent).toContain("src/<U+E0065><U+E0076><U+E0069><U+E006C>");
  });

  test("reveals the payload in a diff snippet as well as plain code", () => {
    const view = render(
      card({
        data: reviewData({
          selectedCode: undefined as unknown as string,
          selectedDiff: `-${tags("inva")}de auth`,
        }),
      })
    );
    expect(view.container.textContent).toContain(`-${MARKS}de auth`);
  });

  test("hands the raw bytes back when the note is edited, so the mark is never stored", async () => {
    // The card is also the ChatInput preview: an edit writes straight back into the review that is
    // about to be sent, so a revealed draft would persist 8 ASCII characters per invisible one.
    const original = TAGGED_NOTE;
    const revised = `${original} later`;
    const saved: string[] = [];
    const view = render(
      card({
        data: reviewData({ userNote: original }),
        onEditComment: (note) => saved.push(note),
      })
    );

    fireEvent.click(
      view.container.querySelector<HTMLButtonElement>('[aria-label="Edit comment"]')!
    );
    const textarea = view.container.querySelector("textarea");
    if (!textarea) throw new Error("No edit textarea rendered");
    expect(textarea.value).toBe(original);

    // happy-dom misses React's onChange for fireEvent.change, so call the handler the way the real
    // input event would.
    const reactPropsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps"));
    if (!reactPropsKey) throw new Error("Textarea exposes no React props");
    const props = textarea[reactPropsKey as keyof typeof textarea] as {
      onChange?: (event: { target: { value: string } }) => void;
    };
    await act(async () => {
      props.onChange?.({ target: { value: revised } });
      await Promise.resolve();
    });

    const save = Array.from(view.container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Save"
    );
    if (!save) throw new Error("No Save button rendered");
    fireEvent.click(save);

    expect(saved).toEqual([revised]);
    expect(saved[0]).not.toContain("<U+");
  });
});
