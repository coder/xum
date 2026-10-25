import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";

import { cn } from "@/common/lib/utils";

// NOTE: `border-primary` / `bg-primary` / `ring-ring` are not real theme tokens
// in this app (see src/browser/styles/globals.css). We use the defined
// `accent` / `foreground` tokens instead so the checkbox actually renders a
// visible border at rest and a filled accent surface when checked, across all
// themes (dark, light, Flexoki).
const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  // The Radix button is a transparent hit area and the inner span draws the box. On touch
  // phones globals.css gives every button a 44px minimum; drawing the box on the button made
  // it a 44px square off its label's line (#5835). Now the button grows and the box keeps its
  // size, centered in the hit area. Inside a label or a clickable row, globals.css drops the
  // button's minimum and raises the row to 44px instead, so the box stays on the label's line.
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer group/checkbox inline-flex shrink-0 items-center justify-center rounded-[5px] focus-visible:outline-none",
      "disabled:cursor-not-allowed disabled:opacity-50",
      className
    )}
    {...props}
  >
    <span
      aria-hidden="true"
      className={cn(
        // Sizing & shape: slightly larger than 4x4 so the check is comfortably readable.
        "flex size-[1.05rem] items-center justify-center rounded-[5px] transition-colors",
        // Unchecked: visible-but-restrained border with a faint surface, so the
        // affordance reads against any row background (white/5 hover tints,
        // accent/10 selected row tints, etc.).
        "border-foreground/35 bg-foreground/[0.04] border",
        "group-hover/checkbox:border-foreground/55 group-hover/checkbox:bg-foreground/10",
        // Focus ring uses accent (matches the rest of the form).
        "group-focus-visible/checkbox:border-accent group-focus-visible/checkbox:ring-accent/40 group-focus-visible/checkbox:ring-2",
        // Checked: filled accent surface with high-contrast check glyph.
        "group-data-[state=checked]/checkbox:border-accent group-data-[state=checked]/checkbox:bg-accent group-data-[state=checked]/checkbox:text-accent-foreground",
        "group-data-[state=checked]/checkbox:group-hover/checkbox:border-accent-hover group-data-[state=checked]/checkbox:group-hover/checkbox:bg-accent-hover"
      )}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        <Check className="h-3 w-3" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </span>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
