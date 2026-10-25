/**
 * What the Artifacts panel hands its viewers so an artifact can talk to the host (M5b). Viewers
 * never call the API themselves: `requestSend` with origin "click" sends at once (the user's own
 * click or key asked for it, so a second confirm click added nothing), and with origin "ask" it
 * fills the host-owned confirm strip, whose Send button delivers the message.
 */

/**
 * "click": a live user click or key in the artifact sent it, so the host sends at once (a failed
 * send falls back to the strip, with the error). "ask": the confirm strip asks first.
 */
export type ArtifactSendOrigin = "click" | "ask";

export interface ArtifactInteractionHandlers {
  /** Send at once for a click; otherwise show the confirm strip for this artifact. */
  requestSend(text: string, data: unknown, origin: ArtifactSendOrigin): void;
  /**
   * Persisted `window.xum.state` for the displayed version: undefined while loading, null when
   * nothing is saved. Loaded once per version; the frame owns it after that.
   */
  initialState?: unknown;
  /** Persist `window.xum.setState` for the displayed version (latest wins). */
  setState?(state: unknown): void;
}
