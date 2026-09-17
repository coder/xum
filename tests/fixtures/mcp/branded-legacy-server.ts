import { NOTION_SVG_ICON, PIXEL_PNG_ICON } from "./branded-icons";
import { runIdentityServer } from "./identity-server";

// Legacy handshake with icons; tool results carry no identity of their own,
// so every call falls back to the connection identity and its artwork.
runIdentityServer("legacy", { connectionIcons: [NOTION_SVG_ICON, PIXEL_PNG_ICON] });
