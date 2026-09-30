const INACTIVE_ANIMATIONS_ATTRIBUTE = "data-renderer-inactive";

function syncInactiveAnimationState(): void {
  const inactive = document.hidden || !document.hasFocus();
  document.documentElement.toggleAttribute(INACTIVE_ANIMATIONS_ATTRIBUTE, inactive);
}

/**
 * Pause continuous renderer animations while mux is hidden or unfocused.
 * Chromium does not throttle an unfocused but still-visible Electron window,
 * so leaving these running wastes CPU for background workspaces.
 */
export function installInactiveAnimationPause(): () => void {
  syncInactiveAnimationState();

  document.addEventListener("visibilitychange", syncInactiveAnimationState);
  window.addEventListener("focus", syncInactiveAnimationState);
  window.addEventListener("blur", syncInactiveAnimationState);

  return () => {
    document.removeEventListener("visibilitychange", syncInactiveAnimationState);
    window.removeEventListener("focus", syncInactiveAnimationState);
    window.removeEventListener("blur", syncInactiveAnimationState);
  };
}
