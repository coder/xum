import type { Meta, StoryObj } from "@storybook/react-vite";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { Button } from "../Button/Button.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./Tooltip.js";

// Tooltip primitive (Radix-backed). The lightweight story shell already provides
// TooltipProvider. Rendered with defaultOpen so the tooltip surface shows in the
// capture while staying interactive.
const meta: Meta<typeof Tooltip> = {
  ...lightweightMeta,
  title: "Components/Tooltip",
  component: Tooltip,
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="bg-background text-foreground flex min-h-[240px] items-center justify-center p-10">
      <Tooltip defaultOpen>
        <TooltipTrigger asChild>
          <Button variant="outline">Hover me</Button>
        </TooltipTrigger>
        <TooltipContent>Open the command palette (⌘⇧P)</TooltipContent>
      </Tooltip>
    </div>
  ),
};
