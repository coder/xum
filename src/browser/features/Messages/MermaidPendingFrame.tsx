import type { CSSProperties } from "react";

// Shared by Mermaid's own pending state and the lazy-load fallback, so both reserve the
// same box and nothing shifts when the Mermaid chunk arrives. Keep `pele` out of this
// module: it is on the first load (T3, #5971).
export const MERMAID_BUTTON_INSET = 8;
export const MERMAID_BUTTON_HEIGHT = 30;

export const MERMAID_FRAME_STYLE: CSSProperties = {
  position: "relative",
  margin: "1em 0",
  background: "var(--color-code-bg)",
  borderRadius: "4px",
  // The top padding holds the zoom buttons, so they never cover the top of a narrow diagram
  // (#7821). The pending frame reserves it too, so the frame keeps its height when the diagram
  // arrives.
  padding: `${MERMAID_BUTTON_INSET * 2 + MERMAID_BUTTON_HEIGHT}px 16px 16px`,
};

export const MERMAID_CONTAINER_STYLE: CSSProperties = {
  minHeight: "300px",
};

export const MERMAID_PENDING_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--color-text-secondary)",
  fontStyle: "italic",
};

export const MERMAID_PENDING_TEXT = "Rendering diagram...";

export function MermaidPendingFrame() {
  return (
    <div style={MERMAID_FRAME_STYLE}>
      <div
        className="mermaid-container"
        style={{ ...MERMAID_CONTAINER_STYLE, ...MERMAID_PENDING_STYLE }}
      >
        {MERMAID_PENDING_TEXT}
      </div>
    </div>
  );
}
