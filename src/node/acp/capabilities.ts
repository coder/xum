import type { ClientCapabilities } from "@agentclientprotocol/sdk";

export interface NegotiatedCapabilities {
  editorSupportsFsRead: boolean;
  editorSupportsFsWrite: boolean;
  editorSupportsTerminal: boolean;
}

export function negotiateCapabilities(
  clientCaps: ClientCapabilities | undefined
): NegotiatedCapabilities {
  return {
    editorSupportsFsRead: clientCaps?.fs?.readTextFile ?? false,
    editorSupportsFsWrite: clientCaps?.fs?.writeTextFile ?? false,
    // The ACP SDK models terminal support as an optional boolean capability.
    editorSupportsTerminal: clientCaps?.terminal === true,
  };
}
