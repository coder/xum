import { assert } from "@/common/utils/assert";
import { SingleUseTokenStore } from "@/node/utils/singleUseTokenStore";

export interface BrowserBridgeTokenPayload {
  workspaceId: string;
  sessionName: string;
  streamPort: number;
  allowOtherWorkspaceSession: boolean;
}

interface BrowserBridgeTokenMintOptions {
  allowOtherWorkspaceSession?: boolean;
}

const BROWSER_BRIDGE_TOKEN_TTL_MS = 30_000;

export class BrowserBridgeTokenManager {
  private readonly store = new SingleUseTokenStore<BrowserBridgeTokenPayload>(
    BROWSER_BRIDGE_TOKEN_TTL_MS,
    "BrowserBridgeTokenManager"
  );

  mint(
    workspaceId: string,
    sessionName: string,
    streamPort: number,
    options?: BrowserBridgeTokenMintOptions
  ): string {
    assert(workspaceId.length > 0, "BrowserBridgeTokenManager.mint requires non-empty workspaceId");
    assert(sessionName.length > 0, "BrowserBridgeTokenManager.mint requires non-empty sessionName");
    assert(
      Number.isInteger(streamPort),
      "BrowserBridgeTokenManager.mint requires integer streamPort"
    );
    assert(streamPort > 0, "BrowserBridgeTokenManager.mint requires positive streamPort");

    return this.store.mint({
      workspaceId,
      sessionName,
      streamPort,
      allowOtherWorkspaceSession: options?.allowOtherWorkspaceSession === true,
    });
  }

  validate(token: string): BrowserBridgeTokenPayload | null {
    return this.store.validate(token);
  }

  dispose(): void {
    this.store.dispose();
  }
}
