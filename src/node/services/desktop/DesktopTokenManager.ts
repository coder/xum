import { DESKTOP_DEFAULTS } from "@/common/constants/desktop";
import { assert } from "@/common/utils/assert";
import { SingleUseTokenStore } from "@/node/utils/singleUseTokenStore";

interface DesktopTokenPayload {
  // Keep the requester even for a shared desktop: the bridge must revalidate its
  // current relationship to the owner, not authorize it as the owner directly.
  workspaceId: string;
  sessionId: string;
  /** The viewer registration the requesting pane holds, so its bridge can be attributed to it. */
  viewerId: string | null;
}

export class DesktopTokenManager {
  private readonly store = new SingleUseTokenStore<DesktopTokenPayload>(
    DESKTOP_DEFAULTS.TOKEN_TTL_MS,
    "DesktopTokenManager"
  );

  /**
   * Mint a new single-use token binding a workspace to a session.
   */
  mint(workspaceId: string, sessionId: string, viewerId: string | null = null): string {
    assert(workspaceId.length > 0, "DesktopTokenManager.mint requires non-empty workspaceId");
    assert(sessionId.length > 0, "DesktopTokenManager.mint requires non-empty sessionId");
    assert(viewerId !== "", "DesktopTokenManager.mint requires a non-empty viewerId or null");

    return this.store.mint({ workspaceId, sessionId, viewerId });
  }

  /**
   * Validate and consume a token. Returns the bound workspace/session info or
   * null if the token is invalid, expired, or already consumed.
   */
  validate(token: string): DesktopTokenPayload | null {
    return this.store.validate(token);
  }

  /** Stop the cleanup timer and clear all minted tokens. */
  dispose(): void {
    this.store.dispose();
  }
}
