/**
 * Composition root for the headless CLI processes (`xum run`, `xum workflow`).
 *
 * Builds the core service graph through the same Layer definitions the desktop
 * `ServiceContainer` uses (`di/layers/core.ts`) and hands back the plain
 * `CoreServices` object the CLI code consumes, plus the runtime handles the
 * CLI's cleanup list must release: `closeScopeBounded(appFiberScope)` before
 * the session is disposed and `disposeAppRuntime(runtime.managed)` as the very
 * last step (see the dispose order in `ServiceContainer` and the DI contract in
 * `di/appRuntime.ts`).
 */
import type { Scope } from "effect";
import type { CoreServices, CoreServicesOptions } from "@/node/services/coreServices";
import { AppFiberScopeTag } from "@/node/services/di/appFiberScope";
import { makeAppRuntime, type AppRuntime } from "@/node/services/di/appRuntime";
import { CoreRootLive, coreServicesFromContext } from "@/node/services/di/layers/core";
import type { CoreRootTags } from "@/node/services/di/tags";
import { installBrotliResponseGuard } from "@/node/utils/network/brotliResponseGuard";

export interface CoreServicesRoot extends CoreServices {
  /** The runtime that owns the graph; composition roots only (DI contract). */
  readonly runtime: AppRuntime<CoreRootTags>;
  /** Supervised fiber scope (`di/appFiberScope.ts`); closed first during cleanup. */
  readonly appFiberScope: Scope.Closeable;
}

/**
 * Synchronous, like every service constructor: a layer body that throws (or
 * suspends) fails here, inside the caller's existing startup error path.
 */
export function createCoreServices(opts: CoreServicesOptions): CoreServicesRoot {
  // These processes run on the user's own Node, which can lack the CVE-2026-111497 fix (#7358).
  // ServiceContainer installs the same guard for desktop, `xum server` and ACP.
  installBrotliResponseGuard();
  const runtime = makeAppRuntime(CoreRootLive(opts));
  return {
    ...coreServicesFromContext(runtime.context),
    runtime,
    appFiberScope: runtime.get(AppFiberScopeTag),
  };
}
