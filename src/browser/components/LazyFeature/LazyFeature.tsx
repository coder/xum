import type { ReactNode } from "react";
import { Children, isValidElement, Suspense, useEffect } from "react";
import { liveClientOf, useOptionalAPI } from "@/browser/contexts/API";
import { Button } from "../Button/Button";
import { ErrorBoundary } from "../ErrorBoundary/ErrorBoundary";

interface LazyFeatureProps {
  /** Shown in the failure message, e.g. "Loading animation". */
  name: string;
  /** Shown while the feature's chunk loads. Reserve the feature's box to avoid layout shift. */
  fallback?: ReactNode;
  /**
   * Wraps the loading and the failure fallback. For a page-level boundary: the loaded page holds
   * the one `main` landmark, so these states must hold it too (#6017, #6025).
   */
  frame?: (state: ReactNode, kind: "loading" | "failed") => ReactNode;
  children: ReactNode;
}

function ReloadFallback(props: { name: string }) {
  return (
    <div role="alert" className="text-secondary flex items-center gap-2 text-xs">
      <span>{props.name} failed to load.</span>
      <Button variant="outline" size="xs" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  );
}

/**
 * The child component types that rendered in this page. A rendered lazy type has its chunk, so it
 * needs no server to render again (#6380).
 */
const renderedTypes = new WeakSet<object>();

/** The component types of the direct child elements (host elements have string types). */
function childTypes(children: ReactNode): object[] {
  return Children.toArray(children).flatMap((child) =>
    isValidElement(child) && typeof child.type !== "string" ? [child.type] : []
  );
}

/** Records the types once they commit: Suspense commits its children only after they load. */
function MarkRendered(props: { types: object[] }) {
  useEffect(() => {
    for (const type of props.types) renderedTypes.add(type);
  });
  return null;
}

/**
 * Renders the children, or `loading` while Xum reconnects if one of their types never rendered
 * (see LazyFeature). No APIProvider (isolated renders) counts as online.
 */
function OfflineGate(props: { loading: ReactNode; children: ReactNode }) {
  const api = useOptionalAPI();
  const online = api == null || liveClientOf(api) != null;
  const types = childTypes(props.children);
  if (!online && !types.every((type) => renderedTypes.has(type))) return props.loading;
  return (
    <>
      {props.children}
      <MarkRendered types={types} />
    </>
  );
}

/**
 * Boundary for a feature code-split with a module-top-level `React.lazy(() => import(...))`
 * (T3, #5971: keep heavy modules off the first load). Keep the open condition outside the lazy
 * module, so a closed feature never fetches its chunk.
 *
 * Why a Reload fallback: in browser mode a tab opened before a server upgrade asks for an old
 * hashed chunk that the server no longer has, so `import()` rejects. `React.lazy` caches the
 * rejection, so ErrorBoundary's "Reset" cannot recover; only a page reload fetches the new entry.
 * Electron loads chunks from its installed files, so it is not expected to hit this.
 *
 * While Xum reconnects (#6380), a feature that never rendered shows its loading state and loads
 * once the connection is back. A chunk import started offline fails, and both React.lazy and the
 * browser keep that failure, so it would stay "failed to load" after the reconnect. A feature that
 * rendered before has its chunk, so it stays open and opens again offline.
 */
export function LazyFeature(props: LazyFeatureProps) {
  const frame = props.frame ?? ((state: ReactNode) => state);
  const loading = frame(props.fallback ?? null, "loading");
  return (
    <ErrorBoundary
      workspaceInfo={props.name}
      fallback={frame(<ReloadFallback name={props.name} />, "failed")}
    >
      <Suspense fallback={loading}>
        <OfflineGate loading={loading}>{props.children}</OfflineGate>
      </Suspense>
    </ErrorBoundary>
  );
}
