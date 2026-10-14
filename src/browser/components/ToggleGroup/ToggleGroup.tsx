import { cn } from "@/common/lib/utils";

export interface ToggleOption<T extends string> {
  value: T;
  label: string;
  activeClassName?: string;
}

interface ToggleGroupProps<T extends string> {
  options: Array<ToggleOption<T>>;
  value: T;
  onChange: (value: T) => void;
  compact?: boolean; // If true, show only active option as clickable badge
  /** `aria-keyshortcuts` for every option button, when a shortcut switches between them. */
  keyShortcuts?: string;
}

export function ToggleGroup<T extends string>({
  options,
  value,
  onChange,
  compact = false,
  keyShortcuts,
}: ToggleGroupProps<T>) {
  // Compact mode: show only active option, click cycles to next option
  if (compact) {
    const currentIndex = options.findIndex((opt) => opt.value === value);
    const activeOption = options[currentIndex];
    const nextOption = options[(currentIndex + 1) % options.length];

    return (
      <button
        onClick={() => onChange(nextOption.value)}
        type="button"
        className={cn(
          "px-1.5 py-0.5 text-[11px] font-sans rounded-sm border-none cursor-pointer transition-all duration-150",
          "text-toggle-text-active bg-toggle-active font-medium",
          activeOption?.activeClassName
        )}
        aria-label={`${activeOption.label} mode. Click to switch to ${nextOption.label}.`}
        aria-keyshortcuts={keyShortcuts}
      >
        {activeOption.label}
      </button>
    );
  }

  return (
    <div className="bg-toggle-bg flex gap-0 rounded">
      {options.map((option) => {
        const isActive = value === option.value;
        return (
          <button
            key={option.value}
            onClick={() => onChange(option.value)}
            aria-pressed={isActive}
            aria-keyshortcuts={keyShortcuts}
            type="button"
            className={cn(
              "px-1.5 py-0.5 text-[11px] font-sans rounded-sm border-none cursor-pointer transition-all duration-150 bg-transparent",
              isActive
                ? "text-toggle-text-active bg-toggle-active font-medium"
                : "text-toggle-text font-normal hover:text-toggle-text-hover hover:bg-toggle-hover",
              isActive && option.activeClassName
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
