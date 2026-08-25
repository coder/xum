import "../dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useState, type ComponentProps } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { QueuedMessage } from "@/browser/features/Messages/QueuedMessage";
import type { QueuedMessage as QueuedMessageData } from "@/common/types/message";
import { installDom } from "../dom";

function createQueuedMessage(overrides?: Partial<QueuedMessageData>): QueuedMessageData {
  return {
    id: "queued-message-1",
    content: "Review this change before sending",
    ...overrides,
  };
}

function QueuedMessageWithErrorFeedback(props: ComponentProps<typeof QueuedMessage>) {
  const [actionError, setActionError] = useState<string | null>(null);
  return (
    <QueuedMessage
      {...props}
      actionError={actionError}
      onActionStart={() => setActionError(null)}
      onActionError={(error) =>
        setActionError(error instanceof Error ? error.message : String(error))
      }
    />
  );
}

function openDispatchMenu(view: ReturnType<typeof render>) {
  fireEvent.click(view.getByRole("button", { name: /queued/i }));
  return view.getByRole("menu");
}

describe("QueuedMessage banner", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("always shows the queued user bubble and opens a dispatch menu without hiding it", () => {
    const view = render(
      <QueuedMessage
        message={createQueuedMessage()}
        onEdit={mock(() => {})}
        onChangeDispatchMode={mock(async () => {})}
        onSendImmediately={mock(async () => {})}
      />
    );

    expect(view.getByText("Review this change before sending")).toBeTruthy();
    expect(view.getByText("Edit")).toBeTruthy();
    openDispatchMenu(view);
    expect(view.getByText("Review this change before sending")).toBeTruthy();
    expect(view.getAllByRole("menuitem")).toHaveLength(3);
  });

  test("keeps a dispatching message visible without editable queue actions", () => {
    const view = render(
      <QueuedMessage
        message={createQueuedMessage({ isDispatching: true })}
        onEdit={mock(() => {})}
        onChangeDispatchMode={mock(async () => {})}
        onSendImmediately={mock(async () => {})}
      />
    );

    expect(view.getByText("Review this change before sending")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(view.getByRole("button", { name: "Sending" }).hasAttribute("disabled")).toBe(true);
    expect(view.queryByRole("menu")).toBeNull();
  });

  test("renders queued preview text and step-dispatch label", () => {
    const view = render(<QueuedMessage message={createQueuedMessage()} />);

    expect(view.getByText("Queued")).toBeTruthy();
    expect(view.getByText("Sends after this step")).toBeTruthy();
    expect(view.getByText("Review this change before sending")).toBeTruthy();
  });

  test("renders turn-dispatch label when queue mode is turn-end", () => {
    const view = render(
      <QueuedMessage message={createQueuedMessage({ queueDispatchMode: "turn-end" })} />
    );

    expect(view.getByText("Sends after this turn")).toBeTruthy();
  });

  test("renders an inner queued bubble inside the banner", () => {
    const view = render(<QueuedMessage message={createQueuedMessage()} />);

    const banner = view.container.querySelector('[data-component="QueuedMessageBanner"]');
    const bubble = view.container.querySelector('[data-component="QueuedMessageCard"]');

    expect(banner).toBeTruthy();
    expect(bubble).toBeTruthy();
  });

  test("keeps only Edit and the queued dropdown as top-level actions", () => {
    const view = render(
      <QueuedMessage
        message={createQueuedMessage()}
        onEdit={mock(() => {})}
        onChangeDispatchMode={mock(async () => {})}
        onSendImmediately={mock(async () => {})}
      />
    );

    expect(view.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(view.getByRole("button", { name: /queued/i })).toBeTruthy();
    expect(view.queryByText("Send now")).toBeNull();
    openDispatchMenu(view);
    expect(view.getByRole("menuitem", { name: "Send after step" })).toBeTruthy();
    expect(view.getByRole("menuitem", { name: "Send after turn" })).toBeTruthy();
    expect(view.getByRole("menuitem", { name: "Send now" })).toBeTruthy();
  });

  test("clicking Edit calls onEdit", () => {
    const onEdit = mock(() => {});
    const view = render(<QueuedMessage message={createQueuedMessage()} onEdit={onEdit} />);

    fireEvent.click(view.getByRole("button", { name: "Edit" }));

    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  test("selecting a deferred mode calls onChangeDispatchMode", async () => {
    const onChangeDispatchMode = mock(async (_mode: "tool-end" | "turn-end") => {});
    const view = render(
      <QueuedMessage message={createQueuedMessage()} onChangeDispatchMode={onChangeDispatchMode} />
    );

    openDispatchMenu(view);
    fireEvent.click(view.getByRole("menuitem", { name: "Send after turn" }));

    await waitFor(() => {
      expect(onChangeDispatchMode).toHaveBeenCalledWith("turn-end");
    });
  });

  test("reapplies the checked mode so the backend can reprioritize visible entries", async () => {
    const onChangeDispatchMode = mock(async (_mode: "tool-end" | "turn-end") => {});
    const view = render(
      <QueuedMessage
        message={createQueuedMessage({ queueDispatchMode: "tool-end" })}
        onChangeDispatchMode={onChangeDispatchMode}
      />
    );

    openDispatchMenu(view);
    fireEvent.click(view.getByRole("menuitem", { name: "Send after step" }));

    await waitFor(() => {
      expect(onChangeDispatchMode).toHaveBeenCalledWith("tool-end");
    });
  });

  test("clicking Send now calls onSendImmediately", async () => {
    const onSendImmediately = mock(async () => {});
    const view = render(
      <QueuedMessage message={createQueuedMessage()} onSendImmediately={onSendImmediately} />
    );

    openDispatchMenu(view);
    fireEvent.click(view.getByRole("menuitem", { name: "Send now" }));

    await waitFor(() => {
      expect(onSendImmediately).toHaveBeenCalledTimes(1);
    });
  });

  test("shows send-now failures inline and allows retry", async () => {
    let attempt = 0;
    const onSendImmediately = mock(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("Connection lost while interrupting");
      }
    });
    const view = render(
      <QueuedMessageWithErrorFeedback
        message={createQueuedMessage()}
        onSendImmediately={onSendImmediately}
      />
    );

    openDispatchMenu(view);
    fireEvent.click(view.getByRole("menuitem", { name: "Send now" }));
    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toContain("Connection lost while interrupting");
    });

    openDispatchMenu(view);
    fireEvent.click(view.getByRole("menuitem", { name: "Send now" }));
    await waitFor(() => {
      expect(onSendImmediately).toHaveBeenCalledTimes(2);
      expect(view.queryByRole("alert")).toBeNull();
    });
  });

  test("keeps Send now visible but disabled when immediate dispatch is unavailable", () => {
    const view = render(<QueuedMessage message={createQueuedMessage()} onEdit={mock(() => {})} />);

    openDispatchMenu(view);
    expect(view.getByRole("menuitem", { name: "Send now" }).hasAttribute("disabled")).toBe(true);
  });

  test("renders file attachment links when non-image fileParts are present", () => {
    const view = render(
      <QueuedMessage
        message={createQueuedMessage({
          fileParts: [
            {
              url: "file:///tmp/example.ts",
              mediaType: "text/plain",
              filename: "example.ts",
            },
          ],
        })}
      />
    );

    expect(view.getByRole("link", { name: "example.ts" })).toBeTruthy();
  });

  test("renders review content inline when reviews are present", () => {
    const view = render(
      <QueuedMessage
        message={createQueuedMessage({
          reviews: [
            {
              filePath: "src/example.ts",
              lineRange: "+1-2",
              selectedCode: "",
              userNote: "Double-check this logic.",
            },
          ],
        })}
      />
    );

    expect(view.getByText(/src\/example\.ts/)).toBeTruthy();
    expect(view.getByText("Double-check this logic.")).toBeTruthy();
  });

  test("strips serialized review payload from preview text", () => {
    const view = render(
      <QueuedMessage
        message={createQueuedMessage({
          content:
            "<review>\nRe src/example.ts:+1-2\n```\nconst x = 1;\n```\n> Fix this\n</review>\n\nPlease also check the tests",
          reviews: [
            {
              filePath: "src/example.ts",
              lineRange: "+1-2",
              selectedCode: "",
              userNote: "Fix this",
            },
          ],
        })}
      />
    );

    expect(view.queryByText(/Re src\/example\.ts/)).toBeNull();
    expect(view.queryByText(/<review>/)).toBeNull();
    expect(view.getByText("Please also check the tests")).toBeTruthy();
  });

  test("preserves user text when reviews are stripped", () => {
    const view = render(
      <QueuedMessage
        message={createQueuedMessage({
          content: "<review>\nRe a.ts:+1-2\n```\ncode\n```\n> note\n</review>\n\nDo this please",
          reviews: [
            {
              filePath: "a.ts",
              lineRange: "+1-2",
              selectedCode: "",
              userNote: "note",
            },
          ],
        })}
      />
    );

    expect(view.getByText("Do this please")).toBeTruthy();
  });

  test("renders combined text, reviews, and attachments via UserMessageContent", () => {
    const view = render(
      <QueuedMessage
        message={createQueuedMessage({
          content:
            "<review>\nRe src/App.tsx:+12-14\n```\nconst ready = true;\n```\n> Please validate edge cases\n</review>\n\nPlease review the bundle output",
          reviews: [
            {
              filePath: "src/App.tsx",
              lineRange: "+12-14",
              selectedCode: "",
              userNote: "Please validate edge cases",
            },
          ],
          fileParts: [
            {
              url: "file:///tmp/screenshot.png",
              mediaType: "image/png",
              filename: "screenshot.png",
            },
            { url: "file:///tmp/data.json", mediaType: "application/json", filename: "data.json" },
          ],
        })}
      />
    );

    expect(view.getByText("Please review the bundle output")).toBeTruthy();
    expect(view.getByText(/src\/App\.tsx/)).toBeTruthy();
    expect(view.getByText("Please validate edge cases")).toBeTruthy();
    expect(view.getByRole("link", { name: "data.json" })).toBeTruthy();
    expect(view.getByAltText("Attachment 1")).toBeTruthy();
  });

  test("renders image attachments using attachment alt text", () => {
    const view = render(
      <QueuedMessage
        message={createQueuedMessage({
          content: "Check these screenshots",
          fileParts: [
            {
              url: "file:///tmp/screenshot.png",
              mediaType: "image/png",
              filename: "screenshot.png",
            },
            { url: "file:///tmp/photo.jpg", mediaType: "image/jpeg", filename: "photo.jpg" },
          ],
        })}
      />
    );

    const images = view.container.querySelectorAll("img");
    expect(images.length).toBe(2);
    expect(view.getByAltText("Attachment 1")).toBeTruthy();
    expect(view.getByAltText("Attachment 2")).toBeTruthy();
    expect(images[0]?.getAttribute("src")).toBe("file:///tmp/screenshot.png");
    expect(images[1]?.getAttribute("src")).toBe("file:///tmp/photo.jpg");
  });

  test("renders all image attachments without overflow counters", () => {
    const view = render(
      <QueuedMessage
        message={createQueuedMessage({
          fileParts: [
            { url: "file:///tmp/1.png", mediaType: "image/png" },
            { url: "file:///tmp/2.png", mediaType: "image/png" },
            { url: "file:///tmp/3.png", mediaType: "image/png" },
            { url: "file:///tmp/4.png", mediaType: "image/png" },
            { url: "file:///tmp/5.png", mediaType: "image/png" },
          ],
        })}
      />
    );

    const images = view.container.querySelectorAll("img");
    expect(images.length).toBe(5);
    expect(view.getByAltText("Attachment 5")).toBeTruthy();
    expect(view.queryByText("+2")).toBeNull();
  });

  test("renders mixed image and file attachments inline", () => {
    const view = render(
      <QueuedMessage
        message={createQueuedMessage({
          fileParts: [
            {
              url: "file:///tmp/screenshot.png",
              mediaType: "image/png",
              filename: "screenshot.png",
            },
            { url: "file:///tmp/data.csv", mediaType: "text/csv", filename: "data.csv" },
            { url: "file:///tmp/doc.pdf", mediaType: "application/pdf", filename: "doc.pdf" },
          ],
        })}
      />
    );

    const images = view.container.querySelectorAll("img");
    expect(images.length).toBe(1);
    expect(view.getByAltText("Attachment 1")).toBeTruthy();
    expect(view.getByRole("link", { name: "data.csv" })).toBeTruthy();
    expect(view.getByRole("link", { name: "doc.pdf" })).toBeTruthy();
  });

  test("image-only queue uses fallback text and attachment rendering", () => {
    const view = render(
      <QueuedMessage
        message={createQueuedMessage({
          content: "",
          fileParts: [
            { url: "file:///tmp/a.png", mediaType: "image/png" },
            { url: "file:///tmp/b.jpg", mediaType: "image/jpeg" },
          ],
        })}
      />
    );

    const images = view.container.querySelectorAll("img");
    expect(images.length).toBe(2);
    expect(view.getByText("Queued message ready")).toBeTruthy();
    expect(view.getByAltText("Attachment 1")).toBeTruthy();
    expect(view.getByAltText("Attachment 2")).toBeTruthy();
    expect(view.queryByText(/\d+ file/)).toBeNull();
    expect(view.queryByText(/\d+ image/)).toBeNull();
  });
});
