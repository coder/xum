import type { CSSProperties } from "react";

// Shared by Mermaid's own pending state and the lazy-load fallback, so both reserve the
// same box and nothing shifts when the Mermaid chunk arrives. Keep `mermaid` out of this
// module: it is on the first load (T3, #5971).
export const MERMAID_FRAME_STYLE: CSSProperties = {
  position: "relative",
  margin: "1em 0",
  background: "var(--color-code-bg)",
  borderRadius: "4px",
  padding: "16px",
};

export const MERMAID_CONTAINER_STYLE: CSSProperties = {
  maxWidth: "70%",
  margin: "0 auto",
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
