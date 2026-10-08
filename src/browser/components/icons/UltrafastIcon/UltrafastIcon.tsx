import React from "react";
import { cn } from "@/common/lib/utils";

/**
 * Lucide's `zap` path (ISC), unchanged, so Ultrafast shares Fast mode's exact bolt.
 * Keep in sync with lucide-react's zap icon if the Fast indicator ever changes glyph.
 */
const ZAP_PATH =
  "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z";

interface UltrafastIconProps {
  className?: string;
  "aria-label"?: string;
  "data-ultrafast-mode-indicator"?: boolean;
}

/**
 * Fast mode's filled bolt with two speed trails: one bolt in motion, not two bolts.
 * The viewBox extends left of the 24x24 bolt so the bolt renders at the same size as
 * the Fast indicator; width follows the 31:24 aspect ratio from the height class.
 */
export const UltrafastIcon: React.FC<UltrafastIconProps> = (props) => {
  const labelled = props["aria-label"] != null;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="-7 0 31 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={labelled ? "img" : undefined}
      aria-label={props["aria-label"]}
      aria-hidden={labelled ? undefined : true}
      data-ultrafast-mode-indicator={props["data-ultrafast-mode-indicator"]}
      className={cn("aspect-[31/24] h-3 w-auto", props.className)}
    >
      <path d={ZAP_PATH} fill="currentColor" />
      <path d="M-6 8h9.5" />
      <path d="M-4.5 18h11" />
    </svg>
  );
};
