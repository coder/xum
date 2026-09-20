import type { Meta, StoryObj } from "@storybook/react-vite";
import { waitFor, within } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { isDialogOpen } from "@/browser/utils/ui/keybinds";
import { Button } from "../Button/Button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./Popover.js";

// Popover primitive (Radix-backed floating surface). Rendered with defaultOpen so
// the panel is visible in the capture while staying interactive in Storybook.
const meta: Meta<typeof Popover> = {
  ...lightweightMeta,
  title: "Components/Popover",
  component: Popover,
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="bg-background text-foreground flex min-h-[320px] items-start justify-center p-10">
      <Popover defaultOpen>
        <PopoverTrigger asChild>
          <Button variant="outline">Workspace actions</Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="p-1">
          <div className="flex flex-col">
            <button className="hover:bg-hover rounded px-2.5 py-1.5 text-left text-sm">
              Open in editor
            </button>
            <button className="hover:bg-hover rounded px-2.5 py-1.5 text-left text-sm">
              Duplicate workspace
            </button>
            <button className="text-error hover:bg-hover rounded px-2.5 py-1.5 text-left text-sm">
              Archive
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  ),
  // A non-modal popover also renders role="dialog"; it must NOT count as an open modal, or
  // every global shortcut would go dead while a menu is showing.
  play: async () => {
    const panel = await waitFor(() => within(document.body).getByRole("dialog"));
    if (panel.getAttribute("data-state") !== "open") {
      throw new Error("popover panel must be open for the guard contract to be meaningful");
    }
    if (isDialogOpen()) {
      throw new Error("isDialogOpen() must ignore a non-modal Popover");
    }
  },
};
