/**
 * What the Artifacts panel hands its viewers so an artifact can talk to the host (M5b). Viewers
 * never send anything themselves: `requestSend` only fills the host-owned confirm strip, and the
 * user's click on its Send button is what delivers the message.
 */
export interface ArtifactInteractionHandlers {
  /** Show (or replace) the confirm strip for this artifact. */
  requestSend(text: string, data?: unknown): void;
  /**
   * Persisted `window.xum.state` for the displayed version: undefined while loading, null when
   * nothing is saved. Loaded once per version; the frame owns it after that.
   */
  initialState?: unknown;
  /** Persist `window.xum.setState` for the displayed version (latest wins). */
  setState?(state: unknown): void;
}
