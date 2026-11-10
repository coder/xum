// Shared by the palette and the input its first open shows while the palette chunk loads
// (LazyCommandPalette, #6997), so both paint the same box.
// Dim painted on a pseudo-element so iOS/iPadOS 26 WebKit's status-bar edge sampler ignores
// this fixed overlay (same pattern as Dialog/LeftSidebar).
export const COMMAND_PALETTE_OVERLAY_CLASSES =
  "fixed inset-0 z-[2000] flex items-start justify-center pt-[10vh] before:absolute before:inset-0 before:bg-black/40";
// relative keeps the panel painted above (and hit-tested before) the overlay's absolutely
// positioned ::before backdrop, so clicks land on the palette instead of the dismiss handler.
export const COMMAND_PALETTE_PANEL_CLASSES =
  "font-primary relative w-[min(720px,92vw)] overflow-hidden rounded-lg border border-[var(--color-command-border)] bg-[var(--color-command-surface)] text-[var(--color-command-foreground)] shadow-[0_10px_40px_rgba(0,0,0,0.4)]";
export const COMMAND_PALETTE_INPUT_CLASSES =
  "w-full border-b border-[var(--color-command-input-border)] bg-[var(--color-command-input)] px-3.5 py-3 text-sm text-[var(--color-command-foreground)] outline-none placeholder:text-[var(--color-command-subdued)]";
export const COMMAND_PALETTE_PLACEHOLDER =
  "Switch workspaces or type > for all commands, / for slash commands…";
