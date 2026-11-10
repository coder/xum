import React from "react";

/**
 * Recharts `<Legend formatter>`: the label text in the foreground color. By default Recharts
 * colors each label with its series color, and several series colors are below WCAG AA as text
 * in every theme (#6885). The legend swatch keeps the series color.
 */
export function renderLegendLabel(value: string): React.ReactNode {
  return <span className="text-foreground">{value}</span>;
}
