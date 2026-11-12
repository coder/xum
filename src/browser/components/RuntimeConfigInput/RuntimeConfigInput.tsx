import { useId } from "react";

import { cn } from "@/common/lib/utils";
import type { RuntimeOptionFieldSpec } from "@/browser/utils/runtimeUi";

/**
 * Shared runtime option input used by creation and settings screens.
 *
 * Accepts a `fieldSpec` from {@link RUNTIME_OPTION_FIELDS} which bundles the
 * label and placeholder — ensuring both screens render identically by
 * construction.
 */
export function RuntimeConfigInput(props: {
  /** Bundles label and placeholder. The single source of truth. */
  fieldSpec: RuntimeOptionFieldSpec;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  hasError?: boolean;
  id?: string;
  ariaLabel?: string;
  className?: string;
  labelClassName?: string;
  inputClassName?: string;
  /** When true, render label above input instead of beside it. */
  stacked?: boolean;
}) {
  const autoId = useId();
  const inputId = props.id ?? autoId;
  const { label, placeholder } = props.fieldSpec;

  return (
    <div
      className={cn(
        props.stacked ? "flex flex-col gap-1.5" : "flex items-center gap-2",
        props.className
      )}
    >
      <label
        htmlFor={inputId}
        className={cn(
          "text-muted-foreground text-xs",
          props.stacked && "font-medium",
          props.labelClassName
        )}
      >
        {label}
      </label>
      <input
        id={inputId}
        aria-label={props.ariaLabel ?? label}
        type="text"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={placeholder}
        disabled={props.disabled}
        // The environment panel focuses the invalid field when it opens on a refused Send.
        aria-invalid={props.hasError ? true : undefined}
        className={cn(
          "border-border-medium bg-background-secondary text-foreground placeholder:text-muted focus:border-accent h-7 rounded border px-2 text-xs focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          props.inputClassName,
          props.hasError && "border-red-500"
        )}
      />
    </div>
  );
}
