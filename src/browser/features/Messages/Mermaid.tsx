import type { CSSProperties, ReactNode } from "react";
import React, { useContext, useEffect, useId, useRef, useState } from "react";
import { render as renderPele } from "pele";
import { StreamingContext } from "./StreamingContext";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { isDesktopViewportFocused } from "@/browser/utils/ui/keybinds";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { transcriptMermaidSources } from "@/browser/utils/messages/transcriptQuoteAttributes";
import { MERMAID_DIAGRAM_ZOOM_KEY } from "@/common/constants/storage";
import {
  MERMAID_CONTAINER_STYLE,
  MERMAID_FRAME_STYLE,
  MERMAID_PENDING_STYLE,
  MERMAID_PENDING_TEXT,
} from "./MermaidPendingFrame";

const DEFAULT_ZOOM = 1;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;

function decodeNumericCodePoint(codePoint: number): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    // Treat invalid numeric entities as empty content to avoid parser crashes
    // and collapse obfuscated scheme separators.
    return "";
  }

  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}

function decodeEntity(entityBody: string): string | null {
  if (entityBody.startsWith("#x") || entityBody.startsWith("#X")) {
    const parsed = Number.parseInt(entityBody.slice(2), 16);
    return Number.isNaN(parsed) ? "" : decodeNumericCodePoint(parsed);
  }

  if (entityBody.startsWith("#")) {
    const parsed = Number.parseInt(entityBody.slice(1), 10);
    return Number.isNaN(parsed) ? "" : decodeNumericCodePoint(parsed);
  }

  const named: Record<string, string> = {
    tab: "\t",
    newline: "\n",
    colon: ":",
    nbsp: " ",
  };

  return named[entityBody.toLowerCase()] ?? null;
}

function canonicalizeUrlForSchemeCheck(value: string): string {
  // Normalize encoded and obfuscated schemes before comparison so payloads like
  // java&#10;script:, java%0Ascript:, or java\nscript: reduce to javascript:.
  let normalized = value.toLowerCase();

  normalized = normalized.replace(/&([^;\s]+);?/g, (fullMatch, entityBody: string) => {
    return decodeEntity(entityBody) ?? fullMatch;
  });

  normalized = normalized.replace(/%([0-9a-f]{2})/gi, (fullMatch, hex: string) => {
    const parsed = Number.parseInt(hex, 16);
    return Number.isNaN(parsed) ? fullMatch : String.fromCodePoint(parsed);
  });

  let canonical = "";
  for (const char of normalized) {
    const charCode = char.charCodeAt(0);
    const isAsciiControl = charCode <= 0x1f || charCode === 0x7f;
    // The HTML parser turns an invalid numeric reference (java&#1114112;script:) into U+FFFD
    // before this check sees the value. Drop it like the other separators, so the check fails
    // closed and never depends on how a parser decodes such a reference.
    const isReplacementChar = charCode === 0xfffd;
    if (isAsciiControl || isReplacementChar || /\s/.test(char)) {
      continue;
    }

    canonical += char;
  }

  return canonical;
}

export function sanitizeMermaidSvg(svg: string): string | null {
  // Pele emits well-formed SVG with no foreignObject, so anything that fails a strict
  // parse is not its output: fail closed.
  const xmlDoc = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (xmlDoc.querySelector("parsererror") !== null) {
    return null;
  }
  const svgRoot = xmlDoc.documentElement;
  if (svgRoot.tagName.toLowerCase() !== "svg") {
    return null;
  }

  // Defense in depth: remove active content containers and sanitize remaining attributes.
  svgRoot.querySelectorAll("script,iframe,object,embed,foreignObject").forEach((node) => {
    node.remove();
  });

  const urlAttributes = new Set(["href", "xlink:href", "src", "action", "formaction"]);
  const blockedSchemes = ["javascript:", "vbscript:", "data:text/html"];

  const elementsToScan: Element[] = [svgRoot, ...Array.from(svgRoot.querySelectorAll("*"))];
  elementsToScan.forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const attributeName = attribute.name.toLowerCase();
      const canonicalUrlValue = canonicalizeUrlForSchemeCheck(attribute.value.trim());

      if (attributeName.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (
        urlAttributes.has(attributeName) &&
        blockedSchemes.some((scheme) => canonicalUrlValue.startsWith(scheme))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  });

  return svgRoot.outerHTML;
}

