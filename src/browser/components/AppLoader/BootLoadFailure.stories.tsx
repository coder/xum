import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";
import { PIXEL_DISABLED, lightweightMeta } from "@/browser/stories/meta.js";
import indexHtml from "virtual:index-html";

// The boot screen when the app's module graph fails to load. Nothing in that graph can run then,
// React included, so this state is index.html's own markup, style and script, not a component.
// The story builds it from index.html itself and fails a module script the way a browser does, so
// it cannot drift from what ships. Pixel skips it (the snapshot budget is deliberate): the Desktop
// and Phone stories show the screen at both widths.
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

async function expectReloadPrompt(container: HTMLElement) {
  const canvas = within(container);
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

// The story test runner ignores `globals.viewport` (it only helps a person who opens the story),
// and a fixed-width wrapper keeps the page's own viewport: the boot screen is `100vw` wide. An
// iframe has a viewport of its own, so the phone story runs the same boot screen in a 390px one.
const PHONE_WIDTH_PX = 390;

/** Fills the phone iframe with index.html's styles, boot screen and script, then fails a module. */
function failBootScreenInPhoneFrame(frame: HTMLIFrameElement | null): void {
  if (!frame || frame.srcdoc) return;
  // SECURITY AUDIT: indexHtml is this repo's own index.html, bundled at build time. No user,
  // repo-content or network data reaches the parser or the document that srcdoc builds from it.
  const page = new DOMParser().parseFromString(indexHtml, "text/html");
  const outer = (selector: string) => {
    const part = page.querySelector(selector);
    if (!part) throw new Error(`index.html has no ${selector}`);
    return part.outerHTML;
  };
  const styles = [...page.querySelectorAll("style")].map((style) => style.outerHTML).join("");
  frame.addEventListener(
    "load",
    () => {
      const doc = frame.contentDocument;
      if (!doc) throw new Error("the phone frame has no document");
      const failed = doc.createElement("script");
      failed.type = "module";
      doc.head.append(failed);
      failed.dispatchEvent(new Event("error"));
      failed.remove();
    },
    { once: true }
  );
  frame.srcdoc = `<!doctype html><html><head>${styles}${outer("#boot-load-failure-script")}</head><body>${outer("#root")}${outer("#boot-load-failure")}</body></html>`;
}

export const Phone: Story = {
  render: () => (
    <iframe
      title="Phone viewport"
      ref={failBootScreenInPhoneFrame}
      style={{ width: PHONE_WIDTH_PX, height: 700, border: 0 }}
    />
  ),
  play: async ({ canvasElement }) => {
    const frame = within(canvasElement).getByTitle<HTMLIFrameElement>("Phone viewport");
    const win = frame.contentWindow;
    if (!win) throw new Error("the phone frame has no window");
    await waitFor(() => expect(win.document.querySelector("[role=alert]")).not.toBeNull());
    await expectReloadPrompt(win.document.body);
    await expect(win.innerWidth).toBe(PHONE_WIDTH_PX);
    // Nothing sticks out of a 390px screen, and the page does not scroll sideways.
    const box = win.document.querySelector("[role=alert]")?.getBoundingClientRect();
    await expect(box?.left).toBeGreaterThanOrEqual(0);
    await expect(box?.right).toBeLessThanOrEqual(PHONE_WIDTH_PX);
    await expect(win.document.documentElement.scrollWidth).toBeLessThanOrEqual(PHONE_WIDTH_PX);
  },
};
