/**
 * Skeleton component for loading placeholders.
 *
 * Supports two variants:
 * - "pulse" (default): Tailwind animate-pulse (simple opacity animation)
 * - "shimmer": GPU-accelerated gradient sweep (Vercel-like effect)
 *
 * Use this to reserve layout space and prevent flashing when async data arrives.
 */

import { cn } from "@/common/lib/utils";

export interface SkeletonProps {
  className?: string;
  /** "pulse" (default) = subtle opacity animation; "shimmer" = gradient sweep */
  variant?: "pulse" | "shimmer";
}

export function Skeleton({ className, variant = "pulse" }: SkeletonProps) {
  if (variant === "shimmer") {
    return (
      <span
        aria-hidden
        // Theme-aware contrast keeps loading blocks visible on light surfaces, too.
        className={cn("relative inline-block overflow-hidden rounded bg-muted/20", className)}
      >
        {/* Shimmer sweep layer using existing shimmer-slide keyframes */}
        <span
          className={cn(
            "pointer-events-none absolute inset-0",
            "bg-[linear-gradient(90deg,transparent,var(--color-white-overlay),transparent)]",
            "animate-[shimmer-slide_1.5s_infinite_linear]"
          )}
        />
      </span>
    );
  }

  // Default: pulse variant
  return (
    <span aria-hidden className={cn("inline-block animate-pulse rounded bg-white/5", className)} />
  );
}
