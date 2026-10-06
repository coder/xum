import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { installDom } from "../../../../tests/ui/dom";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { UserMessageContent } from "./UserMessageContent";

// #5698: user bubbles show the text as typed. Raw HTML renders as literal text, markdown still
// renders, and assistant markdown keeps rendering allowed HTML.
describe("UserMessageContent raw HTML", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("raw HTML typed by the user renders as literal text", () => {
    const view = render(
      <UserMessageContent
        content={"say <b>x</b> here\n\n<details><summary>more</summary>hidden</details>"}
        variant="sent"
      />
    );

    expect(view.container.textContent).toContain("say <b>x</b> here");
    expect(view.container.textContent).toContain(
      "<details><summary>more</summary>hidden</details>"
    );
    expect(view.container.querySelector("b")).toBeNull();
    expect(view.container.querySelector("details")).toBeNull();
    // The HTML block keeps its own paragraph, like the blank line the user typed before it.
    const paragraphs = Array.from(view.container.querySelectorAll("p")).map((p) => p.textContent);
    expect(paragraphs).toEqual([
      "say <b>x</b> here",
      "<details><summary>more</summary>hidden</details>",
    ]);
  });

  test("a multiline HTML block keeps its line breaks", () => {
    const view = render(
      <UserMessageContent
        content={"<details>\n<summary>more</summary>\nhidden\n</details>"}
        variant="sent"
      />
    );

    const paragraph = view.container.querySelector("p");
    expect(paragraph?.textContent).toBe("<details>\n<summary>more</summary>\nhidden\n</details>");
    expect(paragraph?.querySelectorAll("br")).toHaveLength(3);
    expect(view.container.querySelector("details")).toBeNull();
  });

  test("a command prefix bubble also keeps raw HTML as text", () => {
    const view = render(
      <UserMessageContent content={"/skill run <b>x</b>"} commandPrefix="/skill" variant="sent" />
    );

    expect(view.container.textContent).toContain("run <b>x</b>");
    expect(view.container.querySelector("b")).toBeNull();
  });

  test("markdown typed by the user still renders", () => {
    const view = render(
      <UserMessageContent
        content={"**bold** and [link](https://example.com)\n\n- item"}
        variant="sent"
      />
    );

    expect(view.container.querySelector('[data-streamdown="strong"]')?.textContent).toBe("bold");
    expect(view.container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/");
    expect(view.container.querySelector("li")?.textContent).toBe("item");
  });

  test("assistant markdown still renders allowed HTML", () => {
    const view = render(
      <MarkdownRenderer content={"<details><summary>more</summary>hidden</details>"} />
    );

    expect(view.container.querySelector("details summary")?.textContent).toBe("more");
  });
});
