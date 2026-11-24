/**
 * React context for TerminalSessionRouter.
 *
 * Provides centralized terminal session management to all TerminalView components.
 * Must be wrapped inside APIProvider since it depends on the API client.
 */

import { createContext, useContext, useEffect, useState } from "react";
import { useLiveAPI } from "@/browser/contexts/API";
import { TerminalSessionRouter } from "./TerminalSessionRouter";

const TerminalRouterContext = createContext<TerminalSessionRouter | null>(null);

interface TerminalRouterProviderProps {
  children: React.ReactNode;
  /** Set in pop-out terminal windows (terminal-window.tsx) and TerminalDialog. */
  popout?: boolean;
}

/**
 * Provides TerminalSessionRouter to the component tree.
 *
 * One router lives as long as the provider. Each new API client (a reconnect) goes to the same
 * router through setClient(), so open terminals keep their sessions and screens: a router built
 * per client made every TerminalView subscribe again, which cleared the terminal.
 *
 * Always renders children so the app UI stays visible during reconnection.
 */
export function TerminalRouterProvider(props: TerminalRouterProviderProps) {
  // Only the live client: a reconnecting state can keep the old one, and calls on it fail.
  const api = useLiveAPI();
  const [router, setRouter] = useState<TerminalSessionRouter | null>(null);
  const popout = props.popout === true;

  // Create/cleanup after commit to avoid render-time disposal in concurrent mode.
  useEffect(() => {
    const nextRouter = new TerminalSessionRouter(null, { popout });
    setRouter(nextRouter);
    return () => {
      nextRouter.dispose();
    };
  }, [popout]);

  useEffect(() => {
    router?.setClient(api);
  }, [router, api]);

  return (
    <TerminalRouterContext.Provider value={router}>{props.children}</TerminalRouterContext.Provider>
  );
}

/**
 * Hook to access the TerminalSessionRouter.
 *
 * Returns null only before the provider's first commit. Callers should handle the null case.
 *
 * @throws If used outside of TerminalRouterProvider
 */
export function useTerminalRouter(): TerminalSessionRouter | null {
  return useContext(TerminalRouterContext);
}
