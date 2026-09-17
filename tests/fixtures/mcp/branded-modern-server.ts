import { NOTION_SVG_ICON, PIXEL_PNG_ICON } from "./branded-icons";
import { runIdentityServer } from "./identity-server";

// Modern handshake with one icon; each tool result names a different identity
// with its own icon, so response artwork must replace the connection's.
runIdentityServer("modern", {
  connectionIcons: [NOTION_SVG_ICON],
  responseIcons: [PIXEL_PNG_ICON],
});
