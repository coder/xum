"use client";

import { cn } from "@/common/lib/utils";
import type { ElementType } from "react";
import { memo } from "react";

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
  colorClass?: string;
}

/**
 * Shimmer text effect using a transformed, masked duplicate of the label.
 *
 * The sweep and its counter-translated text copy animate only `transform`,
 * keeping the glyphs stationary while avoiding the per-frame paint work from
 * animating a gradient's background-position in the streaming transcript.
 */
const ShimmerComponent = ({
  children,
  as: Component = "span",
  className,
  duration = 2,
  colorClass = "var(--color-muted-foreground)",
}: TextShimmerProps) => {
  return (
    <Component
      className={cn("shimmer-text", className)}
      style={
        {
          "--shimmer-duration": `${duration}s`,
          "--shimmer-color": colorClass,
        } as React.CSSProperties
      }
    >
      <span className="shimmer-text-base">{children}</span>
      <span aria-hidden="true" className="shimmer-text-sweep">
        <span className="shimmer-text-sweep-copy">{children}</span>
      </span>
    </Component>
  );
};

export const Shimmer = memo(ShimmerComponent);
