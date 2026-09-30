import React from "react";
import { cn } from "@/common/lib/utils";

interface AgentSkillBadgeProps extends React.HTMLAttributes<HTMLElement> {
  as?: "span" | "button";
  type?: React.ButtonHTMLAttributes<HTMLButtonElement>["type"];
}

/** Shared visual badge for slash and inline agent skill references. */
export const AgentSkillBadge = React.forwardRef<HTMLElement, AgentSkillBadgeProps>(
  ({ as = "span", className, children, type, ...rest }, ref) => {
    const classes = cn(
      "font-mono text-[13px] font-medium text-[var(--color-plan-mode-light)]",
      as === "button" &&
        "rounded-sm border-0 bg-transparent p-0 text-left focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none",
      className
    );

    if (as === "button") {
      return (
        <button
          ref={ref as React.Ref<HTMLButtonElement>}
          type={type ?? "button"}
          className={classes}
          data-component="AgentSkillBadge"
          {...rest}
        >
          {children}
        </button>
      );
    }

    return (
      <span
        ref={ref as React.Ref<HTMLSpanElement>}
        className={classes}
        data-component="AgentSkillBadge"
        {...rest}
      >
        {children}
      </span>
    );
  }
);

AgentSkillBadge.displayName = "AgentSkillBadge";
