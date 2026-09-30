import React from "react";
import { cn } from "@/common/lib/utils";

interface BaseBarrierProps {
  text: string;
  color: string;
  animate?: boolean;
  className?: string;
  /** When set, the centered label becomes a clickable button (gradient lines stay inert). */
  onClick?: () => void;
  /** Accessible label for the clickable variant (defaults to `text`). */
  ariaLabel?: string;
}

const LABEL_CLASS = "font-mono text-[10px] tracking-wide whitespace-nowrap uppercase";

export const BaseBarrier: React.FC<BaseBarrierProps> = ({
  text,
  color,
  animate = false,
  className,
  onClick,
  ariaLabel,
}) => {
  return (
    <div
      className={cn(
        "flex items-center gap-3 py-2 my-1",
        animate ? "animate-pulse opacity-100" : "opacity-60",
        className
      )}
    >
      <div
        className="h-px flex-1 opacity-30"
        style={{
          background: `linear-gradient(to right, transparent, ${color} 20%, ${color} 80%, transparent)`,
        }}
      />
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          aria-label={ariaLabel ?? text}
          className={cn(
            LABEL_CLASS,
            "m-0 cursor-pointer border-none bg-transparent p-0 leading-none hover:underline"
          )}
          style={{ color }}
        >
          {text}
        </button>
      ) : (
        <div className={LABEL_CLASS} style={{ color }}>
          {text}
        </div>
      )}
      <div
        className="h-px flex-1 opacity-30"
        style={{
          background: `linear-gradient(to right, transparent, ${color} 20%, ${color} 80%, transparent)`,
        }}
      />
    </div>
  );
};
