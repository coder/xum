import React, { useState } from "react";
import { LazyFeature } from "@/browser/components/LazyFeature/LazyFeature";
import { useCommandRegistry } from "@/browser/contexts/CommandRegistryContext";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { resolveSlashCommandExperimentValue } from "@/browser/utils/slashCommands/experimentVisibility";
import { getSlashCommandSuggestions } from "@/browser/utils/slashCommands/suggestions";
import {
  COMMAND_PALETTE_INPUT_CLASSES,
  COMMAND_PALETTE_OVERLAY_CLASSES,
  COMMAND_PALETTE_PANEL_CLASSES,
  COMMAND_PALETTE_PLACEHOLDER,
} from "./commandPaletteChrome";

// #6997: the palette and cmdk load on the first open, off main.js. #6996 pushed main.js over a
// Lighthouse simulated round trip (+41 ms desktop LCP), and this cut moves it back under it.
// #6997: the palette shares this slash-command code with the composer. Held by this eager
// module, it stays in main.js. Otherwise Vite splits it into its own chunk: one more request in
// the transcript's second wave (+37 ms Lighthouse LCP on the VM). An object, not a re-export:
// Rollup traces a re-export to its source module and splits the chunk anyway.
export const paletteSlashCommands = {
  getSlashCommandSuggestions,
  resolveSlashCommandExperimentValue,
};

let paletteLoaded = false;
const CommandPalette = React.lazy(() =>
  import("./CommandPalette").then((module) => {
    paletteLoaded = true;
    return { default: module.CommandPalette };
  })
);

/**
 * The palette's box with a plain input while the chunk loads. Typed text goes to the registry
 * query, so the loaded palette opens with every key the user pressed right after the shortcut.
 */
function LoadingPaletteInput(props: { openOrigin: HTMLElement | null }) {
  const { isOpen, initialQuery, open, close } = useCommandRegistry();
  if (!isOpen) return null;
  const dismiss = () => {
    close();
    props.openOrigin?.focus();
  };
  return (
    <div className={COMMAND_PALETTE_OVERLAY_CLASSES} onMouseDown={dismiss}>
      {/* cmdk-root: isCommandPaletteTarget() then keeps focus-moving shortcuts (Ctrl+I) out. */}
      <div
        {...{ "cmdk-root": "" }}
        className={COMMAND_PALETTE_PANEL_CLASSES}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          className={COMMAND_PALETTE_INPUT_CLASSES}
          value={initialQuery}
          onChange={(e) => open(e.target.value)}
          placeholder={COMMAND_PALETTE_PLACEHOLDER}
          aria-label="Command palette"
          autoFocus
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            stopKeyboardPropagation(e);
            dismiss();
          }}
        />
      </div>
    </div>
  );
}

export function LazyCommandPalette(props: { getSlashContext?: () => { workspaceId?: string } }) {
  const { isOpen } = useCommandRegistry();
  // undefined until the first open. The palette stays mounted after it, so later opens are
  // synchronous and capture their own focus origin.
  const [openOrigin, setOpenOrigin] = useState<HTMLElement | null | undefined>(undefined);
  if (isOpen && openOrigin === undefined) {
    // Captured during render, before the loading input's autoFocus moves focus.
    setOpenOrigin(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  } else if (!isOpen && openOrigin !== undefined && !paletteLoaded) {
    // Closed before the chunk arrived: the next open captures its own origin.
    setOpenOrigin(undefined);
  }
  if (openOrigin === undefined) return null;
  return (
    <LazyFeature name="Command palette" fallback={<LoadingPaletteInput openOrigin={openOrigin} />}>
      <CommandPalette getSlashContext={props.getSlashContext} openOrigin={openOrigin} />
    </LazyFeature>
  );
}
