import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { PIXEL_DISABLED, lightweightMeta } from "@/browser/stories/meta.js";
import indexHtml from "virtual:index-html";

// The boot screen when the app's module graph fails to load. Nothing in that graph can run then,
// React included, so this state is index.html's own markup, style and script, not a component.
// The story builds it from index.html itself and fails a module script the way a browser does, so
// it cannot drift from what ships. Pixel skips it (the snapshot budget is deliberate); the screens
// at phone and desktop width are in the PR that added it.
const meta: Meta = {
  ...lightweightMeta,
  title: "Components/AppLoader/BootLoadFailure",
  parameters: {
    ...lightweightMeta.parameters,
    pixel: PIXEL_DISABLED,
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

/** The static boot screen from index.html, then a module script that fails to load. */
function failBootScreen(host: HTMLDivElement | null): void {
  if (!host || host.childElementCount > 0) return;
  // SECURITY AUDIT: indexHtml is this repo's own index.html, bundled at build time. No user,
  // repo-content or network data reaches the parser, the imported nodes or the script text.
  const page = new DOMParser().parseFromString(indexHtml, "text/html");
  for (const id of ["root", "boot-load-failure"]) {
    const part = page.getElementById(id);
    if (!part) throw new Error(`index.html has no #${id}`);
    host.append(document.importNode(part, true));
  }
  const source = page.getElementById("boot-load-failure-script")?.textContent;
  if (!source) throw new Error("index.html has no boot-load-failure script");
  // An inline script runs against this page's window, as it does in a real page.
  const script = document.createElement("script");
  script.textContent = source;
  document.head.append(script);
  script.remove();
  // The browser fires a load error at the element, and the script listens while capturing.
  const failed = document.createElement("script");
  failed.type = "module";
  document.head.append(failed);
  failed.dispatchEvent(new Event("error"));
  failed.remove();
}

async function expectReloadPrompt(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const alert = await canvas.findByRole("alert");
  await expect(within(alert).getByRole("heading", { level: 1 })).toBeVisible();
  await expect(canvas.queryByRole("status")).toBeNull();
  // Focused, so Enter reloads.
  await expect(within(alert).getByRole("button")).toHaveFocus();
}

export const Desktop: Story = {
  render: () => <div ref={failBootScreen} />,
  play: ({ canvasElement }) => expectReloadPrompt(canvasElement),
};

export const Phone: Story = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
  render: () => <div ref={failBootScreen} />,
  play: ({ canvasElement }) => expectReloadPrompt(canvasElement),
};
