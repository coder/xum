import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, render } from "@testing-library/react";
import type { ReviewActionCallbacks } from "@/browser/features/Shared/InlineReviewNote";
import type { Review, ReviewNoteData } from "@/common/types/review";
import * as RealDiffRendererModule from "@/browser/features/Shared/DiffRenderer";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";

interface MockSelectableDiffRendererProps {
  content: string;
  filePath: string;
  inlineReviews?: Review[];
  onReviewNote?: (data: ReviewNoteData) => void;
  reviewActions?: ReviewActionCallbacks;
  showLineNumbers?: boolean;
  lineNumberMode?: "both" | "old" | "new";
  oldStart?: number;
  newStart?: number;
  fontSize?: string;
  maxHeight?: string;
}

const selectableDiffRendererMock = mock((props: MockSelectableDiffRendererProps) => (
  <div data-testid="selectable-diff-renderer">
    <div data-testid="mock-file-path">{props.filePath}</div>
    <pre data-testid="mock-content">{props.content}</pre>
  </div>
));

// Snapshot the real exports before mocking so later suites (e.g. the drag-select renderer
// test) get the real SelectableDiffRenderer back once this file finishes.
restoreModulesAfterSuite([
  ["@/browser/features/Shared/DiffRenderer", { ...RealDiffRendererModule }],
]);
void mock.module("@/browser/features/Shared/DiffRenderer", () => ({
  SelectableDiffRenderer: (props: MockSelectableDiffRendererProps) =>
    selectableDiffRendererMock(props),
}));

import { PlanAnnotationView } from "@/browser/features/Tools/PlanAnnotationView";

function getLastSelectableRendererProps(): MockSelectableDiffRendererProps {
  const calls = selectableDiffRendererMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]?.[0];
}

describe("PlanAnnotationView", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    selectableDiffRendererMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("renders plan lines as visible text content", () => {
    const view = render(
      <PlanAnnotationView
        planContent={"# Plan Title\n\n- First step\n- Second step\n"}
        reviews={[]}
        reviewActions={{}}
      />
    );

    const renderedContent = view.getByTestId("mock-content").textContent ?? "";
    expect(renderedContent).toContain("# Plan Title");
    expect(renderedContent).toContain("- First step");
    expect(renderedContent).toContain("- Second step");
  });

  test("renders empty content without crashing", () => {
    const view = render(
      <PlanAnnotationView
        planContent=""
        reviews={[]}
        reviewActions={{}}
        planPath="docs/empty-plan.md"
      />
    );

    expect(view.getByTestId("selectable-diff-renderer")).toBeTruthy();
    expect(getLastSelectableRendererProps().content).toBe("");
  });

  test("handles content with no trailing newline", () => {
    render(
      <PlanAnnotationView
        planContent={"Step one\nStep two"}
        reviews={[]}
        reviewActions={{}}
        planPath="docs/no-trailing-newline.md"
      />
    );

    expect(getLastSelectableRendererProps().content).toBe(" Step one\n Step two");
  });

  test("uses plan.md as fallback filePath when planPath is undefined", () => {
    render(<PlanAnnotationView planContent={"Only line\n"} reviews={[]} reviewActions={{}} />);

    expect(getLastSelectableRendererProps().filePath).toBe("plan.md");
  });

  test("renders with all required props", () => {
    const onReviewNote = mock((_data: ReviewNoteData) => undefined);
    const reviewActions: ReviewActionCallbacks = {
      onEditComment: mock(() => undefined),
      onComplete: mock(() => undefined),
      onUncheck: mock(() => undefined),
      onAttach: mock(() => undefined),
      onDetach: mock(() => undefined),
      onDelete: mock(() => undefined),
    };
    const reviews: Review[] = [
      {
        id: "review-1",
        status: "pending",
        createdAt: 1,
        data: {
          filePath: "docs/plan.md",
          lineRange: "+1",
          selectedCode: "1   Step one",
          userNote: "Consider refining this step",
        },
      },
    ];

    render(
      <PlanAnnotationView
        planContent={"Step one\n"}
        planPath="docs/plan.md"
        onReviewNote={onReviewNote}
        reviews={reviews}
        reviewActions={reviewActions}
      />
    );

    const props = getLastSelectableRendererProps();
    expect(props.filePath).toBe("docs/plan.md");
    expect(props.inlineReviews).toBe(reviews);
    expect(props.onReviewNote).toBe(onReviewNote);
    expect(props.reviewActions).toBe(reviewActions);
    expect(props.showLineNumbers).toBe(true);
    expect(props.lineNumberMode).toBe("new");
    expect(props.oldStart).toBe(1);
    expect(props.newStart).toBe(1);
    expect(props.fontSize).toBe("12px");
    expect(props.maxHeight).toBe("none");
  });
});
