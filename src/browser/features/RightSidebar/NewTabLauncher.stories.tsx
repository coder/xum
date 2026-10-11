import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "@storybook/test";
import { NewTabLauncher } from "./NewTabLauncher";
import { PIXEL_DISABLED } from "@/browser/stories/meta.js";
import type { McpAppEntrypoint } from "@/common/orpc/schemas/mcpApps";

const ENTRYPOINTS: McpAppEntrypoint[] = [
  {
    serverName: "bits-and-bolts",
    serverLabel: "bits-and-bolts",
    toolName: "cad.library",
    title: "CAD Parts Library",
    resourceUri: "ui://bits-and-bolts/library",
    type: "global",
    viewKey: "entrypoint:bits-and-bolts:cad.library:global",
  },
  {
    // A plugin server: the row shows its label, never the internal key, and a long label
    // stays on one line at phone width (the Tooltip has the full text).
    serverName: "plugin:0123456789abcdef:tray",
    serverLabel: "bits-and-bolts-parts-and-fasteners-catalog · tray-with-a-very-long-server-name",
    toolName: "cad.tray",
    title: "Parts Tray",
    resourceUri: "ui://bits-and-bolts/tray",
    type: "thread",
    viewKey: "entrypoint:tray:cad.tray:thread",
  },
];

const meta = {
  title: "Features/RightSidebar/NewTabLauncher",
  component: NewTabLauncher,
  parameters: {
    layout: "fullscreen",
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } },
  },
  globals: { viewport: { value: "mobile1", isRotated: false } },
  // The test runner ignores viewport globals; keep the layout narrow there too (stories may
  // pin another width with `parameters.launcherWidth`).
  decorators: [
    (Story, context) => (
      <div
        style={{
          width: (context.parameters.launcherWidth as number | undefined) ?? 375,
          maxWidth: "100%",
        }}
      >
        <Story />
      </div>
    ),
  ],
  args: {
    tools: ["costs", "review", "instructions", "goal", "workflows", "timeline", "output"],
    onOpenTool: fn(),
    onOpenTerminal: fn(),
    onOpenSideChat: fn(),
    creatingSideChat: false,
    autoFocus: false,
    onAutoFocusConsumed: fn(),
  },
} satisfies Meta<typeof NewTabLauncher>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SideChatRow: Story = {
  // The composite sidebar scene covers appearance; retain the pinned phone/keyboard contract.
  parameters: { pixel: PIXEL_DISABLED },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const row = canvas.getByRole("button", { name: "Side chat" });
    const terminal = canvas.getByRole("button", { name: "Terminal" });
    // Same list and keyboard navigation as every other launcher action, not a separate tip.
    await expect(row.parentElement).toBe(terminal.parentElement);
    terminal.focus();
    await userEvent.keyboard("{ArrowDown}");
    await expect(row).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(args.onOpenSideChat).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{ArrowUp}");
    await expect(terminal).toHaveFocus();
    await userEvent.click(row);
    await expect(args.onOpenSideChat).toHaveBeenCalledTimes(2);
    const container = canvasElement.firstElementChild!;
    await expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
    // The runner ignores globals, but local/Pixel phone viewports must hide keyboard hints.
    if (window.innerWidth <= 768) await expect(row.querySelector("kbd")).not.toBeVisible();
  },
};

/** The "Plugin views" section: one row per MCP App entry point, keyboard-navigable like tools. */
async function expectPluginViews(canvasElement: HTMLElement, onOpen: unknown) {
  const canvas = within(canvasElement);
  await expect(canvas.getByText("Plugin views")).toBeVisible();
  const library = canvas.getByRole("button", { name: "CAD Parts Library" });
  const tray = canvas.getByRole("button", { name: "Parts Tray" });
  library.focus();
  await userEvent.keyboard("{ArrowDown}");
  await expect(tray).toHaveFocus();
  await userEvent.click(library);
  await expect(onOpen).toHaveBeenCalledWith(ENTRYPOINTS[0]);
  const container = canvasElement.firstElementChild!;
  await expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
  await expect(canvasElement.textContent).not.toContain("plugin:0123456789abcdef");
  // The long label is one line, cut with an ellipsis.
  const label = canvas.getByText(ENTRYPOINTS[1].serverLabel);
  await expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
  await expect(label.getBoundingClientRect().height).toBeLessThan(20);
}

export const PluginViewsDesktop: Story = {
  args: { entrypoints: ENTRYPOINTS, onOpenEntrypoint: fn(() => Promise.resolve(null)) },
  // The right sidebar's default desktop width.
  parameters: {
    launcherWidth: 400,
    // Play only: the Pixel cap is shared with all of main, and this adds no snapshots.
    pixel: PIXEL_DISABLED,
  },
  globals: { viewport: { value: "desktop", isRotated: false } },
  play: async ({ canvasElement, args }) => {
    await expectPluginViews(canvasElement, args.onOpenEntrypoint);
  },
};

/** Phones show the launcher in the full-screen sidebar: the whole 390px width. */
export const PluginViewsPhone: Story = {
  args: { entrypoints: ENTRYPOINTS, onOpenEntrypoint: fn(() => Promise.resolve(null)) },
  parameters: {
    launcherWidth: 390,
    // Play only: the Pixel cap is shared with all of main, and this adds no snapshots.
    pixel: PIXEL_DISABLED,
  },
  play: async ({ canvasElement, args }) => {
    await expectPluginViews(canvasElement, args.onOpenEntrypoint);
  },
};

export const PluginViewOpenError: Story = {
  args: {
    entrypoints: ENTRYPOINTS,
    onOpenEntrypoint: fn(() => Promise.resolve("Too many entry point opens for 'bits-and-bolts'")),
  },
  parameters: { pixel: PIXEL_DISABLED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "CAD Parts Library" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Too many entry point opens");
  },
};
