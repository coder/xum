import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import * as highlightWorkerClient from "@/browser/utils/highlighting/highlightWorkerClient";
import { MessageListProvider } from "./MessageListContext";
import { getCurrentHighlightedCodeBlockLines, markdownComponents } from "./MarkdownComponents";

function renderCodeBlock(
  className: string,
  children: string,
  openTerminal = mock(() => undefined)
) {
  const view = render(
    <ThemeProvider forcedTheme="dark">
      <MessageListProvider value={{ workspaceId: "ws-1", latestMessageId: null, openTerminal }}>
        {markdownComponents.code({ inline: false, className, children })}
      </MessageListProvider>
    </ThemeProvider>
  );
  return { ...view, openTerminal };
}

function renderMarkdownLink(href: string | undefined, children: string) {
  return render(markdownComponents.a({ href, children }));
}

let cleanupDom: (() => void) | null = null;

beforeEach(() => {
  cleanupDom = installDom();
});

afterEach(() => {
  cleanup();
  cleanupDom?.();
  cleanupDom = null;
});

describe("MarkdownComponents command code blocks", () => {
  // prettier-ignore
  test.each([
    ["bash", "language-bash", "$ npm install\n", "npm install"],
    ["powershell", "language-powershell", "PS C:\\Users\\mike> npm install mux\n", "npm install mux"],
    ["cmd", "language-cmd", "C:\\Users\\mike> dir\n", "dir"],
    ["cmd-continuation", "language-cmd", "C:\\> echo foo ^\n>bar\n", "echo foo ^\nbar"],
    ["shell-continuation", "language-bash", "$ cat <<EOF\n> line 1\n> EOF\n", "cat <<EOF\nline 1\nEOF"],
  ])("runs %s command blocks", (_name, className, children, initialCommand) => {
    const { getByRole, openTerminal } = renderCodeBlock(className, children);

    fireEvent.click(getByRole("button", { name: "Run command" }));

    expect(openTerminal).toHaveBeenCalledWith({ initialCommand });
  });

  test.each([
    ["shell-session", "language-shell-session", "$ echo hello\nhello\n"],
    ["non-shell", "language-typescript", "console.log('hello')\n"],
  ])("hides Run for %s blocks", (_name, className, children) => {
    const { queryByRole } = renderCodeBlock(className, children);

    expect(queryByRole("button", { name: "Run command" })).toBeNull();
  });

  test("ignores highlighted lines from a previous code block revision", () => {
    const highlighted = {
      code: "const oldValue = 1;",
      shikiLanguage: "typescript",
      theme: "dark" as const,
      lines: ["<span>highlighted old value</span>"],
    };

    // A streaming code fence can receive a new chunk while Shiki output for the
    // previous chunk is still cached. The renderer should fall back to current
    // plain text until highlight output catches up to this exact code/theme tuple.
    expect(
      getCurrentHighlightedCodeBlockLines(
        highlighted,
        "const nextValue = 2;\nconsole.log(nextValue);",
        "typescript",
        "dark"
      )
    ).toBeNull();
    expect(
      getCurrentHighlightedCodeBlockLines(highlighted, "const oldValue = 1;", "typescript", "dark")
    ).toEqual(["<span>highlighted old value</span>"]);
  });

  test("aborts the highlight request of a superseded or unmounted code block without warning", async () => {
    const signals: AbortSignal[] = [];
    // Pending until aborted, like a request queued behind a busy worker.
    const highlightSpy = spyOn(highlightWorkerClient, "highlightCode").mockImplementation(
      (_code, _language, _theme, signal) => {
        if (!signal) throw new Error("CodeBlock must pass an AbortSignal");
        signals.push(signal);
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason as Error));
        });
      }
    );
    const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const codeBlock = (children: string) => (
        <ThemeProvider forcedTheme="dark">
          {markdownComponents.code({ inline: false, className: "language-typescript", children })}
        </ThemeProvider>
      );
      const view = render(codeBlock("const a = 1;\n"));
      expect(signals).toHaveLength(1);

      view.rerender(codeBlock("const a = 1;\nconst b = 2;\n"));
      expect(signals).toHaveLength(2);
      expect(signals[0].aborted).toBe(true);
      expect(signals[1].aborted).toBe(false);

      view.unmount();
      expect(signals[1].aborted).toBe(true);
      // Let the rejected requests settle before checking for warnings.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      highlightSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe("MarkdownComponents anchors", () => {
  // prettier-ignore
  test.each([
    ["proxy-template", "https://coder.example.com/@u/ws/apps/mux/", "https://proxy-{{port}}.{{host}}", "http://127.0.0.1:5173/docs?x=1#details", "Open local docs", "https://proxy-5173.coder.example.com/docs?x=1#details", true],
    ["coder-template", "https://5173--dev--pog2--ethan--apps.sydney.fly.dev.coder.com/workspace/f5a5ed5f7e", undefined, "http://127.0.0.1:8080/api/health?x=1#ok", "Open forwarded health", "https://8080--dev--pog2--ethan--apps.sydney.fly.dev.coder.com/api/health?x=1#ok", false],
    ["external", "https://coder.example.com/@u/ws/apps/mux/", "https://proxy-{{port}}.{{host}}", "https://example.com/docs?x=1#details", "Open external docs", "https://example.com/docs?x=1#details", true],
  ])("handles %s links", (_name, locationHref, proxyTemplate, href, label, expectedHref, assertBlankAttrs) => {
    window.location.href = locationHref;
    (window as Window & { __MUX_PROXY_URI_TEMPLATE__?: string }).__MUX_PROXY_URI_TEMPLATE__ =
      proxyTemplate;

    const { getByRole } = renderMarkdownLink(href, label);
    const link = getByRole("link", { name: label });

    expect(link.getAttribute("href")).toBe(expectedHref);
    if (assertBlankAttrs) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  test("keeps undefined href behavior unchanged", () => {
    const { container } = renderMarkdownLink(undefined, "Missing href");
    const link = container.querySelector("a");

    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBeNull();
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
