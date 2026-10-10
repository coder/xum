import type { ReactNode } from "react";
import { Suspense } from "react";
import { Button } from "../Button/Button";
import { ErrorBoundary } from "../ErrorBoundary/ErrorBoundary";

interface LazyFeatureProps {
  /** Shown in the failure message, e.g. "Loading animation". */
  name: string;
  /** Shown while the feature's chunk loads. Reserve the feature's box to avoid layout shift. */
  fallback?: ReactNode;
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
 * Boundary for a feature code-split with a module-top-level `React.lazy(() => import(...))`
 * (T3, #5971: keep heavy modules off the first load). Keep the open condition outside the lazy
 * module, so a closed feature never fetches its chunk.
 *
 * Why a Reload fallback: in browser mode a tab opened before a server upgrade asks for an old
 * hashed chunk that the server no longer has, so `import()` rejects. `React.lazy` caches the
 * rejection, so ErrorBoundary's "Reset" cannot recover; only a page reload fetches the new entry.
 * Electron loads chunks from its installed files, so it is not expected to hit this.
 */
export function LazyFeature(props: LazyFeatureProps) {
  return (
    <ErrorBoundary workspaceInfo={props.name} fallback={<ReloadFallback name={props.name} />}>
      <Suspense fallback={props.fallback ?? null}>{props.children}</Suspense>
    </ErrorBoundary>
  );
}
