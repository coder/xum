import "../../../../tests/ui/dom";

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { MarkdownFilePreview } from "./MarkdownFilePreview";

const DATA_IMAGE = "data:image/png;base64,iVBORw0KGgo=";

describe("MarkdownFilePreview", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("opening a file loads no image URL and links only to absolute URLs", async () => {
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <MarkdownFilePreview
          content={[
            "![tracker](https://attacker.example/pixel.png)",
            "![loopback](http://127.0.0.1:8080/admin)",
            "![diagram](images/diagram.png)",
            `![inline](${DATA_IMAGE})`,
            "[guide](docs/guide.md) [root](/docs/root.md) [site](https://example.com/page)",
          ].join("\n\n")}
        />
      </ThemeProvider>
    );

    await waitFor(() => expect(view.container.querySelector("img")).not.toBeNull());
    const imageSources = [...view.container.querySelectorAll("img")].map((img) =>
      img.getAttribute("src")
    );
    expect(imageSources).toEqual([DATA_IMAGE]);
    const linkTargets = [...view.container.querySelectorAll("a")].map((a) =>
      a.getAttribute("href")
    );
    expect(linkTargets).toEqual(["https://example.com/page"]);
    expect(view.container.textContent).toContain("guide");
  });

  test("raw HTML in a file shows as typed", async () => {
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <MarkdownFilePreview
          content={"say <b>x</b> here\n\n<details><summary>more</summary>hidden</details>"}
        />
      </ThemeProvider>
    );

    await waitFor(() => expect(view.container.textContent).toContain("say <b>x</b> here"));
    expect(view.container.textContent).toContain(
      "<details><summary>more</summary>hidden</details>"
    );
    expect(view.container.querySelector("b, details")).toBeNull();
  });
});