function normalizeDiagramZoom(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_ZOOM;
  }

  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}

// Common button styles
const getButtonStyle = (disabled = false): CSSProperties => ({
  background: disabled ? "rgba(255, 255, 255, 0.05)" : "rgba(255, 255, 255, 0.1)",
  border: "1px solid rgba(255, 255, 255, 0.2)",
  color: disabled ? "var(--color-text-secondary)" : "var(--color-text)",
  padding: "6px 10px",
  cursor: disabled ? "not-allowed" : "pointer",
  borderRadius: "4px",
  fontSize: "16px",
  lineHeight: 1,
  opacity: disabled ? 0.5 : 1,
});

// Modal component for fullscreen diagram view
const DiagramModal: React.FC<{ children: ReactNode; onClose: () => void }> = ({
  children,
  onClose,
}) => {
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (isDesktopViewportFocused(e.target)) return;
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handleEscape, { capture: true });
    return () => window.removeEventListener("keydown", handleEscape, { capture: true });
  }, [onClose]);

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0, 0, 0, 0.9)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px",
      }}
      onClick={onClose}
    >
      <div
        style={{
          position: "relative",
          maxWidth: "90%",
          maxHeight: "90%",
          overflow: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
        <button
          onClick={onClose}
          style={{
            position: "absolute",
            top: "16px",
            right: "16px",
            background: "rgba(255, 255, 255, 0.1)",
            border: "1px solid rgba(255, 255, 255, 0.2)",
            color: "var(--color-text)",
            padding: "8px 16px",
            cursor: "pointer",
            borderRadius: "4px",
            fontSize: "14px",
            fontFamily: "var(--font-primary)",
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
};

// Mermaid diagram component
export const Mermaid: React.FC<{ chart: string }> = ({ chart }) => {
  const { isStreaming } = useContext(StreamingContext);
  const modalContainerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  // Keep the source and SVG together while a newer chart is pending or invalid.
  const [renderedDiagram, setRenderedDiagram] = useState<{ svg: string; chart: string } | null>(
    null
  );
  const svg = renderedDiagram?.svg ?? "";
  const stableId = useId();

  // Debounce chart changes to avoid flickering during streaming
  const [debouncedChart, setDebouncedChart] = useState(chart);
  useEffect(() => {
    // Clear stale errors when chart changes - avoids error flash at end of stream
    setError(null);
    const timer = setTimeout(() => setDebouncedChart(chart), 350);
    return () => clearTimeout(timer);
  }, [chart]);

  const [storedDiagramZoom, setStoredDiagramZoom] = usePersistedState(
    MERMAID_DIAGRAM_ZOOM_KEY,
    DEFAULT_ZOOM,
    { listener: true }
  );
  // The +/- controls are shown as zoom affordances, so scale the rendered SVG
  // itself; changing only max-height is a no-op for diagrams already below the cap.
  const diagramZoom = normalizeDiagramZoom(storedDiagramZoom);
  const atMinZoom = diagramZoom <= MIN_ZOOM;
  const atMaxZoom = diagramZoom >= MAX_ZOOM;

  const handleZoomIn = () => {
    if (!atMaxZoom) {
      setStoredDiagramZoom((prev) => normalizeDiagramZoom(normalizeDiagramZoom(prev) + ZOOM_STEP));
    }
  };

  const handleZoomOut = () => {
    if (!atMinZoom) {
      setStoredDiagramZoom((prev) => normalizeDiagramZoom(normalizeDiagramZoom(prev) - ZOOM_STEP));
    }
  };

  useEffect(() => {
    // Each diagram needs its own prefix: inline SVG ids (markers, clip paths) share the document.
    const idPrefix = `mermaid-${stableId.replace(/[^A-Za-z0-9_-]/g, "")}`;
    let cancelled = false;

    const renderDiagram = async () => {
      try {
        // Pele measures labels with canvas when it renders, so the font must be loaded first
        // or boxes are sized for the fallback font. happy-dom has no document.fonts.
        if ("fonts" in document) await document.fonts.ready;
        if (cancelled) return;

        const rootStyle = window.getComputedStyle(document.documentElement);
        const { svg: renderedSvg } = renderPele(debouncedChart, {
          idPrefix,
          // Measure with the same fonts the .mermaid-container CSS draws with.
          fontFamily: rootStyle.getPropertyValue("--font-primary").trim() || undefined,
          fontFamilyMono: rootStyle.getPropertyValue("--font-monospace").trim() || undefined,
          fontSize: 14,
          // Diagram text is untrusted model output: no clickable links, and no images,
          // which would fetch from the network as soon as the SVG is inserted.
          links: false,
          images: false,
        });

        const sanitizedSvg = sanitizeMermaidSvg(renderedSvg);
        if (!sanitizedSvg) {
          throw new Error("Diagram renderer returned invalid SVG output");
        }

        setRenderedDiagram({ svg: sanitizedSvg, chart: debouncedChart });
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to render diagram");
        // Don't clear SVG - keep showing last valid render during errors
      }
    };

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [debouncedChart, stableId]);

  // Update modal container when opened
  useEffect(() => {
    if (isModalOpen && modalContainerRef.current && svg) {
      // SECURITY AUDIT: svg state only stores sanitizeMermaidSvg() output.
      modalContainerRef.current.innerHTML = svg;
    }
  }, [isModalOpen, svg]);

  if (error && !isStreaming) {
    return (
      <pre
        style={{
          color: "var(--color-syntax-error)",
          background: "hsl(from var(--color-syntax-error) h s l / 0.1)",
          padding: "12px",
        }}
      >
        Mermaid Error: {error}
      </pre>
    );
  }

  // Keep one stable diagram frame while streaming or while the async Mermaid render is pending.
  // When no SVG has rendered yet, reserve the normal minimum diagram height so the transcript
  // doesn't expand from a short placeholder to a full diagram after debounce/parse/render.
  const displaySvg = svg;
  const showPendingPlaceholder = !displaySvg;

  return (
    <>
      <div style={MERMAID_FRAME_STYLE}>
        <div
          style={{
            position: "absolute",
            top: "8px",
            right: "8px",
            display: "flex",
            gap: "4px",
          }}
        >
          <TooltipIfPresent tooltip="Zoom out diagram" side="bottom">
            <button onClick={handleZoomOut} disabled={atMinZoom} style={getButtonStyle(atMinZoom)}>
              −
            </button>
          </TooltipIfPresent>
          <TooltipIfPresent tooltip="Zoom in diagram" side="bottom">
            <button onClick={handleZoomIn} disabled={atMaxZoom} style={getButtonStyle(atMaxZoom)}>
              +
            </button>
          </TooltipIfPresent>
          <TooltipIfPresent tooltip="Expand diagram" side="bottom">
            <button onClick={() => setIsModalOpen(true)} style={getButtonStyle()}>
              ⤢
            </button>
          </TooltipIfPresent>
        </div>
        <div
          className="mermaid-container"
          ref={(element) => {
            if (!element) return;
            if (renderedDiagram) transcriptMermaidSources.set(element, renderedDiagram.chart);
            else transcriptMermaidSources.delete(element);
          }}
          style={{
            ...MERMAID_CONTAINER_STYLE,
            ["--diagram-zoom" as string]: `${diagramZoom}`,
            ...(showPendingPlaceholder ? MERMAID_PENDING_STYLE : {}),
          }}
          // SECURITY AUDIT: displaySvg is produced by sanitizeMermaidSvg(), which strips
          // active SVG/HTML content before insertion. React children are used for the
          // pending placeholder so untrusted chart text is never rendered as HTML.
          {...(!showPendingPlaceholder ? { dangerouslySetInnerHTML: { __html: displaySvg } } : {})}
        >
          {showPendingPlaceholder ? MERMAID_PENDING_TEXT : null}
        </div>
      </div>
      {isModalOpen && (
        <DiagramModal onClose={() => setIsModalOpen(false)}>
          <div
            ref={modalContainerRef}
            className="mermaid-container mermaid-modal"
            style={{
              background: "var(--color-code-bg)",
              padding: "24px",
              borderRadius: "8px",
              minWidth: "80vw",
              minHeight: "60vh",
            }}
          />
        </DiagramModal>
      )}
    </>
  );
};
