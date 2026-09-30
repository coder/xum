import { Skeleton } from "@/browser/components/Skeleton/Skeleton";

const REVEAL_SKELETON_LINE_WIDTHS: readonly string[] = [
  "w-[72%]",
  "w-[46%]",
  "w-[88%]",
  "w-[61%]",
  "w-[80%]",
  "w-[52%]",
  "w-[70%]",
  "w-[92%]",
  "w-[44%]",
  "w-[83%]",
  "w-[58%]",
  "w-[76%]",
  "w-[49%]",
  "w-[87%]",
  "w-[65%]",
  "w-[79%]",
  "w-[54%]",
  "w-[91%]",
  "w-[68%]",
  "w-[42%]",
  "w-[74%]",
  "w-[85%]",
  "w-[57%]",
  "w-[78%]",
];

export function ImmersiveDiffRevealLoadingState(props: { label: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={props.label}
      data-testid="immersive-diff-reveal-skeleton"
      className="mx-auto flex h-full w-full max-w-5xl flex-col gap-3 overflow-hidden px-4 py-5 select-none"
    >
      {/* Match the transcript hydration shimmer instead of a centered spinner: the
          diff-shaped placeholder keeps the hidden geometry swap feeling like code
          is hydrating in place rather than a blocking modal flash. */}
      <Skeleton variant="shimmer" className="mb-1 block h-3 w-40 rounded" />
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden">
        {REVEAL_SKELETON_LINE_WIDTHS.map((width, rowIndex) => (
          <div key={rowIndex} className="grid grid-cols-[3.5rem_1fr] items-center gap-3">
            <Skeleton variant="shimmer" className="h-2 w-8 rounded" />
            <Skeleton variant="shimmer" className={`${width} h-2 rounded`} />
          </div>
        ))}
      </div>
    </div>
  );
}
