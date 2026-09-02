import * as path from "path";
import { Context, Effect, Layer } from "effect";
import { AnalyticsService } from "@/node/services/analytics/analyticsService";
import { DevToolsService } from "@/node/services/devToolsService";
import {
  Analytics,
  ConfigTag,
  DevTools,
  Experiments,
  Policy,
  SessionTiming,
  Telemetry,
  WorkspaceMcpOverrides,
  type CrossCuttingTags,
} from "@/node/services/di/tags";
import { ExperimentsService } from "@/node/services/experimentsService";
import { PolicyService } from "@/node/services/policyService";
import { SessionTimingService } from "@/node/services/sessionTimingService";
import { TelemetryService } from "@/node/services/telemetryService";
import { WorkspaceMcpOverridesService } from "@/node/services/workspaceMcpOverridesService";
import { CoreOptionsTag } from "./core";

/**
 * Desktop/server-only layers (`ServiceContainer` roots). Only the services the
 * core graph's options derive from live here so far; the remaining desktop
 * constructions stay in the `ServiceContainer` constructor until they get
 * their own group layers.
 */

/**
 * Cross-cutting services, built in the order the `ServiceContainer`
 * constructor used before they moved here. Their constructors only capture
 * arguments; `initialize()` stays with `ServiceContainer.initialize()`.
 */
export const CrossCuttingLive: Layer.Layer<CrossCuttingTags, never, ConfigTag> =
  Layer.effectContext(
    Effect.map(ConfigTag, (config) => {
      const policyService = new PolicyService(config);
      const telemetryService = new TelemetryService(config.rootDir);
      const experimentsService = new ExperimentsService({
        telemetryService,
        xumHome: config.rootDir,
      });
      const sessionTimingService = new SessionTimingService(config, telemetryService);
      const analyticsService = new AnalyticsService(config);
      const devToolsService = new DevToolsService(config);
      // Desktop passes WorkspaceMcpOverridesService explicitly so AIService uses
      // the persistent config rather than creating a default with an ephemeral one.
      const workspaceMcpOverridesService = new WorkspaceMcpOverridesService(config);
      return Context.empty().pipe(
        Context.add(Policy, policyService),
        Context.add(Telemetry, telemetryService),
        Context.add(Experiments, experimentsService),
        Context.add(SessionTiming, sessionTimingService),
        Context.add(Analytics, analyticsService),
        Context.add(DevTools, devToolsService),
        Context.add(WorkspaceMcpOverrides, workspaceMcpOverridesService)
      );
    })
  );

/**
 * The desktop's core graph options: every optional cross-cutting service
 * present. (`MemoryMeta` and `WorkspaceMcpOverrides` are core graph inputs in
 * their own right, read from their tags by the core layers.)
 */
export const CoreOptionsFromDesktopLive: Layer.Layer<
  CoreOptionsTag,
  never,
  ConfigTag | CrossCuttingTags
> = Layer.effect(
  CoreOptionsTag,
  Effect.gen(function* () {
    const config = yield* ConfigTag;
    return {
      extensionMetadataPath: path.join(config.rootDir, "extensionMetadata.json"),
      policyService: yield* Policy,
      telemetryService: yield* Telemetry,
      analyticsService: yield* Analytics,
      experimentsService: yield* Experiments,
      sessionTimingService: yield* SessionTiming,
      devToolsService: yield* DevTools,
    };
  })
);
