import React, { useRef, useState } from "react";
import { Scan, Shrink, ZoomIn, ZoomOut } from "lucide-react";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { formatKeybind, KEYBINDS, matchesKeybind, type Keybind } from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.25;

type Zoom = "fit" | number;

const controlClassName =
  "text-muted hover:text-foreground flex h-6 w-6 items-center justify-center rounded disabled:opacity-40 focus-visible:ring-1 focus-visible:ring-accent";

function ZoomButton(props: {
  label: string;
  keybind: Keybind;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <TooltipIfPresent
      tooltip={
        <>
          {props.label}
          <span className="mobile-hide-shortcut-hints"> ({formatKeybind(props.keybind)})</span>
        </>
      }
    >
      <button
        type="button"
        aria-label={props.label}
        aria-pressed={props.pressed}
        disabled={props.disabled}
        onClick={props.onClick}
        className={cn(controlClassName, props.pressed === true && "bg-hover text-foreground")}
      >
        {props.children}
      </button>
    </TooltipIfPresent>
  );
}

/**
 * Image artifact with fit / 100% / zoom controls. The same operations have shortcuts while
 * focus is inside the viewer (a control, or the focusable image viewport).
 */
export function ImageArtifact(props: { src: string; alt: string }) {
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // Scale the image is shown at in fit mode (never upscaled), measured on demand.
  const fitScale = (): number => {
    const viewport = viewportRef.current;
    if (natural == null || viewport == null || natural.width === 0 || natural.height === 0)
      return 1;
    return Math.min(
      1,
      viewport.clientWidth / natural.width,
      viewport.clientHeight / natural.height
    );
  };
  const currentScale = () => (zoom === "fit" ? fitScale() : zoom);
  const zoomBy = (factor: number) => {
    const current = currentScale();
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current * factor));
    // A large image fits below MIN_ZOOM: zooming out must never enlarge it (nor zooming in
    // shrink it), so a step that would cross the clamp the wrong way is a no-op.
    const next = factor < 1 ? Math.min(current, clamped) : Math.max(current, clamped);
    if (next !== current) setZoom(next);
  };
  const canZoomOut = natural != null && (zoom === "fit" || zoom > MIN_ZOOM);
  const canZoomIn = natural != null && (zoom === "fit" || zoom < MAX_ZOOM);
  const zoomOut = () => zoomBy(1 / ZOOM_STEP);
  const zoomIn = () => zoomBy(ZOOM_STEP);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    let action: (() => void) | null = null;
    if (matchesKeybind(e, KEYBINDS.ZOOM_IN_ARTIFACT_IMAGE)) action = canZoomIn ? zoomIn : null;
    else if (matchesKeybind(e, KEYBINDS.ZOOM_OUT_ARTIFACT_IMAGE))
      action = canZoomOut ? zoomOut : null;
    else if (matchesKeybind(e, KEYBINDS.FIT_ARTIFACT_IMAGE)) action = () => setZoom("fit");
    else if (matchesKeybind(e, KEYBINDS.ACTUAL_SIZE_ARTIFACT_IMAGE)) action = () => setZoom(1);
    else return;
    e.preventDefault();
    action?.();
  };

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={handleKeyDown}>
      <div className="border-border-light flex shrink-0 items-center gap-0.5 border-b px-2 py-1">
        <ZoomButton
          label="Fit to panel"
          keybind={KEYBINDS.FIT_ARTIFACT_IMAGE}
          pressed={zoom === "fit"}
          onClick={() => setZoom("fit")}
        >
          <Shrink className="h-3.5 w-3.5" />
        </ZoomButton>
        <ZoomButton
          label="Actual size (100%)"
          keybind={KEYBINDS.ACTUAL_SIZE_ARTIFACT_IMAGE}
          pressed={zoom === 1}
          onClick={() => setZoom(1)}
        >
          <Scan className="h-3.5 w-3.5" />
        </ZoomButton>
        <ZoomButton
          label="Zoom out"
          keybind={KEYBINDS.ZOOM_OUT_ARTIFACT_IMAGE}
          disabled={!canZoomOut}
          onClick={zoomOut}
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </ZoomButton>
        <ZoomButton
          label="Zoom in"
          keybind={KEYBINDS.ZOOM_IN_ARTIFACT_IMAGE}
          disabled={!canZoomIn}
          onClick={zoomIn}
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </ZoomButton>
        <span className="text-muted counter-nums ml-1 text-[11px]">
          {zoom === "fit" ? "Fit" : `${Math.round(zoom * 100)}%`}
          {natural != null && ` · ${natural.width}×${natural.height}`}
        </span>
      </div>
      {/* Focusable so clicking the image moves focus here and the zoom shortcuts apply. */}
      <div
        ref={viewportRef}
        tabIndex={0}
        aria-label="Image viewport"
        className="focus-visible:ring-accent min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-inset"
      >
        <div
          className={cn(
            "flex min-h-full min-w-full p-3",
            zoom === "fit" ? "h-full items-center justify-center" : "w-max items-start"
          )}
        >
          <img
            src={props.src}
            alt={props.alt}
            onLoad={(e) =>
              setNatural({
                width: e.currentTarget.naturalWidth,
                height: e.currentTarget.naturalHeight,
              })
            }
            className={cn(zoom === "fit" && "max-h-full max-w-full object-contain")}
            style={
              zoom !== "fit" && natural != null
                ? { width: natural.width * zoom, height: natural.height * zoom, maxWidth: "none" }
                : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}
