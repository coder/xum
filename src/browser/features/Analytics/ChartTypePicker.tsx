import type { ComponentType } from "react";
import {
  AreaChart as AreaChartIcon,
  BarChart3,
  LineChart as LineChartIcon,
  PieChart as PieChartIcon,
  Table,
} from "lucide-react";
import { cn } from "@/common/lib/utils";
import type { ChartType } from "../Tools/analyticsQuery/types";

const CHART_TYPE_OPTIONS: Array<{
  value: ChartType;
  icon: ComponentType<{ className?: string }>;
  label: string;
}> = [
  { value: "table", icon: Table, label: "Table" },
  { value: "bar", icon: BarChart3, label: "Bar" },
  { value: "line", icon: LineChartIcon, label: "Line" },
  { value: "area", icon: AreaChartIcon, label: "Area" },
  { value: "pie", icon: PieChartIcon, label: "Pie" },
  { value: "stacked_bar", icon: BarChart3, label: "Stacked" },
];

interface ChartTypePickerProps {
  activeType: ChartType;
  onSelect: (type: ChartType) => void;
}

export function ChartTypePicker(props: ChartTypePickerProps) {
  return (
    // Wraps: six buttons are wider than a phone screen, and a fixed row scrolled the whole page.
    <div className="flex flex-wrap items-center gap-1">
      {CHART_TYPE_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => props.onSelect(option.value)}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium transition-colors",
            props.activeType === option.value
              ? "bg-accent text-accent-foreground"
              : "text-muted hover:bg-accent/50 hover:text-foreground"
          )}
        >
          <option.icon className="size-3" />
          {option.label}
        </button>
      ))}
    </div>
  );
}
