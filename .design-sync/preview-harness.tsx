// Lightweight provider harness for isolated design-sync previews. Renders a
// single component with the contexts it needs WITHOUT the app shell (AppLoader),
// so previews stay thin (no shiki/mermaid/full-app graph). Providers are shimmed
// to window.Mux (barrel exports them) so they share React-context identity with
// the bundled components; the mock client bundles from source (it's data, not
// identity-sensitive). Owned previews in .design-sync/previews/<Name>.tsx import
// this via a relative path.
//
// Only the providers the design bundle can afford under the 5 MB cap are wired:
// theme, API, experiments, policy, settings, tooltip. The workspace/router/
// project chain is intentionally omitted (it pushes the bundle over cap) — a
// component that hard-requires those contexts is handled in its own preview.
import { useRef, type ReactNode } from "react";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { PolicyProvider } from "@/browser/contexts/PolicyContext";
import { ExperimentsProvider } from "@/browser/contexts/ExperimentsContext";
import { SettingsProvider } from "@/browser/contexts/SettingsContext";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { ProjectProvider } from "@/browser/contexts/ProjectContext";
import { AboutDialogProvider } from "@/browser/contexts/AboutDialogContext";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";

// Mux's globals.css (bundled into the design system's CSS) pins the document to
// the viewport: `html,body,#root,#storybook-root{height:100vh;min-height:100vh}`
// so the Electron app fills its window. Inside an isolated preview that rule is
// actively harmful: the Design System gallery embeds each card in an iframe and
// auto-sizes it from `document.documentElement.scrollHeight`. With the height
// locked to 100vh, that read is clamped to the iframe's (short) initial height
// instead of the real content height — so the card never grows, and everything
// below the fold (i.e. the actual component, which sits under its variant label)
// is clipped. The component only reappears in the full-height Edit view.
//
// Neutralizing the lock lets the body size to its content, so the gallery reads
// the true height and the whole component shows. This is a no-op for fixed-
// overlay previews (modals): their content is out of normal flow and
// `documentElement.scrollHeight` already floors at the viewport height, so the
// card height is unchanged. !important beats globals.css (which sets no
// !important); the #root/#storybook-root selectors don't exist here but mirror
// the source rule for clarity.
const PREVIEW_HEIGHT_RESET = `html,body,#root,#storybook-root{height:auto!important;min-height:0!important}`;

export interface MuxPreviewShellProps {
  /** A configured mock client; defaults to empty mock data. */
  client?: APIClient;
  children: ReactNode;
}

export function MuxPreviewShell(props: MuxPreviewShellProps) {
  const client = useRef(props.client ?? createMockORPCClient({})).current;
  return (
    <>
      <style>{PREVIEW_HEIGHT_RESET}</style>
      <ThemeProvider>
        <APIProvider client={client}>
          <ExperimentsProvider>
            <PolicyProvider>
              <RouterProvider>
                <ProjectProvider>
                  <SettingsProvider>
                    <AboutDialogProvider>
                      <TooltipProvider>{props.children}</TooltipProvider>
                    </AboutDialogProvider>
                  </SettingsProvider>
                </ProjectProvider>
              </RouterProvider>
            </PolicyProvider>
          </ExperimentsProvider>
        </APIProvider>
      </ThemeProvider>
    </>
  );
}
