/**
 * Telemetry lifecycle tracking
 *
 * Handles app startup events
 */

import {
  readPersistedRawString,
  readPersistedState,
  updatePersistedState,
} from "@/browser/hooks/usePersistedState";
import { trackEvent } from "@/common/telemetry/client";
import { FIRST_LAUNCH_KEY, VIM_ENABLED_KEY } from "@/common/constants/storage";

/**
 * Check if this is the first app launch
 * Uses localStorage to persist flag across sessions
 */
function checkFirstLaunch(): boolean {
  if (readPersistedRawString(FIRST_LAUNCH_KEY)) {
    return false;
  }

  // First launch - set the flag. JSON true serializes to "true", the raw value older builds wrote.
  updatePersistedState(FIRST_LAUNCH_KEY, true);
  return true;
}

/**
 * Check if vim mode is enabled
 */
function checkVimModeEnabled(): boolean {
  return readPersistedState<unknown>(VIM_ENABLED_KEY, false) === true;
}

/**
 * Track app startup
 * Should be called once when the app initializes
 */
export function trackAppStarted(): void {
  const isFirstLaunch = checkFirstLaunch();
  const vimModeEnabled = checkVimModeEnabled();

  console.debug("[Telemetry] trackAppStarted", { isFirstLaunch, vimModeEnabled });

  trackEvent({
    event: "app_started",
    properties: {
      isFirstLaunch,
      vimModeEnabled,
    },
  });
}
